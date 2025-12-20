from __future__ import annotations

import os
import re

import httpx

from .embeddings import EmbeddingsUnavailable

OPENAI_API_KEY = os.environ.get('SERVPY_OPENAI_API_KEY') or os.environ.get('OPENAI_API_KEY') or ''
OPENAI_BASE_URL = os.environ.get('SERVPY_OPENAI_BASE_URL') or 'https://api.openai.com/v1'
OUTLINE_TITLE_MODEL = os.environ.get('SERVPY_OUTLINE_TITLE_MODEL') or 'gpt-4o-mini'
OUTLINE_TITLE_TIMEOUT_SECONDS = float(os.environ.get('SERVPY_OUTLINE_TITLE_TIMEOUT_SECONDS') or '20')
OUTLINE_PROOFREAD_MODEL = os.environ.get('SERVPY_OUTLINE_PROOFREAD_MODEL') or 'gpt-4o-mini'
OUTLINE_PROOFREAD_TIMEOUT_SECONDS = float(os.environ.get('SERVPY_OUTLINE_PROOFREAD_TIMEOUT_SECONDS') or '25')

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


def _clean_title(title: str) -> str:
    t = (title or '').strip()
    # убираем кавычки/обрамления, если модель вернула их
    t = t.strip('“”"\'` ')
    t = re.sub(r'\s+', ' ', t).strip()
    if len(t) > 200:
        t = t[:200].rsplit(' ', 1)[0].strip() or t[:200]
    return t


def generate_outline_title_ru(*, body_text: str) -> str:
    if not OPENAI_API_KEY:
        raise EmbeddingsUnavailable('OpenAI API key не задан (SERVPY_OPENAI_API_KEY/OPENAI_API_KEY)')
    text = (body_text or '').strip()
    if not text:
        return ''
    # Ограничиваем размер входа, чтобы не улетать в стоимость.
    if len(text) > 6000:
        text = text[:6000]

    system = (
        'Ты — помощник, который придумывает короткие заголовки.\n'
        'Составь КРАТКИЙ заголовок для следующего фрагмента текста на русском языке. \n'
        'Язык: русский.\n'
        'Ограничение: не более 200 символов, (plain text), без кавычек, без markdown.'
        'Требования:\n'
        'Только по прямому смыслу текста.\n'
        'Без художественных выражений, метафор и оценок.\n'
        'Без добавления новых фактов.\n'
        'Без кликабейтности.\n'
        'до 8 слов.\n'
        'Если заголовок нельзя сделать без домыслов, перефразируй часть текста в виде нейтрального заголовка, сохраняя исходный смысл.'
    )
    user = 'придумай один короткий заголовок для текста (не более 200 символов, на русском языке) :\n' + text

    url = f'{OPENAI_BASE_URL.rstrip("/")}/chat/completions'
    payload = {
        'model': OUTLINE_TITLE_MODEL,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'temperature': 0.2,
        'max_tokens': 120,
    }
    try:
        with httpx.Client(timeout=OUTLINE_TITLE_TIMEOUT_SECONDS, proxies=_httpx_proxies()) as client:
            resp = client.post(
                url,
                headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {OPENAI_API_KEY}'},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        raise EmbeddingsUnavailable(f'OpenAI title недоступен: {exc!r}') from exc
    except Exception as exc:  # noqa: BLE001
        raise EmbeddingsUnavailable(f'OpenAI title: {exc!r}') from exc

    try:
        choices = data.get('choices') if isinstance(data, dict) else None
        msg = (choices or [])[0].get('message') if choices else None
        content = (msg or {}).get('content') if isinstance(msg, dict) else None
    except Exception:
        content = None
    if not isinstance(content, str) or not content.strip():
        raise EmbeddingsUnavailable('OpenAI title вернул пустой ответ')
    return _clean_title(content)


def _clean_html_response(html: str) -> str:
    s = (html or '').strip()
    if not s:
        return ''
    # убираем code fences, если модель вернула их
    if s.startswith('```'):
        s = re.sub(r'^```[a-zA-Z0-9_-]*\n', '', s).strip()
        s = re.sub(r'\n```$', '', s).strip()
    return s


def proofread_outline_html_ru(*, html: str) -> str:
    if not OPENAI_API_KEY:
        raise EmbeddingsUnavailable('OpenAI API key не задан (SERVPY_OPENAI_API_KEY/OPENAI_API_KEY)')
    text = (html or '').strip()
    if not text:
        return ''
    # Ограничиваем размер входа, чтобы не улетать в стоимость.
    if len(text) > 12000:
        text = text[:12000]

    system = (
        'Ты — редактор, который исправляет ошибки в русском тексте, сохраняя HTML.\n'
        'Верни только исправленный HTML, без markdown и без пояснений.\n'
        'Нельзя добавлять новые слова, удалять существующие или менять их порядок.\n'
        'Можно удалять только дубликаты подряд идущих одинаковых слов.\n'
        'Нельзя нарушать существующую HTML-разметку.'
    )
    user = (
        'Исправь ВСЕ следующие ошибки в тексте на русском языке, НЕ добавляя новые слова, '
        'НЕ удаляя существующие слова и НЕ меняя их порядок и НЕ нарушая HTML разметку:\n\n'
        '1. Орфография (опечатки, замены букв)\n\n'
        '2. Пунктуация (точки, запятые, тире, кавычки)\n\n'
        '3. Заглавные буквы (начало предложений, имена собственные)\n\n'
        '4. Повторы слов (удали дубликаты подряд идущих одинаковых слов)\n\n'
        '5. Согласование падежей, чисел, родов (только если слово уже есть)\n\n'
        'Правила:\n\n'
        '- Меняй ТОЛЬКО слова, которые уже есть в тексте\n\n'
        '- НЕ добавляй новые слова или фразы\n\n'
        '- НЕ удаляй смысловые слова (только повторы)\n\n'
        '- НЕ перефразируй предложения\n\n'
        '- Сохрани все существующие сокращения, имена, числа\n\n'
        'Текст для исправления:\n\n'
        + text
    )

    url = f'{OPENAI_BASE_URL.rstrip("/")}/chat/completions'
    payload = {
        'model': OUTLINE_PROOFREAD_MODEL,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'temperature': 0.0,
        'max_tokens': 4000,
    }
    try:
        with httpx.Client(timeout=OUTLINE_PROOFREAD_TIMEOUT_SECONDS, proxies=_httpx_proxies()) as client:
            resp = client.post(
                url,
                headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {OPENAI_API_KEY}'},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        raise EmbeddingsUnavailable(f'OpenAI proofread недоступен: {exc!r}') from exc
    except Exception as exc:  # noqa: BLE001
        raise EmbeddingsUnavailable(f'OpenAI proofread: {exc!r}') from exc

    try:
        choices = data.get('choices') if isinstance(data, dict) else None
        msg = (choices or [])[0].get('message') if choices else None
        content = (msg or {}).get('content') if isinstance(msg, dict) else None
    except Exception:
        content = None
    if not isinstance(content, str) or not content.strip():
        raise EmbeddingsUnavailable('OpenAI proofread вернул пустой ответ')
    return _clean_html_response(content)
