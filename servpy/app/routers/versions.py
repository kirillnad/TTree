from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..auth import User, get_current_user
from ..db import CONN
from ..data_store import ArticleNotFound, InvalidOperation, get_article, replace_article_blocks_tree
from .common import _resolve_article_id_for_user

router = APIRouter()


@router.get('/api/articles/{article_id}/versions')
def get_article_versions(article_id: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    rows = CONN.execute(
        '''
        SELECT id, created_at, reason, label
        FROM article_versions
        WHERE article_id = ? AND author_id = ?
        ORDER BY created_at DESC
        LIMIT 200
        ''',
        (real_article_id, current_user.id),
    ).fetchall()
    return {'versions': list(rows or [])}


@router.get('/api/articles/{article_id}/versions/{version_id}')
def get_article_version(article_id: str, version_id: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    row = CONN.execute(
        '''
        SELECT id, created_at, reason, label, blocks_json
        FROM article_versions
        WHERE id = ? AND article_id = ? AND author_id = ?
        ''',
        (version_id, real_article_id, current_user.id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Version not found')
    return {
        'id': row.get('id'),
        'createdAt': row.get('created_at'),
        'reason': row.get('reason'),
        'label': row.get('label'),
        'blocks': json.loads(row.get('blocks_json') or '[]'),
    }


@router.post('/api/articles/{article_id}/versions')
def create_article_version(article_id: str, payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    article = get_article(real_article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    label = None
    if payload and payload.get('label') is not None:
        if not isinstance(payload.get('label'), str):
            raise HTTPException(status_code=400, detail='label must be string')
        label = (payload.get('label') or '').strip() or None

    # Используем текущее время, чтобы версия была упорядочена корректно.
    from datetime import datetime
    created_at = datetime.utcnow().isoformat()
    doc_json = CONN.execute(
        'SELECT article_doc_json FROM articles WHERE id = ? AND author_id = ?',
        (real_article_id, current_user.id),
    ).fetchone()
    doc_json_value = doc_json.get('article_doc_json') if doc_json else None

    try:
        CONN.execute(
            '''
            INSERT INTO article_versions (id, article_id, author_id, created_at, reason, label, blocks_json, doc_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                str(uuid.uuid4()),
                real_article_id,
                current_user.id,
                created_at,
                'manual',
                label,
                json.dumps(article.get('blocks') or []),
                doc_json_value,
            ),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f'Failed to create version: {exc!s}') from exc

    return {'status': 'ok'}


@router.post('/api/articles/{article_id}/versions/{version_id}/restore')
def restore_article_version(article_id: str, version_id: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')

    row = CONN.execute(
        '''
        SELECT blocks_json, doc_json
        FROM article_versions
        WHERE id = ? AND article_id = ? AND author_id = ?
        ''',
        (version_id, real_article_id, current_user.id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Version not found')
    try:
        blocks = json.loads(row.get('blocks_json') or '[]')
    except Exception:
        blocks = []
    if not isinstance(blocks, list):
        raise HTTPException(status_code=400, detail='Invalid version payload')
    try:
        result = replace_article_blocks_tree(
            article_id=real_article_id,
            author_id=current_user.id,
            blocks=blocks,
            create_version_if_stale_hours=None,
            doc_json=json.loads(row.get('doc_json')) if row.get('doc_json') else None,
        )
        return result
    except (ArticleNotFound, InvalidOperation) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
