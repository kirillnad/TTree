from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from ..auth import User
from ..data_store import (
    ArticleNotFound,
    BlockNotFound,
    InvalidOperation,
    get_or_create_user_inbox,
)


# Вынесено из app/main.py → app/routers/common.py
def _resolve_article_id_for_user(article_id: str, current_user: User) -> str:
    """
    Преобразует «публичный» идентификатор статьи из URL в фактический ID в БД.
    Для inbox клиент всегда использует article_id == "inbox", а в базе хранится
    отдельная статья на пользователя с ID вида "inbox-<user_id>".
    """
    if article_id == 'inbox':
        inbox_article = get_or_create_user_inbox(current_user.id)
        return inbox_article['id']
    return article_id


# Вынесено из app/main.py → app/routers/common.py
def _present_article(article: dict[str, Any] | None, requested_id: str) -> dict[str, Any]:
    """
    Нормализует JSON статьи перед отдачей клиенту.
    Для inbox скрываем внутренний ID и всегда возвращаем id == "inbox",
    чтобы вся клиентская логика могла опираться на это стабильное значение.
    """
    if not article:
        return {}
    if requested_id == 'inbox':
        article = dict(article)
        article['id'] = 'inbox'
    return article


# Вынесено из app/main.py → app/routers/common.py
def _handle_undo_redo(func, article_id, entry_id):
    try:
        result = func(article_id, entry_id)
        if not result:
            raise InvalidOperation('Nothing to undo')
        block_id = result.get('blockId') or result.get('id')
        block_payload = result.get('block') or {
            'id': block_id,
            **{k: v for k, v in result.items() if k != 'blockId'},
        }
        return {'blockId': block_id, 'block': block_payload}
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

