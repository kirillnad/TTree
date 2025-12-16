from __future__ import annotations

import os
import mimetypes
import logging
from datetime import datetime, timedelta
from pathlib import Path, PurePath
from typing import Any
from uuid import uuid4
from io import BytesIO
import base64
import binascii
import json
import html as html_mod
import re
import zipfile
from pathlib import PurePosixPath
import urllib.parse
import urllib.request
import urllib.error

import aiofiles
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    UploadFile,
    Request,
    Response,
    Query,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .auth import (
    User,
    clear_session_cookie,
    create_session,
    create_user,
    ensure_superuser,
    get_current_user,
    get_user_by_id,
    get_user_by_username,
    set_session_cookie,
    verify_password,
)
from .db import CONN
from . import db as db_module
from .data_store import (
    ArticleNotFound,
    BlockNotFound,
    InvalidOperation,
    create_article,
    delete_block,
    delete_article,
    ensure_sample_article,
    ensure_inbox_article,
    get_or_create_user_inbox,
    indent_block,
    insert_block,
    move_block,
    move_block_to_parent,
    outdent_block,
    redo_block_text_change,
    restore_article,
    restore_block,
    restore_block_from_trash,
    search_blocks,
    search_everything,
    move_block_to_article,
    undo_block_text_change,
    update_article_meta,
    update_block,
    update_block_collapse,
    get_articles,
    get_deleted_articles,
    get_article,
    create_attachment,
    save_article,
    rebuild_search_indexes,
    build_postgres_ts_query,
    delete_user_with_data,
    _expand_wikilinks,
    build_article_from_row,
    delete_block_permanent,
    clear_block_trash,
    upsert_yandex_tokens,
    get_yandex_tokens,
    move_article as move_article_ds,
    indent_article as indent_article_ds,
    outdent_article as outdent_article_ds,
    move_article_to_parent,
)
from .routers.common import _present_article, _resolve_article_id_for_user
from .routers import auth as auth_routes
from .routers import articles as articles_routes
from .routers import blocks as blocks_routes
from .routers import public as public_routes
from .routers import uploads as uploads_routes
from .routers import export as export_routes
from .routers import graph as graph_routes
from .routers import users as users_routes
from .routers import search as search_routes
from .routers import misc as misc_routes
from .routers import oauth as oauth_routes
from .routers import yandex_disk as yandex_disk_routes
from .routers import telegram as telegram_routes
from .public_render import _render_public_block
from .onboarding import ensure_help_article_for_user
from .import_assets import (
    _decode_data_url,
    _import_attachment_from_bytes,
    _import_attachment_from_data_url,
    _import_image_from_data_url,
    _save_image_bytes_for_user,
)
from .import_utils import _parse_markdown_blocks, _walk_blocks
from .routers import import_markdown as import_markdown_routes
from .routers import import_html as import_html_routes
from .routers import import_logseq as import_logseq_routes
from .import_html import _parse_memus_export_payload, _process_block_html_for_import

BASE_DIR = Path(__file__).resolve().parents[2]
CLIENT_DIR = BASE_DIR / "client"
UPLOADS_DIR = BASE_DIR / 'uploads'
UPLOADS_DIR.mkdir(exist_ok=True, parents=True)
ALLOWED_ATTACHMENT_TYPES = {
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'text/html',
    'application/rtf',
}

logger = logging.getLogger('uvicorn.error')

YANDEX_DISK_APP_ROOT = os.environ.get('YANDEX_DISK_APP_ROOT') or 'app:/'
USERS_PANEL_PASSWORD = os.environ.get('USERS_PANEL_PASSWORD') or 'zZ141400'

ensure_sample_article()
ensure_inbox_article()
# Полная перестройка поисковых индексов может занимать много времени
# на больших базах и замедлять запуск сервера, поэтому по умолчанию
# она отключена. При необходимости её можно включить через
# переменную окружения SERVPY_REBUILD_INDEXES_ON_STARTUP=1.
if os.environ.get('SERVPY_REBUILD_INDEXES_ON_STARTUP') == '1':
    rebuild_search_indexes()
# Гарантируем наличие суперпользователя kirill.
ensure_superuser('kirill', 'zZ141400', 'kirill')
try:
    admin_user = get_user_by_username('kirill')
    if admin_user:
        ensure_help_article_for_user(admin_user.id)
except Exception as exc:  # noqa: BLE001
    logger.error('Failed to ensure help article for superuser kirill: %r', exc)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.middleware('http')
async def disable_client_caching(request: Request, call_next):
    """
    Отключаем кэширование клиентских HTML/CSS/JS в браузере.
    Это особенно важно для мобильных PWA, чтобы правки фронтенда
    подтягивались сразу после обычного перезагруза страницы.
    """
    response: Response = await call_next(request)
    path = request.url.path or ''
    # Для статики и SPA-страниц отключаем кэш.
    if request.method == 'GET' and not path.startswith('/uploads'):
        content_type = (response.headers.get('content-type') or '').lower()
        is_html = content_type.startswith('text/html')
        is_css = content_type.startswith('text/css')
        is_js = (
            content_type.startswith('application/javascript')
            or content_type.startswith('text/javascript')
        )
        if is_html or is_css or is_js:
            response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
            response.headers['Pragma'] = 'no-cache'
            response.headers['Expires'] = '0'
    return response


# Роуты вынесены из app/main.py → app/routers/*
app.include_router(auth_routes.router)
app.include_router(articles_routes.router)
app.include_router(blocks_routes.router)
app.include_router(public_routes.router)
app.include_router(uploads_routes.router)
app.include_router(export_routes.router)
app.include_router(graph_routes.router)
app.include_router(users_routes.router)
app.include_router(search_routes.router)
app.include_router(misc_routes.router)
app.include_router(oauth_routes.router)
app.include_router(yandex_disk_routes.router)
app.include_router(telegram_routes.router)
app.include_router(import_markdown_routes.router)
app.include_router(import_html_routes.router)
app.include_router(import_logseq_routes.router)


EXPORT_DESCRIPTION_LIMIT = 160

# Вынесено из app/main.py → app/telegram_bot.py (Telegram helper-ы и обработка апдейтов)
def _handle_telegram_message(message: dict[str, Any]) -> None:
    # Вынесено из app/main.py → app/telegram_bot.py
    return
