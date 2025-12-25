from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from ..auth import User, get_current_user
from ..data_store import (
    ArticleNotFound,
    InvalidOperation,
    create_article,
    delete_article,
    get_article,
    get_articles,
    get_deleted_articles,
    get_or_create_user_inbox,
    indent_article as indent_article_ds,
    move_article as move_article_ds,
    move_article_to_parent,
    outdent_article as outdent_article_ds,
    restore_article,
    update_article_meta,
    update_article_doc_json,
    save_article_doc_json,
    get_article_block_embeddings,
)
from ..export_utils import _build_backup_article_html, _inline_uploads_for_backup
from .common import _present_article, _resolve_article_id_for_user

router = APIRouter()

BASE_DIR = Path(__file__).resolve().parents[3]
CLIENT_DIR = BASE_DIR / "client"


# Вынесено из app/main.py → app/routers/articles.py
@router.get('/api/articles')
def list_articles(current_user: User = Depends(get_current_user)):
    inbox_id = f'inbox-{current_user.id}'
    return [
        {
            'id': article['id'],
            'title': article['title'],
            'updatedAt': article['updatedAt'],
            'parentId': article.get('parentId'),
            'position': article.get('position', 0),
            'publicSlug': article.get('publicSlug'),
            'encrypted': bool(article.get('encrypted', False)),
        }
        for article in get_articles(current_user.id)
        if article['id'] != inbox_id
    ]


# Вынесено из app/main.py → app/routers/articles.py
@router.get('/api/articles/deleted')
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


