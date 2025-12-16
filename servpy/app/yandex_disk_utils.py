from __future__ import annotations

import json
import logging
import os
import urllib.parse
import urllib.request
from datetime import datetime

from .auth import User
from .data_store import get_yandex_tokens
from .oauth_config import YANDEX_DISK_APP_ROOT

# Вынесено из app/main.py → app/yandex_disk_utils.py

logger = logging.getLogger('uvicorn.error')


def _upload_bytes_to_yandex_for_user(user: User, filename: str, raw: bytes, mime_type: str) -> str:
    """
    Загружает произвольные байты в app‑папку Яндекс.Диска указанного пользователя.

    Возвращает логический путь вида app:/.../<filename>, который затем можно
    использовать в attachments.stored_path.
    """
    tokens = get_yandex_tokens(user.id)
    access_token = tokens.get('accessToken') if tokens else None
    disk_root = (tokens.get('diskRoot') if tokens else None) or YANDEX_DISK_APP_ROOT or 'app:/'
    if not access_token:
        raise RuntimeError('Интеграция с Яндекс.Диском не настроена для этого пользователя')

    safe_base = (filename or 'attachment').strip() or 'attachment'
    safe_base = ''.join(ch if ch not in '/\\' else '_' for ch in safe_base)
    # Делаем имя уникальным, чтобы не было конфликтов.
    ts = int(datetime.utcnow().timestamp() * 1000)
    unique_name = f'{ts}-{os.urandom(4).hex()}-{safe_base}'

    base = (disk_root or 'app:/').rstrip('/')
    final_path = f'{base}/{unique_name}'

    query = urllib.parse.urlencode({'path': final_path, 'overwrite': 'false'})
    upload_url = f'https://cloud-api.yandex.net/v1/disk/resources/upload?{query}'
    try:
        req = urllib.request.Request(
            upload_url,
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Telegram bot: failed to get Yandex upload URL for %s: %r', final_path, exc)
        raise RuntimeError('Не удалось получить URL загрузки на Яндекс.Диск') from exc

    href = data.get('href') or ''
    method = (data.get('method') or 'PUT').upper()
    if not href:
        raise RuntimeError('Яндекс.Диск не вернул ссылку для загрузки')

    try:
        upload_req = urllib.request.Request(
            href,
            data=raw,
            method=method,
            headers={'Content-Type': mime_type or 'application/octet-stream'},
        )
        with urllib.request.urlopen(upload_req, timeout=60):
            pass
    except Exception as exc:  # noqa: BLE001
        logger.error('Telegram bot: failed to upload bytes to %s: %r', final_path, exc)
        raise RuntimeError('Не удалось загрузить файл на Яндекс.Диск') from exc

    return final_path