# legacy: старый код обработчика Telegram (вынесено в app/telegram_bot.py)
def _legacy_handle_telegram_message(message: dict[str, Any]) -> None:
    """
    Преобразует одно сообщение Telegram в быструю заметку в inbox выбранного пользователя.
    """
    if not message:
        return
    chat = message.get('chat') or {}
    chat_id = chat.get('id')

    # Простейший слой авторизации/привязки:
    # 1) если TELEGRAM_ALLOWED_CHAT_ID задан, принимаем только этот чат;
    # 2) дополнительно можно явно привязать chat_id к user_id через telegram_links.
    if TELEGRAM_ALLOWED_CHAT_ID and chat_id is not None and str(chat_id) != TELEGRAM_ALLOWED_CHAT_ID:
        return

    raw_text = (message.get('text') or '').strip()
    # Обрабатываем команду /link <token> для привязки чата к пользователю.
    if raw_text.startswith('/link'):
        token = ''
        parts = raw_text.split(maxsplit=1)
        if len(parts) > 1:
            token = (parts[1] or '').strip()
        if not token:
            if chat_id is not None:
                _telegram_send_message(
                    chat_id,
                    'Чтобы привязать чат к Memus, отправьте: /link <код>, который вы получили в настройках Memus.',
                )
            return
        try:
            row = CONN.execute(
                'SELECT user_id, expires_at FROM telegram_link_tokens WHERE token = ?',
                (token,),
            ).fetchone()
        except Exception as exc:  # noqa: BLE001
            logger.error('Telegram bot: failed to read link token: %r', exc)
            if chat_id is not None:
                _telegram_send_message(chat_id, 'Не удалось проверить код привязки. Попробуйте позже.')
            return
        if not row:
            if chat_id is not None:
                _telegram_send_message(chat_id, 'Код привязки недействителен или уже использован.')
            return
        expires_raw = row['expires_at']
        try:
            expires_at = datetime.fromisoformat(expires_raw)
        except Exception:
            expires_at = None
        if expires_at and expires_at < datetime.utcnow():
            # Токен просрочен.
            with CONN:
                CONN.execute('DELETE FROM telegram_link_tokens WHERE token = ?', (token,))
            if chat_id is not None:
                _telegram_send_message(chat_id, 'Срок действия этого кода истёк. Сгенерируйте новый в Memus.')
            return

        user_id = row['user_id']
        chat_key = str(chat_id) if chat_id is not None else ''
        now_iso = datetime.utcnow().isoformat()
        try:
            with CONN:
                CONN.execute(
                    '''
                    INSERT INTO telegram_links (chat_id, user_id, created_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT (chat_id) DO UPDATE SET user_id = EXCLUDED.user_id, created_at = EXCLUDED.created_at
                    ''',
                    (chat_key, user_id, now_iso),
                )
                CONN.execute('DELETE FROM telegram_link_tokens WHERE token = ?', (token,))
        except Exception as exc:  # noqa: BLE001
            logger.error('Telegram bot: failed to upsert telegram_links: %r', exc)
            if chat_id is not None:
                _telegram_send_message(chat_id, 'Не удалось привязать этот чат к Memus. Попробуйте позже.')
            return

        _telegram_link_cache[chat_key] = user_id
        if chat_id is not None:
            try:
                user = get_user_by_id(user_id)
                name = user.display_name or user.username if user else ''
            except Exception:
                name = ''
            suffix = f' ({name})' if name else ''
            _telegram_send_message(
                chat_id,
                f'Этот чат успешно привязан к вашему аккаунту Memus{suffix}. Теперь просто отправляйте сюда сообщения — они будут сохраняться в «Быстрые заметки».',
            )
        return

    # Пытаемся найти пользователя по telegram_links.
    memus_user: User | None = None
    if chat_id is not None:
        key = str(chat_id)
        user_id = _telegram_link_cache.get(key)
        if user_id:
            try:
                memus_user = get_user_by_id(user_id)
            except Exception:  # noqa: BLE001
                memus_user = None
        if memus_user is None:
            try:
                row = CONN.execute(
                    'SELECT user_id FROM telegram_links WHERE chat_id = ?',
                    (key,),
                ).fetchone()
            except Exception:  # noqa: BLE001
                row = None
            if row:
                _telegram_link_cache[key] = row['user_id']
                try:
                    memus_user = get_user_by_id(row['user_id'])
                except Exception:  # noqa: BLE001
                    memus_user = None

    # Если явной привязки нет — не принимаем сообщения, только подсказываем, как привязать.
    if memus_user is None:
        if chat_id is not None:
            _telegram_send_message(
                chat_id,
                'Этот чат ещё не привязан к вашему аккаунту Memus. В Memus сгенерируйте код привязки и отправьте сюда команду /link <код>.',
            )
        return

    user: User = memus_user

    # Берём или создаём inbox конкретного пользователя.
    try:
        inbox_article = get_or_create_user_inbox(user.id)
    except Exception as exc:  # noqa: BLE001
        logger.error('Telegram bot: failed to get/create inbox for %s: %r', user.id, exc)
        return

    article_id = inbox_article.get('id') or ''
    if not article_id:
        logger.error('Telegram bot: inbox article has no id for user %s', user.id)
        return

    # Формируем HTML блока из текста и ссылок на вложения.
    parts: list[str] = []
    text = (message.get('text') or message.get('caption') or '').strip()
    if text:
        safe = html_mod.escape(text).replace('\n', '<br />')
        parts.append(f'<p>{safe}</p>')

    attachments: list[tuple[str, str]] = []

    # Фото: берём последнюю (самую большую) версию и сохраняем
    # как обычное изображение в uploads, как если бы пользователь
    # загрузил картинку через UI Memus.
    photos = message.get('photo') or []
    if isinstance(photos, list) and photos:
        best = photos[-1]
        file_id = best.get('file_id')
        if file_id:
            try:
                raw, filename, mime_type = _telegram_download_file(file_id)
                image_url = _save_image_bytes_for_user(raw, mime_type or 'image/jpeg', user)
                safe_src = html_mod.escape(image_url, quote=True)
                alt_label = filename or 'Фото'
                safe_alt = html_mod.escape(alt_label, quote=True)
                parts.append(
                    f'<p><img src="{safe_src}" alt="{safe_alt}" draggable="false" '
                    'style="max-width:100%;max-height:15rem;object-fit:contain;display:block;'
                    'margin:0.4rem 0;border-radius:12px;box-shadow:0 6px 18px rgba(15,30,40,0.1);" /></p>',
                )
            except Exception as exc:  # noqa: BLE001
                logger.error('Telegram bot: failed to store photo to uploads: %r', exc)

    # Документы / файлы.
    for key in ('document', 'audio', 'voice', 'video', 'video_note'):
        obj = message.get(key)
        if not isinstance(obj, dict):
            continue
        file_id = obj.get('file_id')
        if not file_id:
            continue
        try:
            raw, filename, mime_type = _telegram_download_file(file_id)
            # Telegram для документов/видео/аудио обычно передаёт исходное имя файла
            # в поле file_name — используем его и для подписи, и для "логического" имени
            # вложения, чтобы в заметке не появлялись безликие file_1.pdf и т.п.
            original_name = (obj.get('file_name') or '').strip() or filename or key
            disk_path = _upload_bytes_to_yandex_for_user(
                user,
                original_name,
                raw,
                mime_type or 'application/octet-stream',
            )
            create_attachment(article_id, disk_path, original_name, mime_type or '', len(raw))
            label = original_name
            attachments.append((disk_path, label))
        except Exception as exc:  # noqa: BLE001
            logger.error('Telegram bot: failed to store %s on Yandex Disk: %r', key, exc)

    for href, label in attachments:
        safe_href = html_mod.escape(href)
        safe_label = html_mod.escape(label)
        parts.append(
            f'<p><a href="{safe_href}" target="_blank" rel="noopener noreferrer">{safe_label}</a></p>',
        )

    if not parts:
        # На всякий случай создаём пустой блок, чтобы апдейт не потерялся.
        parts.append('<p><br /></p>')

    block_html = ''.join(parts)

    # Вставляем новый блок в конец корня inbox, как быстрые заметки в UI.
    root_blocks = inbox_article.get('blocks') or []
    if not root_blocks:
        # Если по какой-то причине в инбоксе нет блоков, создадим один явным UPDATE.
        now = datetime.utcnow().isoformat()
        new_block = {
            'id': str(uuid4()),
            'text': block_html,
            'collapsed': False,
            'children': [],
        }
        inbox_article['blocks'] = [new_block]
        try:
            save_article(inbox_article)
        except Exception as exc:  # noqa: BLE001
            logger.error('Telegram bot: failed to save inbox article directly: %r', exc)
            return
        if chat_id is not None:
            _telegram_send_message(chat_id, 'Заметка сохранена в «Быстрые заметки».')
        return

    anchor_id = root_blocks[-1].get('id')
    if not anchor_id:
        logger.error('Telegram bot: last inbox block has no id for article %s', article_id)
        return

    payload = {
        'text': block_html,
        'collapsed': False,
        'children': [],
    }
    try:
        insert_block(article_id, anchor_id, 'after', payload)
    except Exception as exc:  # noqa: BLE001
        logger.error('Telegram bot: insert_block failed: %r', exc)
        return

    if chat_id is not None:
        _telegram_send_message(chat_id, 'Заметка сохранена в «Быстрые заметки».')


# Вынесено из app/main.py → app/onboarding.py (ensure_help_article_for_user)
def _legacy_ensure_help_article_for_user(author_id: str) -> None:
    """
    Гарантирует, что у пользователя есть хотя бы одна статья.
    Если статей ещё нет, создаёт «Memus - Руководство пользователя»
    на основе client/help.html (экспорт Memus с блоком memus-export).
    """
    if not author_id:
        return
    try:
        row = CONN.execute(
            'SELECT 1 FROM articles WHERE deleted_at IS NULL AND author_id = ? LIMIT 1',
            (author_id,),
        ).fetchone()
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to check articles for user %s: %r', author_id, exc)
        return
    if row:
        # У пользователя уже есть хотя бы одна статья — ничего не делаем.
        return

    try:
        html_text = HELP_TEMPLATE_PATH.read_text(encoding='utf-8')
    except OSError as exc:  # noqa: BLE001
        logger.error('Failed to read help template %s: %r', HELP_TEMPLATE_PATH, exc)
        return

    try:
        payload = _parse_memus_export_payload(html_text)
    except ValueError as exc:  # noqa: BLE001
        logger.error('Failed to parse memus-export from help.html: %r', exc)
        return

    article_meta = payload.get('article') or {}
    blocks_meta = payload.get('blocks') or []

    def build_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for meta in blocks or []:
            children_meta = meta.get('children') or []
            children = build_blocks(children_meta)
            result.append(
                {
                    'id': str(uuid4()),
                    'text': meta.get('text') or '',
                    'collapsed': bool(meta.get('collapsed')),
                    'children': children,
                }
            )
        return result

    now = datetime.utcnow().isoformat()
    new_article_id = str(uuid4())
    title_raw = (article_meta.get('title') or 'Memus - Руководство пользователя').strip()
    title = title_raw or 'Memus - Руководство пользователя'

    article = {
        'id': new_article_id,
        'title': title,
        'createdAt': article_meta.get('createdAt') or now,
        'updatedAt': article_meta.get('updatedAt') or now,
        'deletedAt': None,
        'blocks': build_blocks(blocks_meta),
        'history': [],
        'redoHistory': [],
        'authorId': author_id,
    }
    try:
        save_article(article)
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to create default help article for user %s: %r', author_id, exc)
        return


def _collect_plain_text_from_blocks(blocks: list[dict[str, Any]] | None) -> list[str]:
    """
    Собирает простой текст из дерева блоков статьи:
    - вычищает HTML-теги;
    - схлопывает повторяющиеся пробелы.
    Используется для описания и wordCount в экспортируемых HTML.
    """
    result: list[str] = []

    def _walk(nodes: list[dict[str, Any]] | None) -> None:
        if not nodes:
            return
        for blk in nodes:
            if not isinstance(blk, dict):
                continue
            raw = blk.get('text') or ''
            if raw:
                # Грубое удаление тегов + unescape, этого достаточно для описания.
                plain = re.sub(r'<[^>]+>', ' ', raw)
                plain = html_mod.unescape(plain)
                plain = ' '.join(plain.split())
                if plain:
                    result.append(plain)
            children = blk.get('children') or []
            if children:
                _walk(children)

    _walk(blocks or [])
    return result


def _build_export_description(plain_text: str | None) -> str:
    """
    Строит короткое описание статьи (meta description) по первым символам текста.
    """
    if not plain_text:
        return ''
    snippet = ' '.join(plain_text.split())
    if len(snippet) <= EXPORT_DESCRIPTION_LIMIT:
        return snippet
    return f'{snippet[:EXPORT_DESCRIPTION_LIMIT].rstrip()}…'