# Вынесено из app/main.py → app/routers/articles.py
@router.post('/api/articles')
def post_article(payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    article_id = payload.get('id') if payload else None
    if article_id is not None and not isinstance(article_id, str):
        raise HTTPException(status_code=400, detail='id must be string')
    article = create_article(payload.get('title'), current_user.id, article_id=article_id)
    return article


# Вынесено из app/main.py → app/routers/articles.py
@router.get('/api/articles/{article_id}')
def read_article(article_id: str, request: Request, current_user: User = Depends(get_current_user)):
    started = time.perf_counter()
    if article_id == 'inbox':
        article = get_or_create_user_inbox(current_user.id)
        if not article:
            raise HTTPException(status_code=404, detail='Article not found')
        payload = {
            'id': article.get('id'),
            'title': article.get('title'),
            'createdAt': article.get('createdAt'),
            'updatedAt': article.get('updatedAt'),
            'deletedAt': article.get('deletedAt'),
            'parentId': article.get('parentId'),
            'position': article.get('position') or 0,
            'authorId': article.get('authorId'),
            'publicSlug': article.get('publicSlug'),
            'encrypted': bool(article.get('encrypted')),
            'encryptionSalt': article.get('encryptionSalt'),
            'encryptionVerifier': article.get('encryptionVerifier'),
            'encryptionHint': article.get('encryptionHint'),
            'docJson': article.get('docJson') or None,
            # legacy fields kept for client compatibility (not used in outline-first UX)
            'history': article.get('history') or [],
            'redoHistory': article.get('redoHistory') or [],
            'blockTrash': article.get('blockTrash') or [],
            'blocks': [],
        }
        try:
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            doc_bytes = len(json.dumps(payload.get('docJson') or {}, ensure_ascii=False))
            etag = f'W/"{payload.get("updatedAt") or ""}:{doc_bytes}"'
            if request.headers.get('if-none-match') == etag:
                return Response(status_code=304, headers={'ETag': etag})
            headers = {
                'X-Memus-Article-ms': str(elapsed_ms),
                'X-Memus-DocJson-bytes': str(doc_bytes),
                'ETag': etag,
            }
            return Response(
                content=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                media_type='application/json; charset=utf-8',
                headers=headers,
            )
        except Exception:
            return payload
    # doc_json-first: return metadata + docJson without legacy blocks (faster, smaller payload).
    article = get_article(article_id, current_user.id, include_blocks=False)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    # Diagnostics: expose timing + payload size in headers (useful for devtools).
    try:
        payload = {
            'id': article.get('id'),
            'title': article.get('title'),
            'createdAt': article.get('createdAt'),
            'updatedAt': article.get('updatedAt'),
            'deletedAt': article.get('deletedAt'),
            'parentId': article.get('parentId'),
            'position': article.get('position') or 0,
            'authorId': article.get('authorId'),
            'publicSlug': article.get('publicSlug'),
            'encrypted': bool(article.get('encrypted')),
            'encryptionSalt': article.get('encryptionSalt'),
            'encryptionVerifier': article.get('encryptionVerifier'),
            'encryptionHint': article.get('encryptionHint'),
            'docJson': article.get('docJson') or None,
            'history': article.get('history') or [],
            'redoHistory': article.get('redoHistory') or [],
            'blockTrash': article.get('blockTrash') or [],
            'blocks': [],
        }
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        doc_bytes = len(json.dumps(payload.get('docJson') or {}, ensure_ascii=False))
        etag = f'W/"{payload.get("updatedAt") or ""}:{doc_bytes}"'
        if request.headers.get('if-none-match') == etag:
            return Response(status_code=304, headers={'ETag': etag})
        headers = {
            'X-Memus-Article-ms': str(elapsed_ms),
            'X-Memus-DocJson-bytes': str(doc_bytes),
            'ETag': etag,
        }
        return Response(
            content=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
            media_type='application/json; charset=utf-8',
            headers=headers,
        )
    except Exception:
        return payload if 'payload' in locals() else article


@router.get('/api/articles/{article_id}/meta')
def read_article_meta(article_id: str, request: Request, current_user: User = Depends(get_current_user)):
    """
    Lightweight article metadata for offline-first client decisions.
    Returns updatedAt + docJsonBytes so the client can avoid downloading full docJson when unchanged.
    """
    started = time.perf_counter()
    if article_id == 'inbox':
        article = get_or_create_user_inbox(current_user.id)
        if not article:
            raise HTTPException(status_code=404, detail='Article not found')
        doc_json = article.get('docJson') or None
        updated_at = article.get('updatedAt')
    else:
        article = get_article(article_id, current_user.id, include_blocks=False)
        if not article:
            raise HTTPException(status_code=404, detail='Article not found')
        doc_json = article.get('docJson') or None
        updated_at = article.get('updatedAt')

    try:
        doc_bytes = len(json.dumps(doc_json or {}, ensure_ascii=False))
    except Exception:
        doc_bytes = 0

    etag = f'W/"{updated_at or ""}:{doc_bytes}"'
    if request.headers.get('if-none-match') == etag:
        return Response(status_code=304, headers={'ETag': etag})

    payload = {'id': article_id, 'updatedAt': updated_at, 'docJsonBytes': doc_bytes}
    try:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        headers = {'X-Memus-Article-ms': str(elapsed_ms), 'ETag': etag}
        return Response(
            content=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
            media_type='application/json; charset=utf-8',
            headers=headers,
        )
    except Exception:
        return payload


@router.get('/api/articles/{article_id}/export/html')
def export_article_html(article_id: str, download: bool = True, current_user: User = Depends(get_current_user)):
    """
    Экспорт одной статьи в HTML. Источник истины для контента — `articles.article_doc_json`.

    По умолчанию возвращает attachment (скачивание). Можно открыть в браузере через `?download=0`.
    """
    if article_id == 'inbox':
        article = get_or_create_user_inbox(current_user.id)
        if not article:
            raise HTTPException(status_code=404, detail='Article not found')
    else:
        real_article_id = _resolve_article_id_for_user(article_id, current_user)
        article = get_article(real_article_id, current_user.id, include_blocks=False)
        if not article:
            raise HTTPException(status_code=404, detail='Article not found')

    try:
        css_text = (CLIENT_DIR / 'style.css').read_text(encoding='utf-8')
    except OSError:
        css_text = ''

    html = _build_backup_article_html(article, css_text, lang='ru')
    html = _inline_uploads_for_backup(html, current_user)

    filename_base = re.sub(r'[\\\\/:*?"<>|]+', '', (article.get('title') or '').strip()) or 'article'
    filename_base = filename_base[:80]
    filename = f'{filename_base}.html'
    disposition = 'attachment' if download else 'inline'
    headers = {'Content-Disposition': f'{disposition}; filename=\"{filename}\"'}
    return Response(content=html.encode('utf-8'), media_type='text/html; charset=utf-8', headers=headers)

@router.get('/api/articles/{article_id}/embeddings')
def get_article_embeddings(article_id: str, since: str | None = None, ids: str | None = None, current_user: User = Depends(get_current_user)):
    """
    Возвращает embeddings для секций статьи (block_embeddings) для offline-first клиента.
    `since` — iso timestamp; `ids` — comma-separated blockIds (опционально).
    """
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    block_ids = None
    if ids:
        block_ids = [s.strip() for s in str(ids).split(',') if s.strip()]
    return {
        'articleId': real_article_id,
        'embeddings': get_article_block_embeddings(
            article_id=real_article_id,
            author_id=current_user.id,
            since=str(since or '').strip() or None,
            block_ids=block_ids,
        ),
    }


@router.put('/api/articles/{article_id}/doc-json')
def put_article_doc_json(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    doc_json = payload.get('docJson') if payload else None
    if doc_json is None:
        raise HTTPException(status_code=400, detail='docJson is required')
    if not isinstance(doc_json, dict):
        raise HTTPException(status_code=400, detail='docJson must be object')
    ok = update_article_doc_json(real_article_id, current_user.id, doc_json)
    if not ok:
        raise HTTPException(status_code=404, detail='Article not found')
    return {'status': 'ok'}


@router.put('/api/articles/{article_id}/doc-json/save')
def put_article_doc_json_save(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    """
    Outline-first save: persist doc_json and update derived indexes (FTS/embeddings/article_links).
    """
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    doc_json = payload.get('docJson') if payload else None
    if doc_json is None:
        raise HTTPException(status_code=400, detail='docJson is required')
    if not isinstance(doc_json, dict):
        raise HTTPException(status_code=400, detail='docJson must be object')
    create_version_if_stale_hours = payload.get('createVersionIfStaleHours') if payload else None
    if create_version_if_stale_hours is not None and not isinstance(create_version_if_stale_hours, (int, float)):
        raise HTTPException(status_code=400, detail='createVersionIfStaleHours must be number')
    try:
        return save_article_doc_json(
            article_id=real_article_id,
            author_id=current_user.id,
            doc_json=doc_json,
            create_version_if_stale_hours=int(create_version_if_stale_hours) if create_version_if_stale_hours is not None else None,
        )
    except ArticleNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidOperation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# Вынесено из app/main.py → app/routers/articles.py
@router.delete('/api/articles/{article_id}')
def remove_article(article_id: str, force: bool = False, current_user: User = Depends(get_current_user)):
    article = get_article(article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    deleted = delete_article(article_id, force=force)
    if not deleted:
        raise HTTPException(status_code=404, detail='Article not found')
    return {'status': 'deleted' if not force else 'purged'}


# Вынесено из app/main.py → app/routers/articles.py
@router.post('/api/articles/{article_id}/move')
def move_article_endpoint(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    direction = (payload.get('direction') or '').strip()
    if direction not in {'up', 'down'}:
        raise HTTPException(status_code=400, detail='Unknown move direction')
    try:
        article = move_article_ds(article_id, direction, current_user.id)
    except ArticleNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return article


# Вынесено из app/main.py → app/routers/articles.py
@router.post('/api/articles/{article_id}/indent')
def indent_article_endpoint(article_id: str, current_user: User = Depends(get_current_user)):
    try:
        article = indent_article_ds(article_id, current_user.id)
    except ArticleNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return article


# Вынесено из app/main.py → app/routers/articles.py
@router.post('/api/articles/{article_id}/outdent')
def outdent_article_endpoint(article_id: str, current_user: User = Depends(get_current_user)):
    try:
        article = outdent_article_ds(article_id, current_user.id)
    except ArticleNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return article


# Вынесено из app/main.py → app/routers/articles.py
@router.post('/api/articles/{article_id}/move-tree')
def move_article_tree_endpoint(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    """
    Перемещает статью в дереве:
    - parentId: новый родитель (или null для корня);
    - anchorId + placement ('before'/'after'/'inside') — точное место вставки среди детей.
    """
    parent_id_raw = payload.get('parentId')
    parent_id = parent_id_raw or None
    anchor_id = payload.get('anchorId') or None
    placement = (payload.get('placement') or '').strip() or None
    if placement not in {None, 'before', 'after', 'inside'}:
        raise HTTPException(status_code=400, detail='Unknown placement')
    try:
        article = move_article_to_parent(
            article_id,
            parent_id,
            current_user.id,
            anchor_id=anchor_id,
            placement=placement,
        )
    except ArticleNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidOperation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return article


# Вынесено из app/main.py → app/routers/articles.py
@router.patch('/api/articles/{article_id}')
def patch_article(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    article = get_article(real_article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        article = update_article_meta(real_article_id, payload)
        if not article:
            # Если функция вернула None, значит, не было изменений
            article = get_article(real_article_id, current_user.id)
        return _present_article(article, article_id)
    except ArticleNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


# Вынесено из app/main.py → app/routers/articles.py
@router.post('/api/articles/{article_id}/restore')
def post_restore_article(article_id: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    article = restore_article(real_article_id, author_id=current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found or not deleted')
    return _present_article(article, article_id)
