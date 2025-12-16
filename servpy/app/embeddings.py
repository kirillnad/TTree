from __future__ import annotations

import math
import os
from typing import Iterable, List

import httpx

# Embeddings провайдер:
#   - OpenAI (если задан SERVPY_OPENAI_API_KEY/OPENAI_API_KEY)
#   - иначе Gemini (если задан SERVPY_GEMINI_API_KEY)
#
# Для Google Gemini используется Generative Language API:
#   https://generativelanguage.googleapis.com/v1beta/models/<model>:embedContent
#   https://generativelanguage.googleapis.com/v1beta/models/<model>:batchEmbedContents
#
# Env (OpenAI):
#   SERVPY_OPENAI_API_KEY / OPENAI_API_KEY (обязателен для OpenAI)
#   SERVPY_OPENAI_EMBED_MODEL (по умолчанию text-embedding-3-small)
#   SERVPY_OPENAI_BASE_URL (по умолчанию https://api.openai.com/v1)
#   SERVPY_OPENAI_TIMEOUT_SECONDS (по умолчанию 30)
#
# Env (Gemini):
#   SERVPY_GEMINI_API_KEY (обязателен)
#   SERVPY_GEMINI_EMBED_MODEL (по умолчанию text-embedding-004)
#   SERVPY_EMBEDDING_DIM (ожидаемая размерность; проверяется)
#   SERVPY_EMBEDDING_MAX_CHARS (размер чанка текста, по умолчанию 12000)
#   SERVPY_EMBEDDING_CHUNK_OVERLAP_CHARS (overlap между чанками, по умолчанию 200)
#   SERVPY_GEMINI_TIMEOUT_SECONDS (по умолчанию 30)
#
# Примечание: для бесплатного tier надо получить API key в Google AI Studio.

OPENAI_API_KEY = os.environ.get('SERVPY_OPENAI_API_KEY') or os.environ.get('OPENAI_API_KEY') or ''
OPENAI_EMBED_MODEL = os.environ.get('SERVPY_OPENAI_EMBED_MODEL') or 'text-embedding-3-small'
OPENAI_BASE_URL = os.environ.get('SERVPY_OPENAI_BASE_URL') or 'https://api.openai.com/v1'
OPENAI_TIMEOUT_SECONDS = float(os.environ.get('SERVPY_OPENAI_TIMEOUT_SECONDS') or '30')

GEMINI_API_KEY = os.environ.get('SERVPY_GEMINI_API_KEY') or ''
GEMINI_EMBED_MODEL = os.environ.get('SERVPY_GEMINI_EMBED_MODEL') or 'text-embedding-004'

EMBEDDING_DIM = int(os.environ.get('SERVPY_EMBEDDING_DIM') or '768')
EMBEDDING_MAX_CHARS = int(os.environ.get('SERVPY_EMBEDDING_MAX_CHARS') or '12000')
EMBEDDING_CHUNK_OVERLAP_CHARS = int(os.environ.get('SERVPY_EMBEDDING_CHUNK_OVERLAP_CHARS') or '200')
GEMINI_TIMEOUT_SECONDS = float(os.environ.get('SERVPY_GEMINI_TIMEOUT_SECONDS') or '30')
HTTP_PROXY = os.environ.get('SERVPY_HTTP_PROXY') or os.environ.get('HTTP_PROXY') or ''
HTTPS_PROXY = os.environ.get('SERVPY_HTTPS_PROXY') or os.environ.get('HTTPS_PROXY') or ''
ALL_PROXY = os.environ.get('SERVPY_ALL_PROXY') or os.environ.get('ALL_PROXY') or ''
EMBEDDINGS_API_BATCH_SIZE = int(os.environ.get('SERVPY_EMBEDDINGS_API_BATCH_SIZE') or '64')


def _httpx_proxies() -> str | dict | None:
    """
    Возвращает proxy-конфиг для httpx.
    Поддерживаем env:
      - SERVPY_HTTPS_PROXY / SERVPY_HTTP_PROXY (приоритет)
      - HTTPS_PROXY / HTTP_PROXY (fallback)
      - SERVPY_ALL_PROXY / ALL_PROXY
    """
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


def _redact_key(url: str) -> str:
    if not url:
        return url
    # Прячем API key в query string (?key=...).
    return url.replace(f'key={GEMINI_API_KEY}', 'key=***') if GEMINI_API_KEY else url


class EmbeddingsUnavailable(RuntimeError):
    pass


