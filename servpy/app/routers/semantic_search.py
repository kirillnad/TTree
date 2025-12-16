from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import User, get_current_user
from ..embeddings import EmbeddingsUnavailable, probe_embedding_info
from ..rag_summary import summarize_search_results
from ..semantic_search import get_reindex_task, request_cancel_reindex_task, start_reindex_task, try_semantic_search
from ..telegram_notify import notify_user

# Вынесено из app/main.py → app/routers/semantic_search.py

router = APIRouter()


class RagSummaryRequest(BaseModel):
    query: str = ''
    results: list[dict] = []

class SemanticReindexRequest(BaseModel):
    mode: str = 'all'  # 'all' | 'missing'


@router.get('/api/search/semantic')
def semantic_search(q: str = '', current_user: User = Depends(get_current_user)):
    query = (q or '').strip()
    if not query:
        return []
    try:
        return try_semantic_search(current_user.id, query, limit=30)
    except EmbeddingsUnavailable as exc:
        notify_user(current_user.id, f'Семантический поиск: embeddings недоступны — {exc}', key='semantic-search')
        raise HTTPException(
            status_code=503,
            detail=(
                'Семантический поиск недоступен: не удалось получить embeddings локально. '
                'Настройте OpenAI embeddings '
                '(SERVPY_OPENAI_API_KEY/OPENAI_API_KEY, SERVPY_OPENAI_EMBED_MODEL, SERVPY_EMBEDDING_DIM). '
                f'Детали: {exc}'
            ),
        )
    except Exception as exc:  # noqa: BLE001
        notify_user(current_user.id, f'Семантический поиск: ошибка — {exc!r}', key='semantic-search')
        raise HTTPException(status_code=503, detail=f'Семантический поиск недоступен: {exc}')


@router.get('/api/search/semantic/embed-info')
def semantic_embed_info(current_user: User = Depends(get_current_user)):
    """
    Диагностика: возвращает фактическую размерность embeddings у текущего провайдера (Gemini),
    чтобы правильно выставить SERVPY_EMBEDDING_DIM и vector(N) в БД.
    """
    try:
        return probe_embedding_info('test')
    except EmbeddingsUnavailable as exc:
        notify_user(current_user.id, f'Gemini embeddings: probe failed — {exc}', key='semantic-search')
        raise HTTPException(status_code=503, detail=str(exc))


@router.post('/api/search/semantic/reindex')
def semantic_reindex(payload: SemanticReindexRequest | None = None, current_user: User = Depends(get_current_user)):
    try:
        # Стартует асинхронную задачу (или вернёт уже запущенную),
        # чтобы клиент не висел и не падал по таймаутам.
        mode = (payload.mode if payload else 'all') or 'all'
        return start_reindex_task(current_user.id, mode=mode)
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


@router.post('/api/search/semantic/rag-summary')
def semantic_rag_summary(payload: RagSummaryRequest, current_user: User = Depends(get_current_user)):
    try:
        html = summarize_search_results(query=payload.query or '', results=payload.results or [])
        return {'summaryHtml': html}
    except EmbeddingsUnavailable as exc:
        notify_user(current_user.id, f'RAG summary: недоступно — {exc}', key='rag-summary')
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        notify_user(current_user.id, f'RAG summary: ошибка — {exc!r}', key='rag-summary')
        raise HTTPException(status_code=503, detail=f'RAG summary: {exc!r}')
