from __future__ import annotations

import base64
import html as html_mod
import json
import logging
import os
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import PurePosixPath
from typing import Any
from uuid import uuid4

from .auth import User, get_user_by_id
from .db import CONN, IS_SQLITE
from .data_store import create_attachment, get_or_create_user_inbox, insert_block, save_article
from .import_assets import _save_image_bytes_for_user
from .yandex_disk_utils import _upload_bytes_to_yandex_for_user

# Вынесено из app/main.py → app/telegram_bot.py

logger = logging.getLogger('uvicorn.error')

# Настройки телеграм‑бота для быстрых заметок.
# TELEGRAM_BOT_TOKEN       — токен бота из BotFather (обязателен для работы бота).
# TELEGRAM_ALLOWED_CHAT_ID — необязательный фильтр: ID чата, из которого принимаем сообщения.
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN') or ''
TELEGRAM_ALLOWED_CHAT_ID = os.environ.get('TELEGRAM_ALLOWED_CHAT_ID') or ''

_telegram_link_cache: dict[str, str] = {}


def _telegram_download_file(file_id: str) -> tuple[bytes, str, str]:
    """
    Скачивает файл из Telegram по file_id.
    Возвращает (raw_bytes, filename, mime_type).
    """
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError('Telegram bot token не настроен')
    api_base = f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}'
    try:
        params = urllib.parse.urlencode({'file_id': file_id})
        req = urllib.request.Request(f'{api_base}/getFile?{params}')
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Telegram bot: getFile error for %s: %r', file_id, exc)
        raise RuntimeError('Не удалось получить путь к файлу Telegram')

    if not isinstance(data, dict) or not data.get('ok') or 'result' not in data:
        raise RuntimeError('Telegram bot: getFile вернул некорректный ответ')

    result = data['result'] or {}
    file_path = result.get('file_path') or ''
    if not file_path:
        raise RuntimeError('Telegram bot: getFile не вернул file_path')

    download_url = f'https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}'
    try:
        with urllib.request.urlopen(download_url, timeout=60) as resp:
            raw = resp.read()
            mime_type = resp.info().get_content_type() or 'application/octet-stream'
    except Exception as exc:  # noqa: BLE001
        logger.error('Telegram bot: download error for %s: %r', file_path, exc)
        raise RuntimeError('Не удалось скачать файл из Telegram')

    filename = PurePosixPath(file_path).name or 'file'
    return raw, filename, mime_type


def _telegram_send_message(chat_id: int | str, text: str) -> None:
    """
    Отправляет простое текстовое сообщение в Telegram в ответ на апдейт.
    Ошибки логируем, но не пробрасываем наружу.
    """
    if not TELEGRAM_BOT_TOKEN:
        return
    api_url = f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage'
    payload = {
        'chat_id': str(chat_id),
        'text': text,
    }
    try:
        body = urllib.parse.urlencode(payload).encode('utf-8')
        req = urllib.request.Request(
            api_url,
            data=body,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
        )
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception as exc:  # noqa: BLE001
        logger.error('Telegram bot: sendMessage error: %r', exc)


def _handle_telegram_message(message: dict[str, Any]) -> None:
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
                if IS_SQLITE:
                    CONN.execute(
                        '''
                        INSERT INTO telegram_links (chat_id, user_id, created_at)
                        VALUES (?, ?, ?)
                        ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, created_at = excluded.created_at
                        ''',
                        (chat_key, user_id, now_iso),
                    )
                else:
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


def process_telegram_update(payload: dict[str, Any]) -> None:
    """
    Принимает Telegram update (JSON) и обрабатывает поддерживаемые типы сообщений.
    """
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


def create_link_token_for_user(user_id: str) -> dict[str, str]:
    """
    Создаёт одноразовый токен для привязки пользователя Memus к Telegram-чату.
    """
    now = datetime.utcnow()
    expires_at = now + timedelta(hours=1)
    raw = os.urandom(18)
    token = base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=\n')
    with CONN:
        CONN.execute(
            '''
            INSERT INTO telegram_link_tokens (token, user_id, created_at, expires_at)
            VALUES (?, ?, ?, ?)
            ''',
            (token, user_id, now.isoformat(), expires_at.isoformat()),
        )
    return {'token': token, 'expiresAt': expires_at.isoformat()}

