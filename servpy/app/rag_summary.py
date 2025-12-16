from __future__ import annotations

import os
from typing import Any, Dict, List

import httpx

from .embeddings import EmbeddingsUnavailable
from .text_utils import strip_html

OPENAI_API_KEY = os.environ.get('SERVPY_OPENAI_API_KEY') or os.environ.get('OPENAI_API_KEY') or ''
OPENAI_BASE_URL = os.environ.get('SERVPY_OPENAI_BASE_URL') or 'https://api.openai.com/v1'
RAG_SUMMARY_MODEL = os.environ.get('SERVPY_RAG_SUMMARY_MODEL') or 'gpt-4o-mini'
RAG_SUMMARY_TIMEOUT_SECONDS = float(os.environ.get('SERVPY_RAG_SUMMARY_TIMEOUT_SECONDS') or '60')
RAG_SUMMARY_MAX_BLOCKS = int(os.environ.get('SERVPY_RAG_SUMMARY_MAX_BLOCKS') or '40')
RAG_SUMMARY_MAX_TOTAL_CHARS = int(os.environ.get('SERVPY_RAG_SUMMARY_MAX_TOTAL_CHARS') or '24000')
RAG_SUMMARY_MAX_BLOCK_CHARS = int(os.environ.get('SERVPY_RAG_SUMMARY_MAX_BLOCK_CHARS') or '2000')

HTTP_PROXY = os.environ.get('SERVPY_HTTP_PROXY') or os.environ.get('HTTP_PROXY') or ''
HTTPS_PROXY = os.environ.get('SERVPY_HTTPS_PROXY') or os.environ.get('HTTPS_PROXY') or ''
ALL_PROXY = os.environ.get('SERVPY_ALL_PROXY') or os.environ.get('ALL_PROXY') or ''


def _httpx_proxies() -> str | dict | None:
    if ALL_PROXY:
        return ALL_PROXY
    if HTTP_PROXY or HTTPS_PROXY:
        proxies: dict[str, str] = {}
        if HTTP_PROXY:
            proxies['http://'] = HTTP_PROXY
        if HTTPS_PROXY:
            proxies['https://'] = HTTPS_PROXY
        return proxies
    return None


def _coerce_blocks(query: str, results: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    items = []
    for r in results or []:
        if not isinstance(r, dict):
            continue
        if r.get('type') and r.get('type') != 'block':
            continue
        text_html = r.get('blockText') or r.get('snippet') or ''
        plain = strip_html(text_html).strip()
        if not plain:
            continue
        title = (r.get('articleTitle') or '').strip()
        items.append({'title': title, 'text': plain})

    if not items:
        return []

    # Сначала берём более релевантные (предполагаем что результаты уже отсортированы).
    items = items[: max(1, int(RAG_SUMMARY_MAX_BLOCKS))]

    # Ограничиваем общий объём, чтобы не превышать лимиты модели и стоимости.
    clipped = []
    total = 0
    for it in items:
        text = it['text']
        if len(text) > RAG_SUMMARY_MAX_BLOCK_CHARS:
            text = text[: RAG_SUMMARY_MAX_BLOCK_CHARS].rsplit(' ', 1)[0].strip() or text[: RAG_SUMMARY_MAX_BLOCK_CHARS]
        title = it['title']
        chunk = f'[{title}]\n{text}' if title else text
        if total + len(chunk) > RAG_SUMMARY_MAX_TOTAL_CHARS:
            break
        clipped.append({'title': title, 'text': text})
        total += len(chunk)
    return clipped


def summarize_search_results(*, query: str, results: List[Dict[str, Any]]) -> str:
    if not OPENAI_API_KEY:
        raise EmbeddingsUnavailable('OpenAI API key не задан (SERVPY_OPENAI_API_KEY/OPENAI_API_KEY)')

    q = (query or '').strip()
    blocks = _coerce_blocks(q, results or [])
    if not blocks:
        return '<p class="meta">Нет текста для резюме.</p>'

    context_lines: List[str] = []
    for i, b in enumerate(blocks, start=1):
        title = b.get('title') or ''
        text = b.get('text') or ''
        if title:
            context_lines.append(f'{i}. {title}\n{text}')
        else:
            context_lines.append(f'{i}. {text}')
    context = '\n\n'.join(context_lines).strip()

    system = (
        'Ты — помощник, который делает краткое изложение найденных фрагментов.\n'
        'Верни только HTML (без markdown), без внешних ссылок.\n'
        'Стиль: коротко, по делу, на русском.\n'
        'Формат: сначала 1-2 предложения, затем <ul><li>...</li></ul> с 5-12 пунктами.\n'
        'Если данные противоречат — добавь отдельный пункт "Противоречия".'
    )
    user = (
        f'Запрос пользователя: {q or "—"}\n\n'
        'Фрагменты:\n'
        f'{context}\n\n'
        'Сделай резюме по всем фрагментам.'
    )

    url = f'{OPENAI_BASE_URL.rstrip("/")}/chat/completions'
    payload = {
        'model': RAG_SUMMARY_MODEL,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'temperature': 0.2,
    }
    try:
        with httpx.Client(timeout=RAG_SUMMARY_TIMEOUT_SECONDS, proxies=_httpx_proxies()) as client:
            resp = client.post(
                url,
                headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {OPENAI_API_KEY}'},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        raise EmbeddingsUnavailable(f'OpenAI summary недоступен: {exc!r}') from exc
    except Exception as exc:  # noqa: BLE001
        raise EmbeddingsUnavailable(f'OpenAI summary: {exc!r}') from exc

    try:
        choices = data.get('choices') if isinstance(data, dict) else None
        msg = (choices or [])[0].get('message') if choices else None
        content = (msg or {}).get('content') if isinstance(msg, dict) else None
    except Exception:
        content = None
    if not isinstance(content, str) or not content.strip():
        raise EmbeddingsUnavailable('OpenAI summary вернул пустой ответ')
    return content.strip()

