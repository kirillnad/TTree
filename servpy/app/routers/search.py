from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..auth import User, get_current_user
from ..data_store import search_everything

router = APIRouter()


# Вынесено из app/main.py → app/routers/search.py
@router.get('/api/search')
def get_search(q: str = '', current_user: User = Depends(get_current_user)):
    query = q.strip()
    if not query:
        return []
    return search_everything(query, block_limit=30, article_limit=15, author_id=current_user.id)
