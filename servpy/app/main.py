from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path, PurePath
from typing import Any

import aiofiles
from fastapi import FastAPI, File, HTTPException, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from .data_store import (
    ArticleNotFound,
    BlockNotFound,
    InvalidOperation,
    create_article,
    delete_block,
    ensure_sample_article,
    indent_block,
    insert_block,
    move_block,
    outdent_block,
    redo_block_text_change,
    restore_block,
    search_blocks,
    undo_block_text_change,
    update_article_meta,
    update_block,
    update_block_collapse,
    get_articles,
    get_article,
)

BASE_DIR = Path(__file__).resolve().parents[2]
CLIENT_DIR = BASE_DIR / "client"
UPLOADS_DIR = BASE_DIR / 'servpy_uploads'
UPLOADS_DIR.mkdir(exist_ok=True, parents=True)

ensure_sample_article()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)

app.mount('/uploads', StaticFiles(directory=str(UPLOADS_DIR)), name='uploads')

@app.middleware("http")
async def spa_middleware(request: Request, call_next):
    """
    Middleware для поддержки Single Page Application (SPA).
    Если запрос не является API, файлом или загрузкой, возвращает index.html.
    """
    response = await call_next(request)
    if response.status_code == 404:
        path = PurePath(request.url.path)
        if path.suffix:
            return response
        if request.url.path.startswith("/api"):
            return response
        return FileResponse(f"{CLIENT_DIR}/index.html")
    return response



@app.get('/api/articles')
def list_articles():
    return [
        {'id': article['id'], 'title': article['title'], 'updatedAt': article['updatedAt']}
        for article in get_articles()
    ]


@app.post('/api/articles')
def post_article(payload: dict[str, Any]):
    article = create_article(payload.get('title'))
    return article


@app.get('/api/articles/{article_id}')
def read_article(article_id: str):
    article = get_article(article_id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    return article


@app.patch('/api/articles/{article_id}')
def patch_article(article_id: str, payload: dict[str, Any]):
    try:
        article = update_article_meta(article_id, payload)
        if not article:
            # Если функция вернула None, значит, не было изменений
            return get_article(article_id)
        return article
    except ArticleNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.patch('/api/articles/{article_id}/blocks/{block_id}')
def patch_block(article_id: str, block_id: str, payload: dict[str, Any]):
    try:
        block = update_block(article_id, block_id, payload)
        return block
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.patch('/api/articles/{article_id}/collapse')
def patch_collapse(article_id: str, payload: dict[str, Any]):
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
def post_sibling(article_id: str, block_id: str, payload: dict[str, Any]):
    direction = payload.get('direction', 'after') if payload else 'after'
    try:
        result = insert_block(article_id, block_id, direction, payload.get('payload') if payload else None)
        return result
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.delete('/api/articles/{article_id}/blocks/{block_id}')
def remove_block(article_id: str, block_id: str):
    try:
        result = delete_block(article_id, block_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not result:
        raise HTTPException(status_code=404, detail='Статья или блок не найдены')
    return result # result может быть None, если декоратор не нашел статью


@app.post('/api/articles/{article_id}/blocks/{block_id}/move')
def post_move(article_id: str, block_id: str, payload: dict[str, Any]):
    direction = payload.get('direction')
    if direction not in {'up', 'down'}:
        raise HTTPException(status_code=400, detail='Unknown move direction')
    try:
        result = move_block(article_id, block_id, direction)
        return result
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/indent')
def post_indent(article_id: str, block_id: str):
    try:
        return indent_block(article_id, block_id)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/outdent')
def post_outdent(article_id: str, block_id: str):
    try:
        return outdent_block(article_id, block_id)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/undo-text')
def post_undo(article_id: str, payload: dict[str, Any]):
    entry_id = payload.get('entryId')
    return _handle_undo_redo(undo_block_text_change, article_id, entry_id)


@app.post('/api/articles/{article_id}/blocks/redo-text')
def post_redo(article_id: str, payload: dict[str, Any]):
    entry_id = payload.get('entryId')
    return _handle_undo_redo(redo_block_text_change, article_id, entry_id)


@app.post('/api/uploads')
async def upload_file(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail='Доступны только изображения')
    now = datetime.utcnow()
    target_dir = UPLOADS_DIR / str(now.year) / f'{now.month:02}'
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f'{int(now.timestamp()*1000)}-{os.urandom(4).hex()}{Path(file.filename).suffix or ".bin"}'
    dest = target_dir / filename
    size = 0
    async with aiofiles.open(dest, 'wb') as out_file:
        while chunk := await file.read(1024 * 256):
            size += len(chunk)
            if size > 5 * 1024 * 1024:
                dest.unlink(missing_ok=True)
                raise HTTPException(status_code=400, detail='Файл слишком большой')
            await out_file.write(chunk)
    return {'url': f'/uploads/{dest.relative_to(UPLOADS_DIR).as_posix()}'}


@app.get('/api/search')
def get_search(q: str = ''):
    query = q.strip()
    if not query:
        return []
    return search_blocks(query, 30)


@app.post('/api/articles/{article_id}/blocks/restore')
def post_restore(article_id: str, payload: dict[str, Any]):
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


def _handle_undo_redo(func, article_id, entry_id):
    try:
        block = func(article_id, entry_id)
        return {'blockId': block['id'], 'block': block}
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


# Mount client SPA after API routes so /api/* keeps working
app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")