def _serialize_blocks_for_export(blocks: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """
    Приводит дерево блоков к тому же формату, который использует клиентский exporter.js
    в buildExportPayload: id/text/collapsed/children.
    """
    if not blocks:
        return []
    result: list[dict[str, Any]] = []
    for blk in blocks:
        if not isinstance(blk, dict):
            continue
        children = blk.get('children') or []
        result.append(
            {
                'id': blk.get('id'),
                'text': blk.get('text') or '',
                'collapsed': bool(blk.get('collapsed')),
                'children': _serialize_blocks_for_export(children),
            },
        )
    return result


def _build_export_payload_for_article(article: dict[str, Any] | None) -> dict[str, Any]:
    """
    Формирует JSON-снапшот memus-export в формате, совместимом с client/exporter.js.
    Этот блок попадает в <script type="application/json" id="memus-export">...</script>.
    """
    if not article:
        return {
            'version': 1,
            'source': 'memus',
            'article': None,
            'blocks': [],
        }

    article_id = article.get('id') or ''
    author_id = article.get('authorId') or ''
    # inbox в базе имеет вид inbox-<userId>, в экспорте достаточно флажка.
    is_inbox = article_id == 'inbox' or (
        isinstance(article_id, str)
        and isinstance(author_id, str)
        and article_id == f'inbox-{author_id}'
    )

    meta = {
        'id': article_id,
        'title': article.get('title') or '',
        'createdAt': article.get('createdAt') or None,
        'updatedAt': article.get('updatedAt') or None,
        'deletedAt': article.get('deletedAt') or None,
        'isInbox': bool(is_inbox),
        'encrypted': bool(article.get('encrypted')),
        'encryptionHint': article.get('encryptionHint') or None,
    }

    return {
        'version': 1,
        'source': 'memus',
        'article': meta,
        'blocks': _serialize_blocks_for_export(article.get('blocks') or []),
    }


def _strip_html_tags(html_text: str) -> str:
    """Грубое удаление HTML-тегов для извлечения текстового заголовка."""
    if not html_text:
        return ''
    # Удаляем теги и декодируем сущности.
    text = re.sub(r'<[^>]+>', '', html_text)
    return html_mod.unescape(text).strip()


def _split_public_block_sections(raw_html: str) -> tuple[str, str]:
    """
    Приближённый вариант client-side extractBlockSections для публичной страницы.

    Логика:
    - ищем первый по-настоящему «пустой» <p> (содержит только <br>, &nbsp;,
      пробелы и обёртки без текста/картинок);
    - всё ДО него считаем заголовком, всё ПОСЛЕ — телом;
    - если пустой абзац идёт первым, заголовка нет вообще.
    """
    if not raw_html:
        return '', ''

    first_empty: re.Match[str] | None = None
    for m in re.finditer(r'<p\b[^>]*>(.*?)</p\s*>', raw_html, flags=re.IGNORECASE | re.DOTALL):
        inner = m.group(1) or ''
        # Абзац с картинкой никогда не считаем «пустым».
        if re.search(r'<img\b', inner, flags=re.IGNORECASE):
            continue
        # Убираем явные переносы и неразрывные пробелы.
        tmp = re.sub(r'<br\s*/?>', '', inner, flags=re.IGNORECASE)
        tmp = re.sub(r'(&nbsp;|&#160;|\u00A0)', '', tmp, flags=re.IGNORECASE)
        # Удаляем оставшиеся теги, оставляя только текст.
        text_only = re.sub(r'<[^>]+>', '', tmp)
        if text_only.strip():
            # В абзаце есть настоящий текст — не разделитель.
            continue
        first_empty = m
        break

    if not first_empty:
        # Пустых абзацев нет — весь блок считается телом, без заголовка.
        return '', raw_html

    if first_empty.start() <= 0:
        # Первый абзац уже пустой — считаем, что заголовка нет.
        return '', raw_html[first_empty.end() :]

    # Есть содержимое до первого пустого абзаца — это и есть заголовок.
    return raw_html[: first_empty.start()], raw_html[first_empty.end() :]


def _title_starts_with_empty_paragraph(title_html: str) -> bool:
    """
    Проверяет, начинается ли HTML заголовка с «пустого» абзаца
    (<p> с только <br>, &nbsp; и т.п.). В таком случае считаем,
    что заголовка по сути нет (как в клиентском extractBlockSections).
    """
    if not title_html:
        return False
    m = re.match(
        r'\s*<p\b[^>]*>(.*?)</p\s*>',
        title_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not m:
        return False
    inner = m.group(1) or ''
    # Абзац с картинкой считаем содержательным.
    if re.search(r'<img\b', inner, flags=re.IGNORECASE):
        return False
    tmp = re.sub(r'<br\s*/?>', '', inner, flags=re.IGNORECASE)
    tmp = re.sub(r'(&nbsp;|&#160;|\u00A0)', '', tmp, flags=re.IGNORECASE)
    text_only = re.sub(r'<[^>]+>', '', tmp)
    return not text_only.strip()


def _generate_public_slug() -> str:
    """
    Генерирует уникальный короткий slug для публичной ссылки на статью.
    Используем urlsafe base64 от случайных байт и обрезаем до 10 символов.
    """
    while True:
        raw = os.urandom(8)
        candidate = base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=\n')[:10]
        # Некоторые мессенджеры/клиенты (особенно на мобильных) могут "съедать"
        # завершающие символы '-'/'_' при авто-распознавании ссылок.
        # Поэтому гарантируем, что slug начинается и заканчивается буквенно-цифровым символом.
        if not re.match(r'^[A-Za-z0-9][A-Za-z0-9_-]*[A-Za-z0-9]$', candidate):
            continue
        row = CONN.execute(
            'SELECT 1 FROM articles WHERE public_slug = ?',
            (candidate,),
        ).fetchone()
        if not row:
            return candidate


def _get_public_article_row(slug: str):
    """
    Находит статью по public_slug.
    Фолбэк: если exact slug не найден, пробуем добавить суффикс '-' или '_'
    (мобильные клиенты иногда обрезают завершающий символ в URL).
    Возвращает строку из БД или None.
    """
    row = CONN.execute(
        'SELECT * FROM articles WHERE public_slug = ? AND deleted_at IS NULL',
        (slug,),
    ).fetchone()
    if row:
        return row
    if not slug:
        return None
    # Фолбэк только если exact отсутствует: избегаем подмены, если точное совпадение есть.
    candidates = []
    for suffix in ('-', '_'):
        probe = f'{slug}{suffix}'
        r = CONN.execute(
            'SELECT * FROM articles WHERE public_slug = ? AND deleted_at IS NULL',
            (probe,),
        ).fetchone()
        if r:
            candidates.append(r)
    if len(candidates) == 1:
        return candidates[0]
    return None


def _render_public_block(block: dict[str, Any], heading_depth: int = 1) -> str:
    """
    Простая HTML-версия блока для публичной страницы.
    Используем ту же разметку .block / .block-surface / .block-content / .block-text,
    но без интерактивных кнопок и drag-элементов.
    """
    raw_html = block.get('text') or ''
    children = block.get('children') or []
    has_children = bool(children)
    collapsed = bool(block.get('collapsed'))
    block_id = html_mod.escape(str(block.get('id') or ''))

    # Разбиваем stored HTML на заголовок и тело по первому по-настоящему
    # «пустому» <p>, максимально повторяя client-side extractBlockSections.
    title_html, body_html = _split_public_block_sections(raw_html)
    has_title = bool(title_html.strip())

    # Если у блока нет явного заголовка, но есть дети и внутри всего одна
    # «осмысленная» строка (<p>...</p>), считаем её заголовком. Это повторяет
    # хак из client/article.js и client/exporter.js.
    if not has_title and has_children:
        candidate = body_html or raw_html
        candidate = candidate.strip()
        m = re.fullmatch(r'\s*<p\b[^>]*>(.*?)</p>\s*', candidate, flags=re.IGNORECASE | re.DOTALL)
        if m:
            inner = m.group(1) or ''
            inner_clean = re.sub(r'(&nbsp;|<br\s*/?>)', '', inner, flags=re.IGNORECASE).strip()
            if inner_clean:
                title_html = candidate
                body_html = ''
                has_title = True

    # Если «заголовок» сам по себе начинается с пустой строки — считаем,
    # что это не настоящий заголовок, а просто контент блока.
    if has_title and _title_starts_with_empty_paragraph(title_html):
        body_html = f'{title_html}{body_html}'
        title_html = ''
        has_title = False

    # Кнопка сворачивания как в экспорте: с data-block-id и aria-expanded.
    if has_children or raw_html:
        collapse_btn = (
            f'<button class="collapse-btn" type="button" '
            f'data-block-id="{block_id}" aria-expanded="{ "false" if collapsed else "true" }"></button>'
        )
    else:
        collapse_btn = (
            '<button class="collapse-btn collapse-btn--placeholder" type="button" '
            'aria-hidden="true"></button>'
        )

    # Заголовок блока (если есть).
    header_html = ''
    if has_title:
        level = max(1, min(int(heading_depth or 1), 6))
        heading_tag = f'h{level}'
        header_html = (
            '<div class="block-header">'
            '<div class="block-header__left">'
            f'<{heading_tag} class="block-title" style="flex: 1 1 0%; min-width: 0px;">'
            f'{title_html}'
            f'</{heading_tag}>'
            '</div>'
            '</div>'
        )

    body_classes = ['block-text', 'block-body']
    if not has_title:
        body_classes.append('block-body--no-title')
    # Для блоков с заголовком в свёрнутом состоянии скрываем тело (как в экспорте):
    if has_title and collapsed:
        body_classes.append('collapsed')
    body = f'<div class="{" ".join(body_classes)}" data-block-body>{body_html}</div>'
    content = f'<div class="block-content">{header_html}{body}</div>'
    surface = f'<div class="block-surface">{collapse_btn}{content}</div>'

    next_heading_depth = heading_depth + 1 if has_title else heading_depth
    children_html = ''.join(_render_public_block(child, next_heading_depth) for child in children)
    if children_html:
        children_classes = ['block-children']
        if collapsed:
            children_classes.append('collapsed')
        children_container = f'<div class="{" ".join(children_classes)}" data-children>{children_html}</div>'
    else:
        children_container = ''

    block_classes = ['block']
    if not has_title:
        block_classes.append('block--no-title')

    return (
        f'<div class="{" ".join(block_classes)}" data-block-id="{block_id}" '
        f'data-collapsed="{"true" if collapsed else "false"}" tabindex="0">'
        f'{surface}{children_container}</div>'
    )


def _build_public_article_html(article: dict[str, Any]) -> str:
    """
    Собирает минимальную HTML-страницу для публичного просмотра статьи.
    Использует базовые стили /style.css и ту же структуру блоков, что и экспорт.
    """
    title = html_mod.escape(article.get('title') or 'Без названия')
    updated_raw = article.get('updatedAt') or article.get('updated_at')
    try:
        updated_label = (
            datetime.fromisoformat(updated_raw).strftime('%Y-%m-%d %H:%M:%S')
            if updated_raw
            else ''
        )
    except Exception:  # noqa: BLE001
        updated_label = updated_raw or ''

    # Перед рендерингом переписываем внутренние ссылки /article/<id> в тексте блоков.
    def _walk_and_rewrite(blocks: list[dict[str, Any]] | None) -> None:
        if not blocks:
            return
        for b in blocks:
            if not isinstance(b, dict):
                continue
            text_html = b.get('text') or ''
            if text_html:
                b['text'] = _rewrite_internal_links_for_public(text_html)
            _walk_and_rewrite(b.get('children'))

    blocks = article.get('blocks') or []
    _walk_and_rewrite(blocks)
    blocks_html = ''.join(_render_public_block(b, 1) for b in blocks)
    header = f"""
    <div class="panel-header article-header">
      <div class="title-block">
        <div class="title-row">
          <h1 class="export-title">{title}</h1>
        </div>
        {f'<p class="meta">Обновлено: {html_mod.escape(updated_label)}</p>' if updated_label else ''}
        <p class="meta">Публичная страница Memus (только для чтения)</p>
      </div>
    </div>
    """
    body_inner = f"""
    <div class="export-shell" aria-label="Публичная статья">
      <main class="content export-content">
        <section class="panel export-panel" aria-label="Статья">
          {header}
          <div id="exportBlocksRoot" class="blocks" role="tree">
            {blocks_html}
          </div>
        </section>
      </main>
    </div>
    """

    # Берём тот же extraCss, что и экспорт HTML в exporter.js
    extra_css = """
    body.export-page {
      margin: 0.1rem;
      background: #eef2f8;
      overflow: auto;
      height: auto;
    }
    .export-shell {
      min-height: 100vh;
      display: flex;
      justify-content: center;
      background: #eef2f8;
    }
    .export-content {
      
      width: 100%;
      max-width: 960px;
    }
    .export-panel {
      min-height: auto;
      height: auto;
    }
    .block-children.collapsed {
      display: none;
    }
    .block {
      cursor: default;
    }
    .export-title {
      margin: 0;
    }
    @media (max-width: 800px) {
      body.export-page .page {
        margin: 0;
        padding: 0;
        max-width: 100%;
        border-radius: 0;
        box-shadow: none;
      }
      body.export-page .export-content {
        padding: 0;
      }
    }
    """

    # Загружаем тот же style.css, что и SPA.
    try:
        css_text = (CLIENT_DIR / 'style.css').read_text(encoding='utf-8')
    except OSError:
        css_text = ''

    interactions_script = """
    <script>
(function() {
  var root = document.getElementById('exportBlocksRoot');
  if (!root) return;
  var collapseIcon = { open: '▾', closed: '▸' };
  var firstBlock = root.querySelector('.block');
  var currentId = firstBlock ? firstBlock.getAttribute('data-block-id') : null;

  function getParentBlock(block) {
    if (!block || !block.parentElement) return null;
    return block.parentElement.closest('.block');
  }

  function updateBlockView(block, collapsed) {
    block.dataset.collapsed = collapsed ? 'true' : 'false';
    var body = block.querySelector('.block-body');
    var noTitle = block.classList.contains('block--no-title');
    if (body && !noTitle) {
      body.classList.toggle('collapsed', collapsed);
    }
    var children = block.querySelector('.block-children');
    if (children) children.classList.toggle('collapsed', collapsed);
    var btn = block.querySelector('.collapse-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.textContent = collapsed ? collapseIcon.closed : collapseIcon.open;
    }
  }

  function collectVisible() {
    var result = [];
    function walk(container) {
      var children = container.children;
      for (var i = 0; i < children.length; i += 1) {
        var node = children[i];
        if (!node.classList || !node.classList.contains('block')) continue;
        result.push(node);
        var isCollapsed = node.dataset.collapsed === 'true';
        var kids = node.querySelector('.block-children');
        if (!isCollapsed && kids) walk(kids);
      }
    }
    walk(root);
    return result;
  }

  function setCurrent(block) {
    if (!block) return;
    currentId = block.getAttribute('data-block-id') || null;
    Array.prototype.forEach.call(
      root.querySelectorAll('.block.selected'),
      function(el) { el.classList.remove('selected'); }
    );
    block.classList.add('selected');
    block.focus({ preventScroll: false });
  }

  function toggleBlock(block, desired) {
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    var next = typeof desired === 'boolean' ? desired : !collapsed;
    updateBlockView(block, next);
  }

  function moveSelection(offset) {
    if (!currentId) {
      var first = root.querySelector('.block');
      if (first) setCurrent(first);
      return;
    }
    var ordered = collectVisible();
    var index = -1;
    for (var i = 0; i < ordered.length; i += 1) {
      if (ordered[i].getAttribute('data-block-id') === currentId) {
        index = i;
        break;
      }
    }
    if (index === -1) return;
    var next = ordered[index + offset];
    if (next) setCurrent(next);
  }

  function scrollCurrentBlockStep(direction) {
    if (!currentId) return false;
    var el =
      root.querySelector('.block[data-block-id=\"' + currentId + '\"] > .block-surface') ||
      root.querySelector('.block[data-block-id=\"' + currentId + '\"]');
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var margin = 24;
    var visibleHeight = window.innerHeight - margin * 2;
    if (visibleHeight <= 0) return false;
    if (rect.height <= visibleHeight) return false;
    if (direction === 'down') {
      var bottomLimit = window.innerHeight - margin;
      if (rect.bottom <= bottomLimit) return false;
      var delta = rect.bottom - bottomLimit;
      var baseStep = Math.min(Math.max(delta, 40), 160);
      var step = Math.max(24, Math.round(baseStep / 3));
      window.scrollBy({ top: step, behavior: 'smooth' });
      return true;
    }
    if (direction === 'up') {
      var topLimit = margin;
      if (rect.top >= topLimit) return false;
      var deltaUp = topLimit - rect.top;
      var baseStepUp = Math.min(Math.max(deltaUp, 40), 160);
      var stepUp = Math.max(24, Math.round(baseStepUp / 3));
      window.scrollBy({ top: -stepUp, behavior: 'smooth' });
      return true;
    }
    return false;
  }

  function handleArrowLeft() {
    if (!currentId) return;
    var block = root.querySelector('.block[data-block-id=\"' + currentId + '\"]');
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    if (!collapsed) {
      toggleBlock(block, true);
      return;
    }
    var parent = getParentBlock(block);
    if (parent) setCurrent(parent);
  }

  function handleArrowRight() {
    if (!currentId) return;
    var block = root.querySelector('.block[data-block-id=\"' + currentId + '\"]');
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    var firstChild = block.querySelector('.block-children .block');
    if (collapsed) {
      toggleBlock(block, false);
      if (firstChild) setCurrent(firstChild);
      return;
    }
    if (firstChild) {
      setCurrent(firstChild);
    }
  }

  root.addEventListener('click', function(event) {
    var unpublished = event.target.closest('a[data-unpublished=\"1\"]');
    if (unpublished) {
      event.preventDefault();
      alert('Эта страница пока не опубликована');
      return;
    }
    var btn = event.target.closest('.collapse-btn');
    if (btn) {
      var targetId = btn.getAttribute('data-block-id');
      var block = root.querySelector('.block[data-block-id=\"' + targetId + '\"]');
      toggleBlock(block);
      setCurrent(block);
      return;
    }
    var block = event.target.closest('.block');
    if (block) {
      var header = block.querySelector('.block-header');
      var body = block.querySelector('.block-text.block-body');
      var bodyHasNoTitle = body && body.classList.contains('block-body--no-title');
      var clickedInHeader = header && header.contains(event.target);
      var clickedInBody = body && body.contains(event.target);
      var hasLogicalTitle = !!(header && !bodyHasNoTitle);
      var isInteractive = event.target.closest('a, button, input, textarea, select');
      var shouldToggle = false;
      if (hasLogicalTitle && clickedInHeader) {
        // Для заголовка всегда разрешаем сворачивание, даже если внутри есть ссылка.
        shouldToggle = true;
      } else if (!hasLogicalTitle && clickedInBody && !isInteractive) {
        // Для блоков без заголовка кликаем по телу, но не по интерактивным элементам.
        shouldToggle = true;
      }
      if (shouldToggle) {
        toggleBlock(block);
      }
      setCurrent(block);
    }
  });

  document.addEventListener('keydown', function(event) {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', ' '].indexOf(event.code) !== -1) {
      event.preventDefault();
    } else {
      return;
    }
    if (event.code === 'ArrowDown') {
      var scrolledDown = scrollCurrentBlockStep('down');
      if (!scrolledDown) moveSelection(1);
      return;
    }
    if (event.code === 'ArrowUp') {
      var scrolledUp = scrollCurrentBlockStep('up');
      if (!scrolledUp) moveSelection(-1);
      return;
    }
    if (event.code === 'ArrowLeft') {
      handleArrowLeft();
      return;
    }
    if (event.code === 'ArrowRight') {
      handleArrowRight();
      return;
    }
    if (event.code === 'Enter' || event.code === 'Space' || event.code === ' ') {
      if (!currentId) return;
      var block = root.querySelector('.block[data-block-id=\"' + currentId + '\"]');
      toggleBlock(block);
    }
  });

  if (firstBlock) setCurrent(firstBlock);
})();
    </script>
    """

    html = f"""<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="/icons/favicon.ico" type="image/x-icon" />
    <style>
{css_text}
{extra_css}
    </style>
  </head>
  <body class="export-page">
    <div class="page">
      {body_inner}
    </div>
    {interactions_script}
  </body>
</html>
"""
    return html


def _build_backup_article_html(article: dict[str, Any], css_text: str, lang: str = 'ru') -> str:
    """
    Собирает полноценный HTML-документ для резервной копии одной статьи:
    - структура блоков и стили такие же, как у клиентского экспорта;
    - внутрь помещается JSON-снапшот memus-export, совместимый с импортом /api/import/html;
    - внутренние ссылки остаются как есть (без переписывания под /p/<slug>).
    """
    title_raw = article.get('title') or 'Без названия'
    title = html_mod.escape(title_raw)
    updated_raw = article.get('updatedAt') or ''
    created_raw = article.get('createdAt') or updated_raw or ''

    # Текст и статистика для description/JSON-LD.
    plain_parts = _collect_plain_text_from_blocks(article.get('blocks') or [])
    plain_text = ' '.join(plain_parts).strip()
    word_count = len(plain_text.split()) if plain_text else 0
    description = _build_export_description(plain_text) or title_raw

    # Человеко-читаемая дата обновления для заголовка.
    try:
        updated_label = (
            datetime.fromisoformat(updated_raw).strftime('%Y-%m-%d %H:%M:%S')
            if updated_raw
            else ''
        )
    except Exception:  # noqa: BLE001
        updated_label = updated_raw or ''

    blocks = article.get('blocks') or []
    blocks_html = ''.join(_render_public_block(b, 1) for b in blocks)
    header = f"""
    <div class="panel-header article-header">
      <div class="title-block">
        <div class="title-row">
          <h1 class="export-title">{title}</h1>
        </div>
        {f'<p class="meta">Обновлено: {html_mod.escape(updated_label)}</p>' if updated_label else ''}
      </div>
    </div>
    """
    body_inner = f"""
    <div class="export-shell" aria-label="Экспорт статьи">
      <main class="content export-content">
        <section class="panel export-panel" aria-label="Статья">
          {header}
          <div id="exportBlocksRoot" class="blocks" role="tree">
            {blocks_html}
          </div>
        </section>
      </main>
    </div>
    """

    # Те же базовые стили, что и в публичной версии / клиентском экспорте.
    extra_css = """
    body.export-page {
      margin: 0.1rem;
      background: #eef2f8;
      overflow: auto;
      height: auto;
    }
    .export-shell {
      min-height: 100vh;
      display: flex;
      justify-content: center;
      background: #eef2f8;
    }
    .export-content {
      padding: 1.5rem 1rem 2rem;
      width: 100%;
      max-width: 960px;
    }
    .export-panel {
      min-height: auto;
      height: auto;
    }
    .block-children.collapsed {
      display: none;
    }
    .block {
      cursor: default;
    }
    .export-title {
      margin: 0;
    }
    @media (max-width: 800px) {
      body.export-page .page {
        margin: 0.1rem;
        padding: 0;
        max-width: 100%;
        border-radius: 0;
        box-shadow: none;
      }
      body.export-page .export-content {
        padding: 0.1rem;
      }
    }
    """

    # JSON-LD, как в client/exporter.js.
    json_ld = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        'headline': title_raw,
        'description': description,
        'dateModified': updated_raw or '',
        'datePublished': created_raw or '',
        'wordCount': word_count,
        'inLanguage': lang or 'ru',
    }

    export_payload = _build_export_payload_for_article(article)

    interactions_script = """
    <script>
(function() {
  var root = document.getElementById('exportBlocksRoot');
  if (!root) return;
  var collapseIcon = { open: '▾', closed: '▸' };
  var firstBlock = root.querySelector('.block');
  var currentId = firstBlock ? firstBlock.getAttribute('data-block-id') : null;

  function getParentBlock(block) {
    if (!block || !block.parentElement) return null;
    return block.parentElement.closest('.block');
  }

  function updateBlockView(block, collapsed) {
    block.dataset.collapsed = collapsed ? 'true' : 'false';
    var body = block.querySelector('.block-body');
    var noTitle = block.classList.contains('block--no-title');
    if (body && !noTitle) {
      body.classList.toggle('collapsed', collapsed);
    }
    var children = block.querySelector('.block-children');
    if (children) children.classList.toggle('collapsed', collapsed);
    var btn = block.querySelector('.collapse-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.textContent = collapsed ? collapseIcon.closed : collapseIcon.open;
    }
  }

  function collectVisible() {
    var result = [];
    function walk(container) {
      var children = container.children;
      for (var i = 0; i < children.length; i += 1) {
        var node = children[i];
        if (!node.classList || !node.classList.contains('block')) continue;
        result.push(node);
        var isCollapsed = node.dataset.collapsed === 'true';
        var kids = node.querySelector('.block-children');
        if (!isCollapsed && kids) walk(kids);
      }
    }
    walk(root);
    return result;
  }

  function setCurrent(block) {
    if (!block) return;
    currentId = block.getAttribute('data-block-id') || null;
    Array.prototype.forEach.call(
      root.querySelectorAll('.block.selected'),
      function(el) { el.classList.remove('selected'); }
    );
    block.classList.add('selected');
    block.focus({ preventScroll: false });
  }

  function toggleBlock(block, desired) {
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    var next = typeof desired === 'boolean' ? desired : !collapsed;
    updateBlockView(block, next);
  }

  function moveSelection(offset) {
    if (!currentId) {
      var first = root.querySelector('.block');
      if (first) setCurrent(first);
      return;
    }
    var ordered = collectVisible();
    var index = -1;
    for (var i = 0; i < ordered.length; i += 1) {
      if (ordered[i].getAttribute('data-block-id') === currentId) {
        index = i;
        break;
      }
    }
    if (index === -1) return;
    var next = ordered[index + offset];
    if (next) setCurrent(next);
  }

  function scrollCurrentBlockStep(direction) {
    if (!currentId) return false;
    var el =
      root.querySelector('.block[data-block-id="' + currentId + '"] > .block-surface') ||
      root.querySelector('.block[data-block-id="' + currentId + '"]');
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var margin = 24;
    var visibleHeight = window.innerHeight - margin * 2;
    if (visibleHeight <= 0) return false;
    if (rect.height <= visibleHeight) return false;
    if (direction === 'down') {
      var bottomLimit = window.innerHeight - margin;
      if (rect.bottom <= bottomLimit) return false;
      var delta = rect.bottom - bottomLimit;
      var baseStep = Math.min(Math.max(delta, 40), 160);
      var step = Math.max(24, Math.round(baseStep / 3));
      window.scrollBy({ top: step, behavior: 'smooth' });
      return true;
    }
    if (direction === 'up') {
      var topLimit = margin;
      if (rect.top >= topLimit) return false;
      var deltaUp = topLimit - rect.top;
      var baseStepUp = Math.min(Math.max(deltaUp, 40), 160);
      var stepUp = Math.max(24, Math.round(baseStepUp / 3));
      window.scrollBy({ top: -stepUp, behavior: 'smooth' });
      return true;
    }
    return false;
  }

  function handleArrowLeft() {
    if (!currentId) return;
    var block = root.querySelector('.block[data-block-id="' + currentId + '"]');
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    if (!collapsed) {
      toggleBlock(block, true);
      return;
    }
    var parent = getParentBlock(block);
    if (parent) setCurrent(parent);
  }

  function handleArrowRight() {
    if (!currentId) return;
    var block = root.querySelector('.block[data-block-id="' + currentId + '"]');
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    var firstChild = block.querySelector('.block-children .block');
    if (collapsed) {
      toggleBlock(block, false);
      if (firstChild) setCurrent(firstChild);
      return;
    }
    if (firstChild) {
      setCurrent(firstChild);
    }
  }

  root.addEventListener('click', function(event) {
    var btn = event.target.closest('.collapse-btn');
    if (btn) {
      var targetId = btn.getAttribute('data-block-id');
      var block = root.querySelector('.block[data-block-id=\"' + targetId + '\"]');
      toggleBlock(block);
      setCurrent(block);
      return;
    }
    var block = event.target.closest('.block');
    if (block) {
      var isInteractive = event.target.closest('a, button, input, textarea, select');
      if (!isInteractive) {
        var header = block.querySelector('.block-header');
        var body = block.querySelector('.block-text.block-body');
        var bodyHasNoTitle = body && body.classList.contains('block-body--no-title');
        var clickedInHeader = header && header.contains(event.target);
        var clickedInBody = body && body.contains(event.target);
        var hasLogicalTitle = !!(header && !bodyHasNoTitle);
        var shouldToggle = false;
        if (hasLogicalTitle && clickedInHeader) {
          shouldToggle = true;
        } else if (!hasLogicalTitle && clickedInBody) {
          shouldToggle = true;
        }
        if (shouldToggle) {
          toggleBlock(block);
        }
      }
      setCurrent(block);
    }
  });

  document.addEventListener('keydown', function(event) {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', ' '].indexOf(event.code) !== -1) {
      event.preventDefault();
    } else {
      return;
    }
    if (event.code === 'ArrowDown') {
      var scrolledDown = scrollCurrentBlockStep('down');
      if (!scrolledDown) moveSelection(1);
      return;
    }
    if (event.code === 'ArrowUp') {
      var scrolledUp = scrollCurrentBlockStep('up');
      if (!scrolledUp) moveSelection(-1);
      return;
    }
    if (event.code === 'ArrowLeft') {
      handleArrowLeft();
      return;
    }
    if (event.code === 'ArrowRight') {
      handleArrowRight();
      return;
    }
    if (event.code === 'Enter' || event.code === 'Space' || event.code === ' ') {
      if (!currentId) return;
      var block = root.querySelector('.block[data-block-id="' + currentId + '"]');
      toggleBlock(block);
    }
  });

  if (firstBlock) setCurrent(firstBlock);
})();
    </script>
    """

    lang_safe = html_mod.escape(lang or 'ru')
    description_safe = html_mod.escape(description or title_raw)

    return f"""<!doctype html>
<html lang="{lang_safe}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content="{description_safe}" />
    <meta name="x-memus-export" content="memus;v=1" />
    <meta name="robots" content="index,follow" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="{title}" />
    <meta property="og:description" content="{description_safe}" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" href="/icons/favicon.ico" type="image/x-icon" />
    <style>
{css_text}
{extra_css}
    </style>
    <script type="application/ld+json">
{json.dumps(json_ld, ensure_ascii=False, indent=2)}
    </script>
  </head>
  <body class="export-page">
    <div class="page">
    <script type="application/json" id="memus-export">
{json.dumps(export_payload, ensure_ascii=False, indent=2)}
    </script>
    {body_inner}
    </div>
    {interactions_script}
  </body>
</html>
"""


def _inline_uploads_for_backup(html_text: str, current_user: User | None) -> str:
    """
    Делает резервную HTML-страницу самодостаточной:
    - все ссылки src=\"/uploads/...\" и href=\"/uploads/...\" для текущего пользователя
      конвертирует в data: URL;
    - при этом добавляет data-original-src/href с исходным путём, чтобы импорт
      мог при желании переиспользовать существующие файлы и не плодить дубликаты.
    """
    if not current_user or '/uploads/' not in (html_text or ''):
        return html_text

    def _replace(match: re.Match[str]) -> str:
        attr = match.group(1)  # src | href
        original_url = match.group(2) or ''
        if not original_url.startswith('/uploads/'):
            return match.group(0)
        # Путь внутри uploads
        rel = original_url[len('/uploads/') :].lstrip('/')
        rel_path = PurePosixPath(rel)
        parts = rel_path.parts
        # Гарантируем, что путь принадлежит текущему пользователю.
        if not parts or parts[0] != current_user.id:
            return match.group(0)
        file_path = UPLOADS_DIR / rel_path
        if not file_path.is_file():
            return match.group(0)
        try:
            raw = file_path.read_bytes()
        except OSError:
            return match.group(0)
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if not mime_type:
            mime_type = 'application/octet-stream'
        b64 = base64.b64encode(raw).decode('ascii')
        data_url = f'data:{mime_type};base64,{b64}'
        # src=\"...\" -> src=\"data:...\" data-original-src=\"...\"
        return f'{attr}=\"{data_url}\" data-original-{attr}=\"{original_url}\"'

    pattern = re.compile(r'(src|href)=\"(/uploads/[^\"]+)\"')
    return pattern.sub(_replace, html_text or '')

# Вынесено из app/main.py → app/routers/oauth.py (GET /api/auth/google/login)
def google_login(request: Request):
    """
    Запускает OAuth-авторизацию через Google:
    редиректит пользователя на accounts.google.com.
    """
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail='Google OAuth не настроен')

    state = os.urandom(16).hex()
    response = RedirectResponse(
        url='https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(
            {
                'client_id': GOOGLE_CLIENT_ID,
                'redirect_uri': GOOGLE_REDIRECT_URI,
                'response_type': 'code',
                'scope': 'openid email profile',
                'state': state,
                'access_type': 'online',
                'prompt': 'select_account',
            },
        ),
    )
    # Простой CSRF-guard через cookie.
    response.set_cookie(
        key='google_oauth_state',
        value=state,
        httponly=True,
        secure=False,
        samesite='lax',
        path='/',
    )
    return response


