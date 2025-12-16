from __future__ import annotations

import html as html_mod
import logging
import mimetypes
import re
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import uuid4

import aiofiles
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile

from ..auth import User, get_current_user, get_user_by_id
from ..db import CONN
from ..data_store import _expand_wikilinks, delete_article, get_article, save_article
from ..import_assets import UPLOADS_DIR, _import_attachment_from_bytes
from ..import_utils import _parse_markdown_blocks, _walk_blocks

router = APIRouter()
logger = logging.getLogger('uvicorn.error')

# Вынесено из app/main.py → app/routers/import_logseq.py
# Состояние фоновых задач импорта Logseq (в памяти процесса).
LOGSEQ_IMPORT_TASKS: dict[str, dict[str, Any]] = {}


# Вынесено из app/main.py → app/routers/import_logseq.py
@router.post('/api/import/logseq/upload')
async def upload_logseq_archive(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Быстрая загрузка ZIP-архива Logseq на сервер без длительной обработки.
    Возвращает идентификатор архива, который затем можно передать в /api/import/logseq/start.
    """
    filename = file.filename or ''
    if not filename.lower().endswith('.zip'):
        raise HTTPException(status_code=400, detail='Ожидается ZIP-архив Logseq (.zip)')

    user_root = UPLOADS_DIR / current_user.id / 'logseq_archives'
    user_root.mkdir(parents=True, exist_ok=True)
    archive_id = uuid4().hex
    dest_path = user_root / f'{archive_id}.zip'

    # Потоковая запись файла на диск, чтобы не держать всё в памяти.
    async with aiofiles.open(dest_path, 'wb') as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            await out.write(chunk)

    return {
        'archiveId': archive_id,
        'originalName': filename,
    }


# Вынесено из app/main.py → app/routers/import_logseq.py
def _run_logseq_import_task(task_id: str, user_id: str, archive_path_str: str, assets_base_url: str | None) -> None:
    """
    Фоновая задача: читает сохранённый ZIP-архив Logseq и запускает импорт.
    """
    task = LOGSEQ_IMPORT_TASKS.get(task_id)
    if not task:
        return
    task['status'] = 'running'
    task['updatedAt'] = datetime.utcnow().isoformat()

    archive_path = Path(archive_path_str)
    try:
        user = get_user_by_id(user_id)
        if not user:
            raise RuntimeError('Пользователь не найден для задачи импорта Logseq')
        raw = archive_path.read_bytes()
        articles = _import_logseq_from_bytes(raw, archive_path.name, assets_base_url, user)
        task['status'] = 'completed'
        task['updatedAt'] = datetime.utcnow().isoformat()
        task['articles'] = [
            {
                'id': a.get('id'),
                'title': a.get('title'),
                'updatedAt': a.get('updatedAt'),
            }
            for a in (articles or [])
            if isinstance(a, dict) and a.get('id')
        ]
        task['error'] = None
    except Exception as exc:  # noqa: BLE001
        logger.error('Logseq import task %s failed: %r', task_id, exc)
        task['status'] = 'failed'
        task['updatedAt'] = datetime.utcnow().isoformat()
        task['error'] = str(exc)
        task['articles'] = []
    finally:
        # Пытаемся удалить архив, чтобы не засорять диск.
        try:
            archive_path.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass


# Вынесено из app/main.py → app/routers/import_logseq.py
@router.post('/api/import/logseq/start')
def start_logseq_import(
    payload: dict[str, Any],
    background: BackgroundTasks,
    current_user: User = Depends(get_current_user),
):
    """
    Запускает фоновую задачу импорта Logseq из ранее загруженного архива.
    """
    archive_id = (payload.get('archiveId') or '').strip()
    assets_base_url = (payload.get('assetsBaseUrl') or '').strip() or None
    if not archive_id:
        raise HTTPException(status_code=400, detail='archiveId обязателен')

    archive_path = UPLOADS_DIR / current_user.id / 'logseq_archives' / f'{archive_id}.zip'
    if not archive_path.is_file():
        raise HTTPException(status_code=404, detail='Архив не найден')

    task_id = uuid4().hex
    now = datetime.utcnow().isoformat()
    LOGSEQ_IMPORT_TASKS[task_id] = {
        'id': task_id,
        'userId': current_user.id,
        'archiveId': archive_id,
        'status': 'pending',
        'createdAt': now,
        'updatedAt': now,
        'error': None,
        'articles': [],
    }

    background.add_task(_run_logseq_import_task, task_id, current_user.id, str(archive_path), assets_base_url)

    return {'taskId': task_id}


# Вынесено из app/main.py → app/routers/import_logseq.py
@router.get('/api/import/logseq/status/{task_id}')
def get_logseq_import_status(task_id: str, current_user: User = Depends(get_current_user)):
    """
    Возвращает состояние фоновой задачи импорта Logseq.
    """
    task = LOGSEQ_IMPORT_TASKS.get(task_id)
    if not task or task.get('userId') != current_user.id:
        raise HTTPException(status_code=404, detail='Задача не найдена')
    result: dict[str, Any] = {
        'id': task['id'],
        'status': task['status'],
        'createdAt': task['createdAt'],
        'updatedAt': task['updatedAt'],
        'error': task.get('error'),
    }
    if task['status'] == 'completed':
        result['articles'] = task.get('articles') or []
    return result


# Вынесено из app/main.py → app/routers/import_logseq.py
def _import_logseq_from_bytes(
    raw: bytes,
    filename: str,
    assets_base_url: str | None,
    current_user: User,
) -> list[dict[str, Any]]:
    """
    Общая реализация импорта Logseq из ZIP-архива.

    Используется как синхронным API-эндпоинтом, так и фоновыми задачами.
    """
    filename_lc = (filename or '').lower()
    if not filename_lc.endswith('.zip'):
        raise HTTPException(status_code=400, detail='Ожидается ZIP-архив Logseq (pages/ и assets/)')

    # Защита от слишком больших архивов (например, > 1 ГБ).
    max_size = 1024 * 1024 * 1024  # 1 GiB
    if len(raw) > max_size:
        raise HTTPException(
            status_code=400,
            detail='Архив Logseq слишком большой (максимум 1 ГБ)',
        )
    try:
        zf = zipfile.ZipFile(BytesIO(raw))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail='Не удалось прочитать ZIP-архив') from exc

    page_entries: list[zipfile.ZipInfo] = []
    asset_entries: dict[str, zipfile.ZipInfo] = {}
    has_non_utf8_names = False

    for info in zf.infolist():
        name = info.filename or ''
        if not name or info.is_dir():
            continue
        # Если в имени есть не-ASCII символы и не установлен UTF-8-флаг,
        # считаем, что архив собран без поддержки UTF-8.
        if any(ord(ch) > 127 for ch in name) and not (info.flag_bits & 0x800):
            has_non_utf8_names = True
        path = PurePosixPath(name)
        parts = path.parts
        if not parts:
            continue
        top = parts[0].lower()
        if top == 'pages' and path.suffix.lower() in {'.md', '.markdown', '.txt'}:
            page_entries.append(info)
        elif top == 'assets':
            # Ключ: путь внутри assets/
            rel = PurePosixPath(*parts[1:]).as_posix()
            asset_entries[rel] = info

    if has_non_utf8_names:
        raise HTTPException(
            status_code=400,
            detail=(
                'Собери ZIP через PeaZip (https://peazip.github.io/)'
                'с кодировкой имён файлов в UTF-8.'
            ),
        )

    if not page_entries:
        raise HTTPException(status_code=400, detail='В архиве не найдено ни одной страницы в папке pages/')

    imported_articles: list[dict[str, Any]] = []

    base_url = (assets_base_url or '').strip().rstrip('/') or None

    # Если базовый URL задан, но в архиве нет assets/,
    # явно логируем, что будем использовать только внешний источник.
    if base_url and not asset_entries:
        print(
            '[logseq_import] assetsBaseUrl задан, но папка assets/ в архиве не найдена; '
            'вложения будут подтягиваться только по внешнему URL:',
            base_url,
        )

    def _resolve_assets_in_html(html_text: str, article_id: str) -> str:
        """
        Ищет ссылки вида href="...assets/..." и, если файл есть в архиве,
        сохраняет его в uploads/attachments и переписывает href на внутренний путь.
        """

        def _replace_href(match: re.Match[str]) -> str:
            href = match.group(1) or ''
            href_stripped = href.strip()
            if not href_stripped:
                return match.group(0)
            # Уже внутренние uploads не трогаем.
            if href_stripped.startswith('/uploads/'):
                return match.group(0)

            # Пытаемся найти сегмент "assets" в относительном пути.
            parts = list(PurePosixPath(href_stripped).parts)
            if 'assets' not in parts:
                return match.group(0)
            idx = parts.index('assets')
            rel = PurePosixPath(*parts[idx + 1 :]).as_posix()
            if not rel:
                return match.group(0)

            # 1) Пробуем взять файл из assets внутри ZIP (если есть).
            info = asset_entries.get(rel)
            if info:
                try:
                    data = zf.read(info)
                except KeyError:
                    info = None
                else:
                    mime_type = mimetypes.guess_type(info.filename or '')[0] or 'application/octet-stream'
                    stored_path = _import_attachment_from_bytes(
                        data,
                        mime_type,
                        current_user,
                        article_id,
                        display_name=PurePosixPath(info.filename).name,
                    )
                    new_href = html_mod.escape(stored_path, quote=True)
                    return f'href="{new_href}"'

            # 2) Если указан внешний базовый URL, пробуем скачать оттуда.
            if base_url:
                import urllib.request
                from urllib.parse import quote, urljoin, urlsplit, urlunsplit

                # Пробуем варианты: файл лежит в корне base_url или в подпапке /assets.
                candidates = [rel, f'assets/{rel}']
                for remote_path in candidates:
                    full_url = urljoin(base_url + '/', remote_path)
                    try:
                        # Логируем URL, который пробуем подтянуть.
                        logger.info(
                            '[logseq_import] trying to fetch asset from %s for article %s',
                            full_url,
                            article_id,
                        )
                        # Корректно кодируем путь (кириллица и др.) в URL.
                        parts = urlsplit(full_url)
                        safe_path = quote(parts.path)
                        safe_url = urlunsplit((parts.scheme, parts.netloc, safe_path, parts.query, parts.fragment))
                        req = urllib.request.Request(safe_url, headers={'User-Agent': 'memus-logseq-import/1.0'})
                        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
                            data = resp.read()
                            mime_type = (
                                resp.headers.get_content_type()
                                or mimetypes.guess_type(full_url)[0]
                                or 'application/octet-stream'
                            )
                    except Exception as exc:  # noqa: BLE001
                        # Логируем неудачные попытки подтянуть вложение из внешнего assetsBaseUrl.
                        logger.warning(
                            '[logseq_import] failed to fetch asset from %s for article %s: %r',
                            full_url,
                            article_id,
                            exc,
                        )
                        continue

                    stored_path = _import_attachment_from_bytes(
                        data,
                        mime_type,
                        current_user,
                        article_id,
                        display_name=PurePosixPath(remote_path).name,
                    )
                    new_href = html_mod.escape(stored_path, quote=True)
                    return f'href="{new_href}"'

            return match.group(0)

        return re.sub(r'href="([^"]+)"', _replace_href, html_text)

    now = datetime.utcnow().isoformat()

    for info in page_entries:
        try:
            content_bytes = zf.read(info)
        except KeyError:
            continue
        try:
            md_text = content_bytes.decode('utf-8')
        except UnicodeDecodeError:
            md_text = content_bytes.decode('utf-8', errors='ignore')

        blocks_tree = _parse_markdown_blocks(md_text)
        if not blocks_tree:
            continue

        # Имя статьи = имя файла без расширения (после корректного UTF-8-декодирования в zipfile).
        title_stem = PurePosixPath(info.filename or '').stem or 'Импортированная страница'
        base_title = title_stem.strip() or 'Импортированная страница'

        # Перед созданием новой статьи удаляем все существующие статьи
        # этого пользователя с таким же заголовком (полная замена).
        try:
            existing_rows = CONN.execute(
                'SELECT id FROM articles WHERE author_id = ? AND title = ? AND deleted_at IS NULL',
                (current_user.id, base_title),
            ).fetchall()
            for row in existing_rows or []:
                try:
                    delete_article(row['id'], force=True)
                except Exception as exc:  # noqa: BLE001
                    logger.error('Failed to delete old article %s before Logseq import: %r', row['id'], exc)
        except Exception as exc:  # noqa: BLE001
            logger.error('Failed to query existing articles before Logseq import: %r', exc)

        new_article_id = str(uuid4())

        # Сначала создаём «пустую» статью, чтобы запись в articles уже существовала,
        # а затем подтягиваем вложения и только после этого сохраняем финальное дерево блоков.
        skeleton_article = {
            'id': new_article_id,
            'title': base_title,
            'createdAt': now,
            'updatedAt': now,
            'deletedAt': None,
            'blocks': [],
            'history': [],
            'redoHistory': [],
            'authorId': current_user.id,
        }
        save_article(skeleton_article)

        # Применяем переписывание ссылок на вложения для каждого блока.
        for block in _walk_blocks(blocks_tree):
            text_html = block.get('text') or ''
            if text_html:
                block['text'] = _resolve_assets_in_html(text_html, new_article_id)

        # После загрузки вложений разворачиваем wikilinks [[...]] в ссылки на статьи.
        for block in _walk_blocks(blocks_tree):
            text_html = block.get('text') or ''
            if text_html:
                block['text'] = _expand_wikilinks(text_html, current_user.id)

        article = {
            'id': new_article_id,
            'title': base_title,
            'createdAt': now,
            'updatedAt': now,
            'deletedAt': None,
            'blocks': blocks_tree,
            'history': [],
            'redoHistory': [],
            'authorId': current_user.id,
        }

        save_article(article)
        created = get_article(new_article_id, current_user.id)
        if created:
            imported_articles.append(created)

    if not imported_articles:
        raise HTTPException(status_code=400, detail='Не удалось импортировать ни одной страницы из архива Logseq')
    return imported_articles


# Вынесено из app/main.py → app/routers/import_logseq.py
@router.post('/api/import/logseq')
async def import_from_logseq(
    file: UploadFile = File(...),
    assets_base_url: str | None = Form(None, alias='assetsBaseUrl'),
    current_user: User = Depends(get_current_user),
):
    """
    Синхронный импорт Logseq (оставлен для совместимости).
    Для крупных архивов лучше использовать upload/start/status API.
    """
    raw = await file.read()
    filename = file.filename or ''
    return _import_logseq_from_bytes(raw, filename, assets_base_url, current_user)

