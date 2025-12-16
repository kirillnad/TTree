from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response

from ..auth import User, get_current_user
from ..db import CONN
from ..data_store import build_article_from_row, get_article
from ..public_render import (
    _build_public_article_html,
    _generate_public_slug,
    _get_public_article_row,
)
from .common import _present_article, _resolve_article_id_for_user

router = APIRouter()


# Вынесено из app/main.py → app/routers/public.py
@router.post('/api/articles/{article_id}/public')
def set_article_public(
    article_id: str,
    payload: dict[str, Any],
    current_user: User = Depends(get_current_user),
):
    """
    Включает или выключает публичный доступ к статье.
    payload: {"public": true|false}
    """
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    article = get_article(real_article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    make_public = bool(payload.get('public', True))
    new_slug: str | None
    if make_public:
        new_slug = article.get('publicSlug') or _generate_public_slug()
    else:
        new_slug = None
    with CONN:
        CONN.execute(
            'UPDATE articles SET public_slug = ?, updated_at = ? WHERE id = ?',
            (new_slug, datetime.utcnow().isoformat(), real_article_id),
        )
    updated = get_article(real_article_id, current_user.id)
    if not updated:
        raise HTTPException(status_code=404, detail='Article not found')
    return _present_article(updated, article_id)


# Вынесено из app/main.py → app/routers/public.py
@router.get('/api/public/articles/{slug}')
def read_public_article(slug: str):
    """
    Публичное чтение статьи по её slug без авторизации.
    Возвращает только данные статьи и блоков; редактирование на клиенте отключается.
    """
    row = _get_public_article_row(slug)
    if not row:
        raise HTTPException(status_code=404, detail='Article not found')
    article = build_article_from_row(row)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    return _present_article(article, article.get('id', ''))


# Вынесено из app/main.py → app/routers/public.py
@router.get('/p/{slug}')
def read_public_article_page(slug: str):
    """
    HTML-страница для публичного просмотра статьи по её slug.
    Не требует авторизации.
    """
    row = _get_public_article_row(slug)
    if not row:
        raise HTTPException(status_code=404, detail='Article not found')
    article = build_article_from_row(row)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    html = _build_public_article_html(article)
    return Response(content=html, media_type='text/html')

