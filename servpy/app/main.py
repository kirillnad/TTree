from __future__ import annotations

import os
import mimetypes
from datetime import datetime
from pathlib import Path, PurePath
from typing import Any
from uuid import uuid4
from io import BytesIO

import aiofiles
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .auth import (
    User,
    clear_session_cookie,
    create_session,
    create_user,
    ensure_superuser,
    get_current_user,
    get_user_by_username,
    set_session_cookie,
    verify_password,
)
from .db import CONN, IS_SQLITE, IS_POSTGRES
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
    indent_block,
    insert_block,
    move_block,
    move_block_to_parent,
    outdent_block,
    redo_block_text_change,
    restore_article,
    restore_block,
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
    rebuild_search_indexes,
    build_sqlite_fts_query,
    build_postgres_ts_query,
    delete_user_with_data,
)

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
    'application/rtf',
}

ensure_sample_article()
ensure_inbox_article()
rebuild_search_indexes()
# Гарантируем наличие суперпользователя kirill.
ensure_superuser('kirill', 'zZ141400', 'kirill')

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


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


@app.post('/api/auth/register')
def register(payload: dict[str, Any], response: Response):
    username = (payload.get('username') or '').strip()
    password = payload.get('password') or ''
    display_name = (payload.get('displayName') or '').strip() or None
    if not username or not password:
        raise HTTPException(status_code=400, detail='Username and password are required')
    existing = get_user_by_username(username)
    if existing:
        raise HTTPException(status_code=400, detail='Username already taken')
    user = create_user(username, password, display_name)
    sid = create_session(user.id)
    set_session_cookie(response, sid)
    return {
        'id': user.id,
        'username': user.username,
        'displayName': user.display_name,
        'isSuperuser': bool(getattr(user, 'is_superuser', False)),
    }


@app.post('/api/auth/login')
def login(payload: dict[str, Any], response: Response):
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


@app.post('/api/auth/logout')
def logout(response: Response, current_user: User = Depends(get_current_user)):
    clear_session_cookie(response)
    return {'status': 'ok'}


@app.get('/api/auth/me')
def me(current_user: User = Depends(get_current_user)):
    return {
        'id': current_user.id,
        'username': current_user.username,
        'displayName': current_user.display_name,
        'isSuperuser': bool(getattr(current_user, 'is_superuser', False)),
    }


@app.get('/api/articles')
def list_articles(current_user: User = Depends(get_current_user)):
    return [
        {
            'id': article['id'],
            'title': article['title'],
            'updatedAt': article['updatedAt'],
            'encrypted': bool(article.get('encrypted', False)),
        }
        for article in get_articles(current_user.id)
    ]


@app.get('/api/users')
def list_users(current_user: User = Depends(get_current_user)):
    if not getattr(current_user, 'is_superuser', False):
        raise HTTPException(status_code=403, detail='Forbidden')
    rows = CONN.execute(
        '''
        SELECT id, username, display_name, created_at,
               is_superuser
        FROM users
        ORDER BY username
        ''',
    ).fetchall()
    return [
        {
            'id': row['id'],
            'username': row['username'],
            'displayName': row.get('display_name'),
            'createdAt': row['created_at'],
            'isSuperuser': bool(row.get('is_superuser', 0)),
        }
        for row in rows
    ]


