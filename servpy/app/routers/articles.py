from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

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
)
from .common import _present_article, _resolve_article_id_for_user

router = APIRouter()


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
    article = create_article(payload.get('title'), current_user.id)
    return article


# Вынесено из app/main.py → app/routers/articles.py
@router.get('/api/articles/{article_id}')
def read_article(article_id: str, current_user: User = Depends(get_current_user)):
    if article_id == 'inbox':
        article = get_or_create_user_inbox(current_user.id)
        if not article:
            raise HTTPException(status_code=404, detail='Article not found')
        return _present_article(article, article_id)
    article = get_article(article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    return article


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

