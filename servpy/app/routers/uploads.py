from __future__ import annotations

import logging
import mimetypes
import os
from datetime import datetime
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import aiofiles
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image

from ..auth import User, get_current_user
from ..data_store import create_attachment, get_article
from .common import _resolve_article_id_for_user

router = APIRouter()
logger = logging.getLogger('uvicorn.error')

# Вынесено из app/main.py → app/routers/uploads.py
BASE_DIR = Path(__file__).resolve().parents[3]
UPLOADS_DIR = BASE_DIR / 'uploads'
UPLOADS_DIR.mkdir(exist_ok=True, parents=True)

# Вынесено из app/main.py → app/routers/uploads.py
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


# Вынесено из app/main.py → app/routers/uploads.py
@router.post('/api/uploads')
async def upload_file(file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    logger.error(
        'upload_image: name=%r content_type=%r size=%r',
        getattr(file, 'filename', None),
        getattr(file, 'content_type', None),
        getattr(file, 'spool_max_size', None),
    )
    now = datetime.utcnow()
    user_root = UPLOADS_DIR / current_user.id / 'images'
    target_dir = user_root / str(now.year) / f"{now.month:02}"
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{int(now.timestamp()*1000)}-{os.urandom(4).hex()}.webp"
    dest = target_dir / filename

    buffer = BytesIO()
    size = 0
    try:
        while chunk := await file.read(1024 * 256):
            size += len(chunk)
            if size > 20 * 1024 * 1024:
                logger.warning(
                    'upload_image: file too large, size=%d name=%r content_type=%r',
                    size,
                    getattr(file, 'filename', None),
                    getattr(file, 'content_type', None),
                )
                raise HTTPException(status_code=400, detail='Размер файла превышает лимит')
            buffer.write(chunk)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.error(
            'upload_image: error while reading upload: name=%r content_type=%r exc=%r',
            getattr(file, 'filename', None),
            getattr(file, 'content_type', None),
            exc,
        )
        raise HTTPException(status_code=400, detail='Не удалось принять файл') from exc
    buffer.seek(0)

    try:
        img = Image.open(buffer)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            'upload_image: failed to open image: name=%r content_type=%r size=%d exc=%r',
            getattr(file, 'filename', None),
            getattr(file, 'content_type', None),
            size,
            exc,
        )
        raise HTTPException(status_code=400, detail='Не удалось прочитать изображение') from exc

    max_width = 1920
    if img.width > max_width:
        new_height = int(img.height * max_width / img.width)
        img = img.resize((max_width, max(new_height, 1)), Image.Resampling.LANCZOS)

    if img.mode in ('RGBA', 'LA', 'P'):
        img = img.convert('RGBA')
    else:
        img = img.convert('RGB')

    out_buf = BytesIO()
    # Все загружаемые изображения конвертируем в WebP с качеством 75.
    img.save(out_buf, 'WEBP', quality=75, method=6)
    out_bytes = out_buf.getvalue()

    async with aiofiles.open(dest, 'wb') as out_file:
        await out_file.write(out_bytes)

    rel = dest.relative_to(UPLOADS_DIR).as_posix()
    logger.error(
        'upload_image: saved url=%r name=%r orig_size=%d webp_size=%d',
        f"/uploads/{rel}",
        getattr(file, 'filename', None),
        size,
        len(out_bytes),
    )
    return {'url': f"/uploads/{rel}"}


# Вынесено из app/main.py → app/routers/uploads.py
@router.post('/api/articles/{article_id}/attachments')
async def upload_attachment(article_id: str, file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    article = get_article(real_article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    content_type = file.content_type or ''
    if not content_type:
        content_type = mimetypes.guess_type(file.filename or '')[0] or ''
    if not content_type or content_type not in ALLOWED_ATTACHMENT_TYPES:
        logger.error(
            'upload_attachment: rejected file type name=%r content_type=%r guessed=%r',
            getattr(file, 'filename', None),
            getattr(file, 'content_type', None),
            content_type,
        )
        raise HTTPException(status_code=400, detail='Недопустимый тип файла')

    target_dir = UPLOADS_DIR / current_user.id / 'attachments' / real_article_id
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f'{uuid4().hex}{Path(file.filename).suffix or ""}'
    dest = target_dir / filename

    size = 0
    try:
        async with aiofiles.open(dest, 'wb') as out_file:
            while chunk := await file.read(1024 * 256):
                size += len(chunk)
                if size > 20 * 1024 * 1024:
                    logger.warning(
                        'upload_attachment: file too large, size=%d name=%r content_type=%r',
                        size,
                        getattr(file, 'filename', None),
                        content_type,
                    )
                    dest.unlink(missing_ok=True)
                    raise HTTPException(status_code=400, detail='Файл слишком большой (макс 20 МБ)')
                await out_file.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    except Exception as exc:  # noqa: BLE001
        dest.unlink(missing_ok=True)
        logger.error(
            'upload_attachment: error while saving file name=%r content_type=%r exc=%r',
            getattr(file, 'filename', None),
            content_type,
            exc,
        )
        raise

    stored_path = f'/uploads/{current_user.id}/attachments/{real_article_id}/{filename}'
    attachment = create_attachment(real_article_id, stored_path, file.filename or filename, content_type or '', size)
    return attachment


# Вынесено из app/main.py → app/routers/uploads.py
@router.post('/api/articles/{article_id}/attachments/yandex')
def register_yandex_attachment(
    article_id: str,
    payload: dict[str, Any],
    current_user: User = Depends(get_current_user),
):
    """
    Регистрирует во вложениях файл, уже загруженный в app‑папку Яндекс.Диска.

    Ожидает JSON:
      {
        "path": "app:/.../file.ext",
        "originalName": "file.ext",
        "contentType": "application/pdf",
        "size": 12345
      }
    """
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    article = get_article(real_article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')

    disk_path = (payload.get('path') or '').strip()
    if not disk_path:
        raise HTTPException(status_code=400, detail='Не указан путь на Яндекс.Диске')
    original_name = (payload.get('originalName') or '').strip() or 'attachment'
    content_type = (payload.get('contentType') or '').strip()
    size = int(payload.get('size') or 0) or 0

    attachment = create_attachment(
        real_article_id,
        disk_path,
        original_name,
        content_type or '',
        size,
    )
    return attachment


# Legacy/compat public attachment path:
# We expose storedPath as `/uploads/<article_id>/<filename>` while files are stored under
# `/uploads/<user_id>/attachments/<article_id>/<filename>`.
@router.get('/uploads/{article_id}/{filename}')
async def get_article_attachment(article_id: str, filename: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    article = get_article(real_article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Not found')
    full_path = UPLOADS_DIR / current_user.id / 'attachments' / real_article_id / filename
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail='Not found')
    return FileResponse(full_path)


# Вынесено из app/main.py → app/routers/uploads.py
@router.get('/uploads/{user_id}/{rest_of_path:path}')
async def get_upload(user_id: str, rest_of_path: str, current_user: User = Depends(get_current_user)):
    if user_id != current_user.id:
        raise HTTPException(status_code=404, detail='Not found')
    full_path = UPLOADS_DIR / user_id / rest_of_path
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail='Not found')
    return FileResponse(full_path)