class EmbeddingInputUnsupported(ValueError):
    """
    Ошибка, означающая что конкретный input нельзя эмбеддить (например, зашифрованный текст).
    Эту ошибку можно считать "нефатальной" для переиндексации: блок пропускаем, но сервис живёт.
    """


def _normalize_l2(vec: List[float]) -> List[float]:
    s = 0.0
    for x in vec:
        s += x * x
    if s <= 0:
        return vec
    inv = 1.0 / math.sqrt(s)
    return [x * inv for x in vec]


def _split_into_chunks(text: str, max_chars: int) -> List[str]:
    raw = (text or '').strip()
    if not raw:
        return []
    if len(raw) <= max_chars:
        return [raw]

    parts = [p.strip() for p in raw.split('\n\n') if p.strip()]
    if not parts:
        parts = [raw]

    chunks: List[str] = []
    current: List[str] = []
    current_len = 0
    for part in parts:
        if len(part) > max_chars:
            if current:
                chunks.append('\n\n'.join(current).strip())
                current = []
                current_len = 0
            for i in range(0, len(part), max_chars):
                piece = part[i : i + max_chars].strip()
                if piece:
                    chunks.append(piece)
            continue

        extra = len(part) + (2 if current else 0)
        if current_len + extra <= max_chars:
            current.append(part)
            current_len += extra
            continue

        if current:
            chunks.append('\n\n'.join(current).strip())
        current = [part]
        current_len = len(part)

    if current:
        chunks.append('\n\n'.join(current).strip())

    if EMBEDDING_CHUNK_OVERLAP_CHARS > 0 and len(chunks) > 1:
        overlapped: List[str] = []
        prev_tail = ''
        for chunk in chunks:
            head = chunk
            if prev_tail:
                head = (prev_tail + '\n' + chunk).strip()
                if len(head) > max_chars:
                    head = head[-max_chars:]
            overlapped.append(head)
            prev_tail = chunk[-EMBEDDING_CHUNK_OVERLAP_CHARS :]
        chunks = overlapped

    return [c for c in chunks if c]


def _gemini_model_path() -> str:
    model = (GEMINI_EMBED_MODEL or '').strip()
    if not model:
        model = 'text-embedding-004'
    if model.startswith('models/'):
        return model
    return f'models/{model}'


def _gemini_base_url() -> str:
    return 'https://generativelanguage.googleapis.com'


def _gemini_headers() -> dict[str, str]:
    return {
        'Content-Type': 'application/json',
    }


def _extract_embedding_values(obj) -> List[float]:
    if not isinstance(obj, dict):
        raise EmbeddingsUnavailable('Gemini вернул некорректный ответ (не объект)')
    emb = obj.get('embedding')
    if isinstance(emb, dict):
        values = emb.get('values')
    else:
        values = obj.get('values')
    if not isinstance(values, list) or not values:
        raise EmbeddingsUnavailable('Gemini вернул пустой embedding')
    try:
        vec = [float(x) for x in values]
    except Exception as exc:  # noqa: BLE001
        raise EmbeddingsUnavailable('Gemini вернул embedding в неверном формате') from exc
    if len(vec) != EMBEDDING_DIM:
        raise EmbeddingsUnavailable(f'Размер embedding {len(vec)} не совпадает с SERVPY_EMBEDDING_DIM={EMBEDDING_DIM}.')
    return vec


