from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..auth import User, get_current_user
from ..embeddings import EmbeddingsUnavailable
from ..semantic_search import get_reindex_task, request_cancel_reindex_task, start_reindex_task, try_semantic_search

# Вынесено из app/main.py → app/routers/semantic_search.py

router = APIRouter()


@router.get('/api/search/semantic')
def semantic_search(q: str = '', current_user: User = Depends(get_current_user)):
    query = (q or '').strip()
    if not query:
        return []
    try:
        return try_semantic_search(current_user.id, query, limit=30)
    except EmbeddingsUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                'Семантический поиск недоступен: не удалось получить embeddings локально. '
                'Запустите Ollama и установите модель для embeddings '
                '(SERVPY_OLLAMA_URL, SERVPY_OLLAMA_EMBED_MODEL, SERVPY_EMBEDDING_DIM). '
                f'Детали: {exc}'
            ),
        )


@router.post('/api/search/semantic/reindex')
def semantic_reindex(current_user: User = Depends(get_current_user)):
    try:
        # Стартует асинхронную задачу (или вернёт уже запущенную),
        # чтобы клиент не висел и не падал по таймаутам.
        return start_reindex_task(current_user.id)
    except EmbeddingsUnavailable as exc:
        raise HTTPException(status_code=503, detail=f'Embeddings недоступны: {exc}')
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=503,
            detail=(
                'Семантический поиск недоступен: не настроен pgvector/таблица embeddings. '
                'Установите расширение pgvector (CREATE EXTENSION vector) и перезапустите сервер. '
                f'Детали: {exc}'
            ),
        )


@router.get('/api/search/semantic/reindex/status')
def semantic_reindex_status(current_user: User = Depends(get_current_user)):
    task = get_reindex_task(current_user.id)
    if not task:
        return {'status': 'idle'}
    return task


@router.post('/api/search/semantic/reindex/cancel')
def semantic_reindex_cancel(current_user: User = Depends(get_current_user)):
    task = request_cancel_reindex_task(current_user.id)
    if not task:
        return {'status': 'idle'}
    return task