@app.delete('/api/users/{user_id}')
def delete_user(user_id: str, current_user: User = Depends(get_current_user)):
    if not getattr(current_user, 'is_superuser', False):
        raise HTTPException(status_code=403, detail='Forbidden')
    row = CONN.execute(
        'SELECT id, username, is_superuser FROM users WHERE id = ?',
        (user_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='User not found')
    if bool(row.get('is_superuser', 0)):
        raise HTTPException(status_code=400, detail='Cannot delete a superuser')
    # Удаляем данные пользователя в БД.
    delete_user_with_data(user_id)
    # Чистим его uploads на диске.
    user_root = UPLOADS_DIR / user_id
    if user_root.exists():
        import shutil
        shutil.rmtree(user_root, ignore_errors=True)
    return {'status': 'deleted'}


@app.get('/api/articles/deleted')
def list_deleted_articles(current_user: User = Depends(get_current_user)):
    return [
        {
            'id': article['id'],
            'title': article['title'],
            'updatedAt': article['updatedAt'],
            'deletedAt': article['deletedAt'],
        }
        for article in get_deleted_articles(current_user.id)
    ]


@app.post('/api/articles')
def post_article(payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    article = create_article(payload.get('title'), current_user.id)
    return article


@app.get('/api/articles/{article_id}')
def read_article(article_id: str, current_user: User = Depends(get_current_user)):
    article = get_article(article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    return article


@app.delete('/api/articles/{article_id}')
def remove_article(article_id: str, force: bool = False, current_user: User = Depends(get_current_user)):
    article = get_article(article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    deleted = delete_article(article_id, force=force)
    if not deleted:
        raise HTTPException(status_code=404, detail='Article not found')
    return {'status': 'deleted' if not force else 'purged'}


@app.patch('/api/articles/{article_id}')
def patch_article(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    article = get_article(article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        article = update_article_meta(article_id, payload)
        if not article:
            # Если функция вернула None, значит, не было изменений
            return get_article(article_id)
        return article
    except ArticleNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.patch('/api/articles/{article_id}/blocks/{block_id}')
def patch_block(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    try:
        if not get_article(article_id, current_user.id):
            raise ArticleNotFound('Article not found')
        block = update_block(article_id, block_id, payload)
        return block
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.patch('/api/articles/{article_id}/collapse')
def patch_collapse(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    if not get_article(article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    block_id = payload.get('blockId')
    collapsed = payload.get('collapsed')
    if block_id is None or not isinstance(collapsed, bool):
        raise HTTPException(status_code=400, detail='Missing blockId or collapsed flag')
    try:
        block = update_block_collapse(article_id, block_id, collapsed)
        return block
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/siblings')
def post_sibling(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    if not get_article(article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    direction = payload.get('direction', 'after') if payload else 'after'
    try:
        result = insert_block(article_id, block_id, direction, payload.get('payload') if payload else None)
        return result
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.delete('/api/articles/{article_id}/blocks/{block_id}')
def remove_block(article_id: str, block_id: str, current_user: User = Depends(get_current_user)):
    if not get_article(article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        result = delete_block(article_id, block_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not result:
        raise HTTPException(status_code=404, detail='Статья или блок не найдены')
    return result # result может быть None, если декоратор не нашел статью


@app.post('/api/articles/{article_id}/blocks/{block_id}/move')
def post_move(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    direction = payload.get('direction')
    if direction not in {'up', 'down'}:
        raise HTTPException(status_code=400, detail='Unknown move direction')
    try:
        if not get_article(article_id, current_user.id):
            raise ArticleNotFound('Article not found')
        result = move_block(article_id, block_id, direction)
        return result
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/indent')
def post_indent(article_id: str, block_id: str, current_user: User = Depends(get_current_user)):
    if not get_article(article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        return indent_block(article_id, block_id)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/outdent')
def post_outdent(article_id: str, block_id: str, current_user: User = Depends(get_current_user)):
    if not get_article(article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        return outdent_block(article_id, block_id)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/relocate')
def post_relocate(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    if not get_article(article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    target_parent_id = payload.get('parentId')
    target_index = payload.get('index')
    anchor_id = payload.get('anchorId')
    placement = payload.get('placement')
    try:
        return move_block_to_parent(article_id, block_id, target_parent_id, target_index, anchor_id, placement)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/undo-text')
def post_undo(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    if not get_article(article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    entry_id = payload.get('entryId')
    return _handle_undo_redo(undo_block_text_change, article_id, entry_id)


@app.post('/api/articles/{article_id}/blocks/redo-text')
def post_redo(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    if not get_article(article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    entry_id = payload.get('entryId')
    return _handle_undo_redo(redo_block_text_change, article_id, entry_id)


@app.post('/api/articles/{article_id}/restore')
def post_restore_article(article_id: str, current_user: User = Depends(get_current_user)):
    article = restore_article(article_id, author_id=current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found or not deleted')
    return article



@app.post('/api/uploads')
async def upload_file(file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    if not file.content_type or not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail='Ошибка формата: нужен image/*')
    now = datetime.utcnow()
    user_root = UPLOADS_DIR / current_user.id / 'images'
    target_dir = user_root / str(now.year) / f"{now.month:02}"
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{int(now.timestamp()*1000)}-{os.urandom(4).hex()}.webp"
    dest = target_dir / filename

    buffer = BytesIO()
    size = 0
    while chunk := await file.read(1024 * 256):
        size += len(chunk)
        if size > 20 * 1024 * 1024:
            raise HTTPException(status_code=400, detail='Размер файла превышает лимит')
        buffer.write(chunk)
    buffer.seek(0)

    try:
        img = Image.open(buffer)
    except Exception as exc:  # noqa: BLE001
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
    img.save(out_buf, 'WEBP', quality=85, method=6)
    out_bytes = out_buf.getvalue()

    async with aiofiles.open(dest, 'wb') as out_file:
        await out_file.write(out_bytes)

    rel = dest.relative_to(UPLOADS_DIR).as_posix()
    return {'url': f"/uploads/{rel}"}



@app.post('/api/articles/{article_id}/attachments')
async def upload_attachment(article_id: str, file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    article = get_article(article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    content_type = file.content_type or ''
    if not content_type:
        content_type = mimetypes.guess_type(file.filename or '')[0] or ''
    if not content_type or content_type not in ALLOWED_ATTACHMENT_TYPES:
        raise HTTPException(status_code=400, detail='Недопустимый тип файла')

    target_dir = UPLOADS_DIR / current_user.id / 'attachments' / article_id
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f'{uuid4().hex}{Path(file.filename).suffix or ""}'
    dest = target_dir / filename

    size = 0
    try:
        async with aiofiles.open(dest, 'wb') as out_file:
            while chunk := await file.read(1024 * 256):
                size += len(chunk)
                if size > 20 * 1024 * 1024:
                    dest.unlink(missing_ok=True)
                    raise HTTPException(status_code=400, detail='Файл слишком большой (макс 20 МБ)')
                await out_file.write(chunk)
    except Exception:
        dest.unlink(missing_ok=True)
        raise

    stored_path = f'/uploads/{current_user.id}/attachments/{article_id}/{filename}'
    attachment = create_attachment(article_id, stored_path, file.filename or filename, content_type or '', size)
    return attachment


@app.get('/api/search')
def get_search(q: str = '', current_user: User = Depends(get_current_user)):
    query = q.strip()
    if not query:
        return []
    if IS_SQLITE:
        # Если индексы помечены как «грязные» (например, после явного DELETE в тестах),
        # временно отключаем поиск, пока не будет вызван rebuild_search_indexes().
        if db_module.SEARCH_INDEX_DIRTY:
            return []

        pattern = f'%{query}%'
        # Простой поиск по названиям статей
        article_rows = CONN.execute(
            '''
            SELECT id AS articleId, title, updated_at
            FROM articles
            WHERE deleted_at IS NULL
              AND author_id = ?
              AND title LIKE ?
            ORDER BY updated_at DESC
            LIMIT 15
            ''',
            (current_user.id, pattern),
        ).fetchall()
        article_results = [
            {
                'type': 'article',
                'articleId': row['articleId'],
                'articleTitle': row['title'] or '',
                'snippet': row['title'] or '',
            }
            for row in article_rows
        ]

        # Простой поиск по содержимому блоков
        block_rows = CONN.execute(
            '''
            SELECT
                blocks.id AS blockId,
                articles.id AS articleId,
                articles.title AS articleTitle,
                blocks.text AS blockText
            FROM blocks
            JOIN articles ON articles.id = blocks.article_id
            WHERE articles.deleted_at IS NULL
              AND articles.author_id = ?
              AND blocks.text LIKE ?
            ORDER BY blocks.block_rowid DESC
            LIMIT 30
            ''',
            (current_user.id, pattern),
        ).fetchall()
        block_results = [
            {
                'type': 'block',
                'articleId': row['articleId'],
                'articleTitle': row['articleTitle'] or '',
                'blockId': row['blockId'],
                'snippet': row['blockText'] or '',
                'blockText': row['blockText'] or '',
            }
            for row in block_rows
        ]
        return article_results + block_results

    # Для PostgreSQL используем специализированный поиск из слоя данных.
    return search_everything(query, block_limit=30, article_limit=15, author_id=current_user.id)


@app.post('/api/articles/{article_id}/blocks/restore')
def post_restore(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    if not get_article(article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    block = payload.get('block')
    if not block:
        raise HTTPException(status_code=400, detail='Missing block payload')
    parent_id = payload.get('parentId')
    index = payload.get('index')
    try:
        return restore_block(article_id, parent_id, index, block)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/move-to/{target_article_id}')
def post_move_to(article_id: str, block_id: str, target_article_id: str, current_user: User = Depends(get_current_user)):
    try:
        src = get_article(article_id, current_user.id)
        dst = get_article(target_article_id, current_user.id)
        if not src or not dst:
            raise ArticleNotFound('Article not found')
        return move_block_to_article(article_id, block_id, target_article_id)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _handle_undo_redo(func, article_id, entry_id):
    try:
        result = func(article_id, entry_id)
        if not result:
            raise InvalidOperation('Nothing to undo')
        block_id = result.get('blockId') or result.get('id')
        block_payload = result.get('block') or {'id': block_id, **{k: v for k, v in result.items() if k != 'blockId'}}
        return {'blockId': block_id, 'block': block_payload}
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get('/api/changelog')
def get_changelog():
    changelog = BASE_DIR / 'changelog.txt'
    if not changelog.exists():
        raise HTTPException(status_code=404, detail='Changelog not found')
    return PlainTextResponse(changelog.read_text(encoding='utf-8'))


@app.get('/api/health')
def health():
    return {'status': 'ok'}

@app.get('/favicon.ico')
def favicon():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="#0d6efd"/>
<path d="M18 18h8v20h-8zM30 18h8l8 12-8 12h-8l8-12z" fill="#fff"/>
</svg>"""
    return Response(content=svg, media_type='image/svg+xml')


@app.get('/uploads/{user_id}/{rest_of_path:path}')
async def get_upload(user_id: str, rest_of_path: str, current_user: User = Depends(get_current_user)):
    if user_id != current_user.id:
        raise HTTPException(status_code=404, detail='Not found')
    full_path = UPLOADS_DIR / user_id / rest_of_path
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail='Not found')
    return FileResponse(full_path)


# Mount client SPA after API routes so /api/* keeps working.
app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")