def probe_embedding_info(text: str = 'test') -> dict[str, object]:
    """
    Делает один пробный запрос embeddings к активному провайдеру и возвращает
    фактическую размерность, чтобы правильно выставить SERVPY_EMBEDDING_DIM и vector(N).
    Не использует SERVPY_EMBEDDING_DIM для валидации.
    """
    prompt = (text or '').strip() or 'test'

    if OPENAI_API_KEY:
        url = f'{OPENAI_BASE_URL.rstrip("/")}/embeddings'
        payload = {'model': OPENAI_EMBED_MODEL, 'input': [prompt]}
        try:
            with httpx.Client(timeout=OPENAI_TIMEOUT_SECONDS, proxies=_httpx_proxies()) as client:
                resp = client.post(
                    url,
                    headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {OPENAI_API_KEY}'},
                    json=payload,
                )
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as exc:
            try:
                body = exc.response.json()
                code = ((body or {}).get('error') or {}).get('code')
                if code == 'invalid_encrypted_content':
                    raise EmbeddingInputUnsupported('OpenAI отклонил зашифрованный input (invalid_encrypted_content)') from exc
            except Exception:
                pass
            raise EmbeddingsUnavailable(f'OpenAI embeddings недоступны: {exc!r}') from exc
        except httpx.HTTPError as exc:
            raise EmbeddingsUnavailable(f'OpenAI embeddings недоступны: {exc!r}') from exc
        except Exception as exc:  # noqa: BLE001
            raise EmbeddingsUnavailable(f'OpenAI embeddings: {exc!r}') from exc

        items = data.get('data') if isinstance(data, dict) else None
        if not isinstance(items, list) or not items or not isinstance(items[0], dict):
            raise EmbeddingsUnavailable('OpenAI вернул неожиданный ответ embeddings')
        emb = items[0].get('embedding')
        if not isinstance(emb, list) or not emb:
            raise EmbeddingsUnavailable('OpenAI вернул пустой embedding')
        return {'provider': 'openai', 'model': OPENAI_EMBED_MODEL, 'dim': len(emb)}

    if not GEMINI_API_KEY:
        raise EmbeddingsUnavailable('Не настроен провайдер embeddings: задайте SERVPY_OPENAI_API_KEY или SERVPY_GEMINI_API_KEY')

    model_path = _gemini_model_path()
    url = f'{_gemini_base_url()}/v1beta/{model_path}:embedContent'
    params = {'key': GEMINI_API_KEY}
    payload = {
        'model': model_path,
        'content': {'parts': [{'text': prompt}]},
    }
    try:
        with httpx.Client(timeout=GEMINI_TIMEOUT_SECONDS, proxies=_httpx_proxies()) as client:
            resp = client.post(url, params=params, headers=_gemini_headers(), json=payload)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        msg = repr(exc)
        if hasattr(exc, 'request') and exc.request is not None:
            msg = msg.replace(str(exc.request.url), _redact_key(str(exc.request.url)))
        raise EmbeddingsUnavailable(f'Gemini embeddings недоступны: {msg}') from exc
    except Exception as exc:  # noqa: BLE001
        raise EmbeddingsUnavailable(f'Gemini embeddings: {exc!r}') from exc

    if not isinstance(data, dict):
        raise EmbeddingsUnavailable('Gemini вернул некорректный ответ')
    emb = data.get('embedding')
    values = emb.get('values') if isinstance(emb, dict) else None
    if not isinstance(values, list) or not values:
        raise EmbeddingsUnavailable('Gemini вернул пустой embedding')
    return {'provider': 'gemini', 'model': model_path, 'dim': len(values)}


def embed_texts(texts: Iterable[str]) -> List[List[float]]:
    items = [(t or '').strip() for t in (texts or [])]
    items = [t for t in items if t]
    if not items:
        return []

    if OPENAI_API_KEY:
        url = f'{OPENAI_BASE_URL.rstrip("/")}/embeddings'
        payload = {'model': OPENAI_EMBED_MODEL, 'input': items}
        try:
            with httpx.Client(timeout=OPENAI_TIMEOUT_SECONDS, proxies=_httpx_proxies()) as client:
                resp = client.post(
                    url,
                    headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {OPENAI_API_KEY}'},
                    json=payload,
                )
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as exc:
            try:
                body = exc.response.json()
                code = ((body or {}).get('error') or {}).get('code')
                if code == 'invalid_encrypted_content':
                    raise EmbeddingInputUnsupported('OpenAI отклонил зашифрованный input (invalid_encrypted_content)') from exc
            except Exception:
                pass
            raise EmbeddingsUnavailable(f'OpenAI embeddings недоступны: {exc!r}') from exc
        except httpx.HTTPError as exc:
            raise EmbeddingsUnavailable(f'OpenAI embeddings недоступны: {exc!r}') from exc
        except Exception as exc:  # noqa: BLE001
            raise EmbeddingsUnavailable(f'OpenAI embeddings: {exc!r}') from exc

        rows = data.get('data') if isinstance(data, dict) else None
        if not isinstance(rows, list) or len(rows) != len(items):
            raise EmbeddingsUnavailable('OpenAI вернул неожиданный ответ embeddings')
        ordered = sorted(rows, key=lambda x: int(x.get('index', 0)) if isinstance(x, dict) else 0)
        vectors: List[List[float]] = []
        for row in ordered:
            if not isinstance(row, dict):
                continue
            emb = row.get('embedding')
            if not isinstance(emb, list) or not emb:
                raise EmbeddingsUnavailable('OpenAI вернул пустой embedding')
            vec = [float(x) for x in emb]
            if len(vec) != EMBEDDING_DIM:
                raise EmbeddingsUnavailable(
                    f'Размер embedding {len(vec)} не совпадает с SERVPY_EMBEDDING_DIM={EMBEDDING_DIM}. '
                    'Выставьте SERVPY_EMBEDDING_DIM под модель и пересоздайте block_embeddings под vector(N).'
                )
            vectors.append(vec)
        if len(vectors) != len(items):
            raise EmbeddingsUnavailable('OpenAI вернул неверное количество embeddings')
        return vectors

    if not GEMINI_API_KEY:
        raise EmbeddingsUnavailable('Gemini API key не задан (SERVPY_GEMINI_API_KEY)')

    model_path = _gemini_model_path()
    url = f'{_gemini_base_url()}/v1beta/{model_path}:batchEmbedContents'
    params = {'key': GEMINI_API_KEY}
    payload = {
        'requests': [
            {
                'model': model_path,
                'content': {'parts': [{'text': t}]},
            }
            for t in items
        ]
    }
    try:
        with httpx.Client(timeout=GEMINI_TIMEOUT_SECONDS, proxies=_httpx_proxies()) as client:
            resp = client.post(url, params=params, headers=_gemini_headers(), json=payload)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        msg = repr(exc)
        if hasattr(exc, 'request') and exc.request is not None:
            msg = msg.replace(str(exc.request.url), _redact_key(str(exc.request.url)))
        raise EmbeddingsUnavailable(f'Gemini embeddings недоступны: {msg}') from exc
    except Exception as exc:  # noqa: BLE001
        raise EmbeddingsUnavailable(f'Gemini embeddings: {exc!r}') from exc

    embeddings = data.get('embeddings') if isinstance(data, dict) else None
    if not isinstance(embeddings, list) or len(embeddings) != len(items):
        raise EmbeddingsUnavailable('Gemini вернул неожиданный batch-ответ embeddings')
    return [_extract_embedding_values(e) for e in embeddings]


