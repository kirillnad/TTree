from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..auth import User, get_current_user
from ..data_store import (
    ArticleNotFound,
    BlockNotFound,
    InvalidOperation,
    clear_block_trash,
    delete_block,
    delete_block_permanent,
    indent_block,
    insert_block,
    move_block,
    move_block_to_article,
    move_block_to_parent,
    outdent_block,
    replace_article_blocks_tree,
    redo_block_text_change,
    restore_block,
    restore_block_from_trash,
    undo_block_text_change,
    update_block,
    update_block_collapse,
    get_article,
)
from .common import _handle_undo_redo, _resolve_article_id_for_user

router = APIRouter()


# Вынесено из app/main.py → app/routers/blocks.py
@router.patch('/api/articles/{article_id}/blocks/{block_id}')
def patch_block(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    try:
        if not get_article(real_article_id, current_user.id):
            raise ArticleNotFound('Article not found')
        block = update_block(real_article_id, block_id, payload)
        return block
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


# Вынесено из app/main.py → app/routers/blocks.py
@router.patch('/api/articles/{article_id}/collapse')
def patch_collapse(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    block_id = payload.get('blockId')
    collapsed = payload.get('collapsed')
    if block_id is None or not isinstance(collapsed, bool):
        raise HTTPException(status_code=400, detail='Missing blockId or collapsed flag')
    try:
        block = update_block_collapse(real_article_id, block_id, collapsed)
        return block
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.put('/api/articles/{article_id}/blocks/replace-tree')
def put_replace_blocks_tree(
    article_id: str,
    payload: dict[str, Any],
    current_user: User = Depends(get_current_user),
):
    """
    Атомарно заменяет дерево блоков статьи.

    Нужен для outline-редактора: он редактирует всю статью как один документ и сохраняет дерево целиком.
    """
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    blocks = payload.get('blocks') if payload else None
    if not isinstance(blocks, list):
        raise HTTPException(status_code=400, detail='Missing blocks')
    try:
        result = replace_article_blocks_tree(
            article_id=real_article_id,
            author_id=current_user.id,
            blocks=blocks,
        )
        return result
    except ArticleNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidOperation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# Вынесено из app/main.py → app/routers/blocks.py
@router.post('/api/articles/{article_id}/blocks/{block_id}/siblings')
def post_sibling(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    direction = payload.get('direction', 'after') if payload else 'after'
    try:
        result = insert_block(real_article_id, block_id, direction, payload.get('payload') if payload else None)
        return result
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


# Вынесено из app/main.py → app/routers/blocks.py
@router.delete('/api/articles/{article_id}/blocks/{block_id}')
def remove_block(article_id: str, block_id: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        result = delete_block(real_article_id, block_id)
    except (ArticleNotFound, BlockNotFound) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not result:
        raise HTTPException(status_code=404, detail='Статья или блок не найдены')
    return result  # result может быть None, если декоратор не нашел статью


# Вынесено из app/main.py → app/routers/blocks.py
@router.delete('/api/articles/{article_id}/blocks/{block_id}/permanent')
def remove_block_permanent(article_id: str, block_id: str, current_user: User = Depends(get_current_user)):
    """
    Жёсткое удаление блока без помещения в корзину блоков статьи (blockTrash).
    Используется для пустых «мимолётных» блоков, которые никогда не содержали текста.
    """
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        result = delete_block_permanent(real_article_id, block_id)
    except (ArticleNotFound, BlockNotFound) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not result:
        raise HTTPException(status_code=404, detail='Статья или блок не найдены')
    return result


# Вынесено из app/main.py → app/routers/blocks.py
@router.post('/api/articles/{article_id}/blocks/trash/clear')
def clear_blocks_trash(article_id: str, current_user: User = Depends(get_current_user)):
    """
    Очищает корзину блоков для статьи (blockTrash).
    """
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        result = clear_block_trash(real_article_id)
    except ArticleNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return result


# Вынесено из app/main.py → app/routers/blocks.py
@router.post('/api/articles/{article_id}/blocks/{block_id}/move')
def post_move(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    direction = payload.get('direction')
    if direction not in {'up', 'down'}:
        raise HTTPException(status_code=400, detail='Unknown move direction')
    try:
        if not get_article(real_article_id, current_user.id):
            raise ArticleNotFound('Article not found')
        result = move_block(real_article_id, block_id, direction)
        return result
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# Вынесено из app/main.py → app/routers/blocks.py
@router.post('/api/articles/{article_id}/blocks/{block_id}/indent')
def post_indent(article_id: str, block_id: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        return indent_block(real_article_id, block_id)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# Вынесено из app/main.py → app/routers/blocks.py
@router.post('/api/articles/{article_id}/blocks/{block_id}/outdent')
def post_outdent(article_id: str, block_id: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        return outdent_block(real_article_id, block_id)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# Вынесено из app/main.py → app/routers/blocks.py
@router.post('/api/articles/{article_id}/blocks/{block_id}/relocate')
def post_relocate(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    target_parent_id = payload.get('parentId')
    target_index = payload.get('index')
    anchor_id = payload.get('anchorId')
    placement = payload.get('placement')
    try:
        return move_block_to_parent(real_article_id, block_id, target_parent_id, target_index, anchor_id, placement)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# Вынесено из app/main.py → app/routers/blocks.py
@router.post('/api/articles/{article_id}/blocks/undo-text')
def post_undo(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    entry_id = payload.get('entryId')
    return _handle_undo_redo(undo_block_text_change, real_article_id, entry_id)


# Вынесено из app/main.py → app/routers/blocks.py
@router.post('/api/articles/{article_id}/blocks/redo-text')
def post_redo(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    entry_id = payload.get('entryId')
    return _handle_undo_redo(redo_block_text_change, real_article_id, entry_id)


# Вынесено из app/main.py → app/routers/blocks.py
@router.post('/api/articles/{article_id}/blocks/restore')
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


# Вынесено из app/main.py → app/routers/blocks.py
@router.post('/api/articles/{article_id}/blocks/trash/restore')
def post_restore_from_trash(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    block_id = payload.get('id') or payload.get('blockId')
    if not block_id:
        raise HTTPException(status_code=400, detail='Missing block id')
    try:
        result = restore_block_from_trash(real_article_id, block_id)
        return result
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# Вынесено из app/main.py → app/routers/blocks.py
@router.post('/api/articles/{article_id}/blocks/{block_id}/move-to/{target_article_id}')
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
