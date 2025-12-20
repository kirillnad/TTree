from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..auth import User, get_current_user
from ..embeddings import EmbeddingsUnavailable
from ..title_generation import generate_outline_title_ru, proofread_outline_html_ru

router = APIRouter()


@router.post('/api/outline/generate-title')
def post_generate_outline_title(payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    text = payload.get('text') if payload else None
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail='text must be string')
    try:
        title = generate_outline_title_ru(body_text=text)
    except EmbeddingsUnavailable as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {'title': title or ''}


@router.post('/api/outline/proofread-html')
def post_outline_proofread_html(payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    html = payload.get('html') if payload else None
    if not isinstance(html, str):
        raise HTTPException(status_code=400, detail='html must be string')
    try:
        corrected = proofread_outline_html_ru(html=html)
    except EmbeddingsUnavailable as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {'html': corrected or ''}