def embed_text(text: str) -> List[float]:
    prompt = (text or '').strip()
    if not prompt:
        return [0.0] * EMBEDDING_DIM

    chunks = _split_into_chunks(prompt, EMBEDDING_MAX_CHARS)
    if not chunks:
        return [0.0] * EMBEDDING_DIM
    if len(chunks) == 1:
        vec = embed_texts([chunks[0]])[0]
        return _normalize_l2(vec)

    vectors = embed_texts(chunks)
    acc = [0.0] * EMBEDDING_DIM
    for vec in vectors:
        for i, x in enumerate(vec):
            acc[i] += x
    avg = [x / max(1, len(vectors)) for x in acc]
    return _normalize_l2(avg)


def embed_text_batch(texts: List[str]) -> List[List[float]]:
    """
    Возвращает embeddings для каждого текста, сохраняя семантику embed_text():
    - split на чанки > EMBEDDING_MAX_CHARS
    - эмбеддим чанки батчами
    - усредняем embedding чанков
    - L2-нормализация результата
    """
    items = [(t or '').strip() for t in (texts or [])]
    if not items:
        return []

    chunks_by_item: List[List[str]] = [_split_into_chunks(t, EMBEDDING_MAX_CHARS) for t in items]
    flat_chunks: List[str] = []
    offsets: List[tuple[int, int]] = []
    cur = 0
    for chunks in chunks_by_item:
        start = cur
        for c in chunks:
            if c:
                flat_chunks.append(c)
                cur += 1
        offsets.append((start, cur))

    if not flat_chunks:
        return [[0.0] * EMBEDDING_DIM for _ in items]

    # Не отправляем слишком большие input-массивы в один запрос.
    batch_size = max(1, int(EMBEDDINGS_API_BATCH_SIZE))
    flat_vectors: List[List[float]] = []
    for i in range(0, len(flat_chunks), batch_size):
        flat_vectors.extend(embed_texts(flat_chunks[i : i + batch_size]))

    out: List[List[float]] = []
    for (start, end), original in zip(offsets, items):
        if not original:
            out.append([0.0] * EMBEDDING_DIM)
            continue
        if end <= start:
            out.append([0.0] * EMBEDDING_DIM)
            continue
        if end - start == 1:
            out.append(_normalize_l2(flat_vectors[start]))
            continue
        acc = [0.0] * EMBEDDING_DIM
        n = 0
        for vec in flat_vectors[start:end]:
            n += 1
            for j, x in enumerate(vec):
                acc[j] += x
        avg = [x / max(1, n) for x in acc]
        out.append(_normalize_l2(avg))
    return out