# Вынесено из app/main.py → app/routers/oauth.py (GET /api/auth/google/callback)
def google_callback(request: Request):
    """
    Обрабатывает колбек от Google:
    - проверяет state;
    - обменивает code на токены;
    - получает email/имя пользователя;
    - находит/создаёт пользователя и создаёт сессию;
    - редиректит на SPA.
    """
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail='Google OAuth не настроен')

    params = dict(request.query_params)
    error = params.get('error')
    if error:
        logger.warning('Google OAuth error: %s', error)
        raise HTTPException(status_code=400, detail=f'Ошибка Google OAuth: {error}')

    code = params.get('code')
    state = params.get('state') or ''
    if not code:
        raise HTTPException(status_code=400, detail='Не передан code от Google')

    cookie_state = request.cookies.get('google_oauth_state') or ''
    # В идеале state из query-параметра и cookie должны совпадать.
    # На некоторых мобильных платформах (PWA / внешние браузеры) cookie
    # может потеряться, поэтому:
    # - если cookie есть и он отличается от state — считаем это ошибкой;
    # - если cookie отсутствует, но code/state пришли от Google, продолжаем,
    #   только логируем предупреждение.
    if cookie_state:
        if cookie_state != state:
            raise HTTPException(status_code=400, detail='Некорректный state для Google OAuth')
    else:
        logger.warning('Google OAuth callback without state cookie; continuing without CSRF check')

    # Обмениваем code на access_token и id_token.
    token_data = urllib.parse.urlencode(
        {
            'code': code,
            'client_id': GOOGLE_CLIENT_ID,
            'client_secret': GOOGLE_CLIENT_SECRET,
            'redirect_uri': GOOGLE_REDIRECT_URI,
            'grant_type': 'authorization_code',
        },
    ).encode('utf-8')
    try:
        token_req = urllib.request.Request(
            'https://oauth2.googleapis.com/token',
            data=token_data,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
        )
        with urllib.request.urlopen(token_req, timeout=10) as resp:
            token_info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to exchange code for token: %s', exc)
        raise HTTPException(status_code=502, detail='Не удалось связаться с Google (token)')

    access_token = token_info.get('access_token')
    if not access_token:
        raise HTTPException(status_code=400, detail='Google не вернул access_token')

    # Запрашиваем данные пользователя.
    try:
        user_req = urllib.request.Request(
            'https://openidconnect.googleapis.com/v1/userinfo',
            headers={'Authorization': f'Bearer {access_token}'},
        )
        with urllib.request.urlopen(user_req, timeout=10) as resp:
            user_info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to fetch Google userinfo: %s', exc)
        raise HTTPException(status_code=502, detail='Не удалось получить профиль Google')

    email = (user_info.get('email') or '').strip().lower()
    name = (user_info.get('name') or '').strip() or None
    if not email:
        raise HTTPException(status_code=400, detail='Google не вернул email')

    # Для администратора: логиним существующего пользователя "kirill"
    # по Google-аккаунту с email kirillnad@gmail.com.
    admin_user: User | None = None
    if email == 'kirillnad@gmail.com':
        try:
            admin_user = get_user_by_username('kirill')
        except Exception:  # noqa: BLE001
            admin_user = None

    if admin_user:
        user = admin_user
    else:
        # Для остальных пользователей Google-логин мапится на
        # одного и того же локального пользователя с username == email.
        # Если такой пользователь уже есть — переиспользуем его.
        # Если нет — создаём нового без всяких суффиксов +g1/+g2.
        existing = get_user_by_username(email)
        if existing:
            user = existing
        else:
            random_pwd = os.urandom(16).hex()
            user = create_user(email, random_pwd, name or email, is_superuser=False)

    # Для нового (или только что найденного) пользователя гарантируем
    # наличие стартовой статьи «Руководство пользователя».
    try:
        ensure_help_article_for_user(user.id)
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to ensure help article after Google auth for %s: %r', user.id, exc)

    # Создаём сессию и редиректим в SPA.
    sid = create_session(user.id)
    redirect = RedirectResponse(url='/', status_code=302)
    set_session_cookie(redirect, sid)
    # Удаляем одноразовый state.
    redirect.delete_cookie('google_oauth_state', path='/')
    return redirect


