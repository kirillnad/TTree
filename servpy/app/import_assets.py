from __future__ import annotations

import base64
import binascii
import mimetypes
import os
from datetime import datetime
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from PIL import Image

from .auth import User
from .data_store import create_attachment

# Вынесено из app/main.py → app/import_assets.py

BASE_DIR = Path(__file__).resolve().parents[2]
UPLOADS_DIR = BASE_DIR / 'uploads'
UPLOADS_DIR.mkdir(exist_ok=True, parents=True)


def _decode_data_url(data_url: str) -> tuple[bytes, str]:
    """
    Разбирает data: URL и возвращает (bytes, mime_type).
    Ожидаем формат data:<mime>;base64,<payload>.
    """
    if not data_url.startswith('data:'):
        raise ValueError('Not a data: URL')
    try:
        header, b64data = data_url.split(',', 1)
    except ValueError as exc:
        raise ValueError('Invalid data: URL') from exc
    mime_type = 'application/octet-stream'
    meta = header[5:]  # после "data:"
    if ';' in meta:
        mime_type = meta.split(';', 1)[0] or mime_type
    elif meta:
        mime_type = meta
    try:
        raw = base64.b64decode(b64data, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError('Invalid base64 payload in data: URL') from exc
    return raw, mime_type


def _save_image_bytes_for_user(raw: bytes, mime_type: str, current_user: User) -> str:
    """
    Сохраняет картинку (сырые байты) в uploads так же, как upload_file:
    конвертирует её в WebP с качеством 75. Возвращает относительный URL /uploads/...
    """
    now = datetime.utcnow()
    user_root = UPLOADS_DIR / current_user.id / 'images'
    target_dir = user_root / str(now.year) / f"{now.month:02}"
    target_dir.mkdir(parents=True, exist_ok=True)
    # По умолчанию сохраняем в WebP.
    filename = f"{int(now.timestamp()*1000)}-{os.urandom(4).hex()}.webp"
    dest = target_dir / filename

    buffer = BytesIO(raw)
    try:
        img = Image.open(buffer)
        max_width = 1920
        if img.width > max_width:
            new_height = int(img.height * max_width / img.width)
            img = img.resize((max_width, max(new_height, 1)), Image.Resampling.LANCZOS)

        if img.mode in ('RGBA', 'LA', 'P'):
            img = img.convert('RGBA')
        else:
            img = img.convert('RGB')

        out_buf = BytesIO()
        img.save(out_buf, 'WEBP', quality=75, method=6)
        out_bytes = out_buf.getvalue()
        dest.write_bytes(out_bytes)
    except Exception:
        # Если Pillow не смог прочитать — сохраняем как есть с исходным расширением.
        ext = mimetypes.guess_extension(mime_type or '') or ''
        fallback_name = f"{int(now.timestamp()*1000)}-{os.urandom(4).hex()}{ext}"
        dest = target_dir / fallback_name
        dest.write_bytes(raw)
    rel = dest.relative_to(UPLOADS_DIR).as_posix()
    return f"/uploads/{rel}"


def _import_image_from_data_url(data_url: str, current_user: User) -> str:
    """
    Сохраняет картинку из data: URL в uploads так же, как upload_file:
    конвертирует её в WebP с качеством 75. Возвращает относительный URL /uploads/...
    """
    raw, mime_type = _decode_data_url(data_url)
    return _save_image_bytes_for_user(raw, mime_type, current_user)


def _import_attachment_from_bytes(
    raw: bytes,
    mime_type: str,
    current_user: User,
    article_id: str,
    display_name: str | None = None,
) -> str:
    """
    Сохраняет бинарные данные вложения в uploads/attachments и создаёт запись в БД.
    Возвращает относительный URL /uploads/...
    """
    target_dir = UPLOADS_DIR / current_user.id / 'attachments' / article_id
    target_dir.mkdir(parents=True, exist_ok=True)
    base_name = (display_name or 'attachment').strip() or 'attachment'
    safe_base = ''.join(ch if ch.isalnum() or ch in '._- ' else '_' for ch in base_name)[:80] or 'attachment'
    ext = mimetypes.guess_extension(mime_type) or ''
    filename = f"{safe_base}{ext}"
    # избегаем коллизий
    counter = 1
    dest = target_dir / filename
    while dest.exists():
        filename = f"{safe_base}-{counter}{ext}"
        dest = target_dir / filename
        counter += 1
    dest.write_bytes(raw)
    stored_path = f'/uploads/{current_user.id}/attachments/{article_id}/{filename}'
    create_attachment(article_id, stored_path, filename, mime_type or '', len(raw))
    return stored_path


def _import_attachment_from_data_url(
    data_url: str,
    current_user: User,
    article_id: str,
    display_name: str | None = None,
) -> str:
    """
    Сохраняет вложение из data: URL в uploads/attachments и создаёт запись в БД.
    Возвращает относительный URL /uploads/...
    """
    raw, mime_type = _decode_data_url(data_url)
    return _import_attachment_from_bytes(raw, mime_type, current_user, article_id, display_name)