# Вынесено из app/main.py → app/routers/oauth.py (GET /api/auth/yandex/login)
def yandex_login(request: Request):
    """
    Запускает OAuth-авторизацию через Яндекс ID:
    редиректит пользователя на oauth.yandex.ru/authorize.
    """
    if not YANDEX_CLIENT_ID or not YANDEX_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail='Yandex OAuth не настроен')

    state = os.urandom(16).hex()
    params = {
        'response_type': 'code',
        'client_id': YANDEX_CLIENT_ID,
        'redirect_uri': YANDEX_REDIRECT_URI,
        # Email + доступ к app‑папке на Диске.
        # В настройках OAuth‑клиента должны быть разрешения:
        #  - login:email
        #  - cloud_api:disk.app_folder
        'scope': 'login:email cloud_api:disk.app_folder',
        'state': state,
    }
    response = RedirectResponse(
        url='https://oauth.yandex.ru/authorize?' + urllib.parse.urlencode(params),
    )
    response.set_cookie(
        key='yandex_oauth_state',
        value=state,
        httponly=True,
        secure=False,
        samesite='lax',
        path='/',
    )
    return response


# Вынесено из app/main.py → app/routers/oauth.py (GET /auth/yandex/callback)
def yandex_callback(request: Request):
    """
    Обрабатывает колбек от Яндекса:
    - проверяет state;
    - обменивает code на токены;
    - получает email/uid пользователя;
    - находит/создаёт пользователя и создаёт сессию;
    - сохраняет access_token Яндекса, чтобы позже работать с Диском;
    - редиректит в SPA.
    """
    if not YANDEX_CLIENT_ID or not YANDEX_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail='Yandex OAuth не настроен')

    params = dict(request.query_params)
    error = params.get('error')
    if error:
      logger.warning('Yandex OAuth error: %s', error)
      raise HTTPException(status_code=400, detail=f'Ошибка Yandex OAuth: {error}')

    code = params.get('code') or ''
    state = params.get('state') or ''
    if not code:
        raise HTTPException(status_code=400, detail='Не передан code от Яндекса')

    cookie_state = request.cookies.get('yandex_oauth_state') or ''
    if cookie_state:
        if cookie_state != state:
            raise HTTPException(status_code=400, detail='Некорректный state для Yandex OAuth')
    else:
        logger.warning('Yandex OAuth callback без state cookie; продолжаем без CSRF-проверки')

    token_data = urllib.parse.urlencode(
        {
            'grant_type': 'authorization_code',
            'code': code,
            'client_id': YANDEX_CLIENT_ID,
            'client_secret': YANDEX_CLIENT_SECRET,
        },
    ).encode('utf-8')
    try:
        token_req = urllib.request.Request(
            'https://oauth.yandex.ru/token',
            data=token_data,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
        )
        with urllib.request.urlopen(token_req, timeout=10) as resp:
            token_info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to exchange Yandex code for token: %s', exc)
        raise HTTPException(status_code=502, detail='Не удалось связаться с Яндексом (token)')

    access_token = token_info.get('access_token')
    if not access_token:
        raise HTTPException(status_code=400, detail='Яндекс не вернул access_token')
    refresh_token = token_info.get('refresh_token') or None
    expires_in = token_info.get('expires_in')

    expires_at = None
    if expires_in:
        try:
            expires_at = (datetime.utcnow() + timedelta(seconds=int(expires_in))).isoformat()
        except Exception:  # noqa: BLE001
            expires_at = None

    # Профиль пользователя Яндекса.
    try:
        user_req = urllib.request.Request(
            'https://login.yandex.ru/info?format=json',
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(user_req, timeout=10) as resp:
            user_info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to fetch Yandex userinfo: %s', exc)
        raise HTTPException(status_code=502, detail='Не удалось получить профиль Яндекса')

    email = (user_info.get('default_email') or '').strip().lower()
    uid = str(user_info.get('id') or '') or ''
    if not email and not uid:
        raise HTTPException(status_code=400, detail='Яндекс не вернул идентификатор пользователя')

    # Для администратора: логиним существующего пользователя "kirill"
    # по Яндекс-аккаунту с email kirillnad@yandex.ru.
    admin_user: User | None = None
    if email == 'kirillnad@yandex.ru':
        try:
            admin_user = get_user_by_username('kirill')
        except Exception:  # noqa: BLE001
            admin_user = None

    if admin_user:
        user = admin_user
    else:
        # Используем email, если он есть, иначе стабильный uid.
        username = email or f'yandex:{uid}'
        display_name = (user_info.get('real_name') or username) or None

        existing = get_user_by_username(username)
        if existing:
            user = existing
        else:
            random_pwd = os.urandom(16).hex()
            user = create_user(username, random_pwd, display_name, is_superuser=False)

    # Сохраняем токены Яндекса для этого пользователя (для дальнейшей работы с Диском).
    # В качестве базового корня для файлов используем app‑папку.
    upsert_yandex_tokens(user.id, access_token, refresh_token, expires_at, disk_root=YANDEX_DISK_APP_ROOT)

    try:
        ensure_help_article_for_user(user.id)
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to ensure help article after Yandex auth for %s: %r', user.id, exc)

    sid = create_session(user.id)
    redirect = RedirectResponse(url='/', status_code=302)
    set_session_cookie(redirect, sid)
    redirect.delete_cookie('yandex_oauth_state', path='/')
    return redirect


# Вынесено из app/main.py → app/routers/yandex_disk.py (GET /api/yandex/disk/app-root)
def yandex_app_root(current_user: User = Depends(get_current_user)):
    """
    Тестовый эндпоинт для проверки интеграции с Яндекс.Диском.
    Возвращает метаданные app‑папки (path=app:/) по access_token текущего пользователя.
    """
    tokens = get_yandex_tokens(current_user.id)
    access_token = tokens.get('accessToken') if tokens else None
    if not access_token:
        raise HTTPException(status_code=400, detail='Интеграция с Яндекс.Диском не настроена')

    try:
        encoded_path = urllib.parse.quote(YANDEX_DISK_APP_ROOT, safe='')
        req = urllib.request.Request(
            f'https://cloud-api.yandex.net/v1/disk/resources?path={encoded_path}',
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to fetch Yandex Disk app folder: %r', exc)
        raise HTTPException(status_code=502, detail='Не удалось обратиться к Яндекс.Диску')

    return info


# Вынесено из app/main.py → app/routers/yandex_disk.py (POST /api/yandex/disk/upload-url)
def yandex_upload_url(payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    """
    Возвращает URL для загрузки файла в app‑папку Яндекс.Диска текущего пользователя.

    Ожидает JSON:
      {
        "filename": "report.pdf",
        "articleId": "<optional>",
        "overwrite": false
      }

    Возвращает:
      {
        "href": "<upload_url>",
        "method": "PUT" | ...,
        "path": "app:/.../report.pdf"
      }
    """
    tokens = get_yandex_tokens(current_user.id)
    access_token = tokens.get('accessToken') if tokens else None
    disk_root = (tokens.get('diskRoot') if tokens else None) or YANDEX_DISK_APP_ROOT or 'app:/'
    if not access_token:
        raise HTTPException(status_code=400, detail='Интеграция с Яндекс.Диском не настроена')

    filename = (payload.get('filename') or '').strip()
    if not filename:
        raise HTTPException(status_code=400, detail='Не указано имя файла')
    # Простая санация имени файла.
    safe_name = ''.join(ch if ch not in '/\\' else '_' for ch in filename)

    # Дополнительные метаданные файла от клиента для сравнения
    size_val = payload.get('size')
    size_int: int | None
    try:
        size_int = int(size_val) if size_val is not None else None
    except Exception:  # noqa: BLE001
        size_int = None

    base = disk_root.rstrip('/')
    # Складываем файлы плоско в корень папки приложения,
    # чтобы пользователю было проще управлять ими в Memus.pro на Диске.
    target_path = f'{base}/{safe_name}'

    # 1. Проверяем, есть ли уже файл с таким именем, и если есть — совпадает ли содержимое.
    exists = False
    same = False
    remote_size: int | None = None
    encoded_target = urllib.parse.quote(target_path, safe='')
    # Нас в первую очередь интересует размер; его достаточно для
    # дедупликации «пользователь, скорее всего, загрузил тот же файл».
    meta_url = f'https://cloud-api.yandex.net/v1/disk/resources?path={encoded_target}&fields=size'
    try:
        meta_req = urllib.request.Request(
            meta_url,
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(meta_req, timeout=10) as resp:
            meta = json.loads(resp.read().decode('utf-8'))
        exists = True
        remote_size = meta.get('size')
        if size_int is not None and isinstance(remote_size, int) and remote_size == size_int:
            same = True
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            exists = False
        else:
            logger.error('Failed to check Yandex Disk resource meta: %r', exc)
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to check Yandex Disk resource meta: %r', exc)

    # Если файл уже есть и содержимое совпадает — повторно не загружаем,
    # просто даём понять клиенту, что можно использовать существующий ресурс.
    if exists and same:
        return {
            'href': None,
            'method': None,
            'path': target_path,
            'exists': True,
            'same': True,
            'size': remote_size,
        }

    # 2. Если файл с таким именем есть, но содержимое другое — подбираем свободное имя.
    candidate_name = safe_name
    name_root, ext = os.path.splitext(safe_name)
    suffix = 2
    final_path = target_path
    if exists:
        while True:
            candidate_name = f'{name_root} ({suffix}){ext}'
            candidate_path = f'{base}/{candidate_name}'
            encoded_candidate = urllib.parse.quote(candidate_path, safe='')
            check_url = f'https://cloud-api.yandex.net/v1/disk/resources?path={encoded_candidate}&fields=size'
            try:
                check_req = urllib.request.Request(
                    check_url,
                    headers={'Authorization': f'OAuth {access_token}'},
                )
                with urllib.request.urlopen(check_req, timeout=10) as resp:
                    _ = resp.read()
                # Файл существует — пробуем следующий суффикс.
                suffix += 1
                if suffix > 50:
                    # Защитимся от бесконечного цикла.
                    break
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    final_path = candidate_path
                    break
                logger.error('Failed to probe Yandex Disk name candidate: %r', exc)
                break
            except Exception as exc:  # noqa: BLE001
                logger.error('Failed to probe Yandex Disk name candidate: %r', exc)
                break
    else:
        final_path = target_path

    overwrite = bool(payload.get('overwrite'))
    query = urllib.parse.urlencode(
        {
            'path': final_path,
            'overwrite': 'true' if overwrite else 'false',
        },
    )
    try:
        req = urllib.request.Request(
            f'https://cloud-api.yandex.net/v1/disk/resources/upload?{query}',
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to get Yandex Disk upload URL: %r', exc)
        raise HTTPException(status_code=502, detail='Не удалось получить URL загрузки на Яндекс.Диск')

    href = data.get('href') or ''
    method = (data.get('method') or 'PUT').upper()
    if not href:
        raise HTTPException(status_code=502, detail='Яндекс.Диск не вернул ссылку для загрузки')
    return {
        'href': href,
        'method': method,
        'path': final_path,
        'exists': exists,
        'same': same,
    }
# Вынесено из app/main.py → app/yandex_disk_utils.py (_upload_bytes_to_yandex_for_user)


# Вынесено из app/main.py → app/routers/yandex_disk.py (GET /api/yandex/disk/file)
def yandex_open_file(path: str = Query(..., description='Путь ресурса на Яндекс.Диске (app:/ или disk:/)'), current_user: User = Depends(get_current_user)):
    """
    Проксирует скачивание файла с Яндекс.Диска через API.

    Принимает логический путь (app:/... или disk:/...) и:
      - по access_token текущего пользователя запрашивает href для скачивания;
      - делает редирект на этот href.

    Это позволяет открывать вложения из app‑папки без необходимости
    угадывать URL веб‑интерфейса Диска.
    """
    tokens = get_yandex_tokens(current_user.id)
    access_token = tokens.get('accessToken') if tokens else None
    if not access_token:
        raise HTTPException(status_code=400, detail='Интеграция с Яндекс.Диском не настроена')

    disk_path = (path or '').strip()
    if not disk_path:
        raise HTTPException(status_code=400, detail='Не указан путь на Яндекс.Диске')

    encoded = urllib.parse.quote(disk_path, safe='')

    # 1. Если у ресурса уже есть публичная ссылка (пользователь делился им в интерфейсе),
    #    просто перенаправляем на неё — так файл открывается в приложении/веб‑просмотрщике.
    meta_url = f'https://cloud-api.yandex.net/v1/disk/resources?path={encoded}&fields=public_url'
    public_url: str | None = None
    try:
        meta_req = urllib.request.Request(
            meta_url,
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(meta_req, timeout=10) as resp:
            meta = json.loads(resp.read().decode('utf-8'))
        public_url = meta.get('public_url') or None
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(status_code=404, detail='Файл на Яндекс.Диске не найден')
        logger.error('Failed to fetch Yandex Disk resource meta: %r', exc)
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to fetch Yandex Disk resource meta: %r', exc)

    if public_url:
        return RedirectResponse(public_url)

    # 2. Публичной ссылки нет — публикуем ресурс, чтобы получить
    #    стабильный public_url (disk.yandex.ru/d/...), который
    #    открывается в соответствующем приложении/просмотрщике.
    publish_url = f'https://cloud-api.yandex.net/v1/disk/resources/publish?path={encoded}'
    try:
        pub_req = urllib.request.Request(
            publish_url,
            method='PUT',
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(pub_req, timeout=10) as resp:
            pub_data = json.loads(resp.read().decode('utf-8'))
        public_url = pub_data.get('public_url') or None
    except urllib.error.HTTPError as exc:
        logger.error('Failed to publish Yandex Disk resource: %r', exc)
        if exc.code == 404:
            raise HTTPException(status_code=404, detail='Файл на Яндекс.Диске не найден')
        # Если публикация не удалась по другой причине — пробуем ещё раз прочитать мету.
        try:
            meta_req = urllib.request.Request(
                meta_url,
                headers={'Authorization': f'OAuth {access_token}'},
            )
            with urllib.request.urlopen(meta_req, timeout=10) as resp:
                meta = json.loads(resp.read().decode('utf-8'))
            public_url = meta.get('public_url') or None
        except Exception as exc2:  # noqa: BLE001
            logger.error('Failed to refetch Yandex Disk resource meta after publish error: %r', exc2)
            raise HTTPException(status_code=502, detail='Не удалось опубликовать файл на Яндекс.Диске')
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to publish Yandex Disk resource: %r', exc)
        raise HTTPException(status_code=502, detail='Не удалось опубликовать файл на Яндекс.Диске')

    # На практике Яндекс.Диск иногда не возвращает public_url сразу в ответе на publish,
    # хотя ссылка появляется в метаданных чуть позже. Чтобы не заставлять пользователя
    # кликать второй раз, пробуем ещё раз прочитать мету.
    if not public_url:
        try:
            meta_req = urllib.request.Request(
                meta_url,
                headers={'Authorization': f'OAuth {access_token}'},
            )
            with urllib.request.urlopen(meta_req, timeout=10) as resp:
                meta = json.loads(resp.read().decode('utf-8'))
            public_url = meta.get('public_url') or None
        except Exception as exc:  # noqa: BLE001
            logger.error('Failed to refetch Yandex Disk resource meta after publish success: %r', exc)

    # Если даже после повторного чтения метаданных нет public_url, делаем
    # запасной вариант — прямую ссылку на скачивание через resources/download.
    if not public_url:
        download_url = f'https://cloud-api.yandex.net/v1/disk/resources/download?path={encoded}'
        try:
            dl_req = urllib.request.Request(
                download_url,
                headers={'Authorization': f'OAuth {access_token}'},
            )
            with urllib.request.urlopen(dl_req, timeout=10) as resp:
                dl_data = json.loads(resp.read().decode('utf-8'))
            href = dl_data.get('href') or None
            if href:
                return RedirectResponse(href)
        except urllib.error.HTTPError as exc:  # noqa: BLE001
            logger.error('Failed to get Yandex Disk download href: %r', exc)
            if exc.code == 404:
                raise HTTPException(status_code=404, detail='Файл на Яндекс.Диске не найден')
        except Exception as exc:  # noqa: BLE001
            logger.error('Failed to get Yandex Disk download href: %r', exc)

    if not public_url:
        raise HTTPException(status_code=502, detail='Яндекс.Диск не вернул публичную ссылку')

    return RedirectResponse(public_url)
@app.middleware('http')
async def spa_fallback_middleware(request: Request, call_next):
    """
    SPA-фолбек: для любых не-API и не-upload маршрутов без расширения
    возвращаем index.html, чтобы клиентский роутинг работал (например, /article/123).
    """
    response = await call_next(request)
    if response.status_code != 404:
        return response
    path = PurePath(request.url.path)
    if request.url.path.startswith('/api') or request.url.path.startswith('/uploads'):
        return response
    if path.suffix:
        return response
    index_path = CLIENT_DIR / 'index.html'
    if not index_path.is_file():
        return response
    return FileResponse(index_path)


# Password-based auth endpoints временно выключены: оставляем код ниже без роутинга,
# чтобы при необходимости можно было быстро вернуть функциональность.

def legacy_register(payload: dict[str, Any], response: Response):  # pragma: no cover - legacy
    username = (payload.get('username') or '').strip()
    password = payload.get('password') or ''
    display_name = (payload.get('displayName') or '').strip() or None
    if not username or not password:
        raise HTTPException(status_code=400, detail='Username and password are required')
    existing = get_user_by_username(username)
    if existing:
        raise HTTPException(status_code=400, detail='Username already taken')
    user = create_user(username, password, display_name)
    try:
        ensure_help_article_for_user(user.id)
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to ensure help article after legacy register for %s: %r', user.id, exc)
    sid = create_session(user.id)
    set_session_cookie(response, sid)
    return {
        'id': user.id,
        'username': user.username,
        'displayName': user.display_name,
        'isSuperuser': bool(getattr(user, 'is_superuser', False)),
    }


def legacy_login(payload: dict[str, Any], response: Response):  # pragma: no cover - legacy
    username = (payload.get('username') or '').strip()
    password = payload.get('password') or ''
    if not username or not password:
        raise HTTPException(status_code=400, detail='Username and password are required')
    row = get_user_by_username(username)
    if not row:
        raise HTTPException(status_code=401, detail='Invalid credentials')
    stored = CONN.execute(
        'SELECT password_hash FROM users WHERE id = ?',
        (row.id,),
    ).fetchone()
    if not stored or not verify_password(password, stored['password_hash']):
        raise HTTPException(status_code=401, detail='Invalid credentials')
    sid = create_session(row.id)
    set_session_cookie(response, sid)
    return {
        'id': row.id,
        'username': row.username,
        'displayName': row.display_name,
        'isSuperuser': bool(getattr(row, 'is_superuser', False)),
    }


# Вынесено из app/main.py → app/routers/telegram.py (POST /api/telegram/link-token)
def telegram_create_link_token(current_user: User = Depends(get_current_user)):
    """
    Создаёт одноразовый токен для привязки текущего пользователя к Telegram‑чату.

    Поток:
      1) пользователь в Memus вызывает этот эндпоинт (через UI);
      2) получает token и отправляет боту команду: /link <token>;
      3) бот сохраняет соответствие chat_id → user_id в telegram_links.
    """
    # Для смысловой привязки хотим, чтобы у пользователя уже был настроен Яндекс.Диск,
    # иначе вложения из Telegram всё равно некуда сохранять.
    tokens = get_yandex_tokens(current_user.id)
    if not tokens or not tokens.get('accessToken'):
        raise HTTPException(
            status_code=400,
            detail='Сначала настройте интеграцию с Яндекс.Диском, затем привязывайте Telegram.',
        )

    now = datetime.utcnow()
    # Срок действия токена, чтобы коды не висели вечно.
    expires_at = now + timedelta(hours=1)
    raw = os.urandom(18)
    token = base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=\n')
    with CONN:
        CONN.execute(
            '''
            INSERT INTO telegram_link_tokens (token, user_id, created_at, expires_at)
            VALUES (?, ?, ?, ?)
            ''',
            (token, current_user.id, now.isoformat(), expires_at.isoformat()),
        )
    return {'token': token, 'expiresAt': expires_at.isoformat()}


# Вынесено из app/main.py → app/routers/telegram.py (POST /api/telegram/webhook/{token})
def telegram_webhook(token: str, payload: dict[str, Any]):
    """
    Webhook для Telegram‑бота быстрых заметок.

    Ожидает JSON update от Telegram. Для простоты авторизацию делаем по токену
    в URL: /api/telegram/webhook/<TELEGRAM_BOT_TOKEN>.
    """
    if not TELEGRAM_BOT_TOKEN:
        raise HTTPException(status_code=503, detail='Telegram bot не настроен (нет TELEGRAM_BOT_TOKEN)')
    if token != TELEGRAM_BOT_TOKEN:
        raise HTTPException(status_code=403, detail='Invalid token')

    try:
        message = (
            payload.get('message')
            or payload.get('edited_message')
            or payload.get('channel_post')
            or payload.get('edited_channel_post')
        )
        if message:
            _handle_telegram_message(message)
    except Exception as exc:  # noqa: BLE001
        logger.error('Telegram bot: unhandled error: %r', exc)

    # Telegram ждёт быстрый ответ, сам результат мы не используем.
    return {'ok': True}



# Mount client SPA after API routes so /api/* keeps working.
app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")
