from __future__ import annotations

import json
import os
import socket
import time
import urllib.error
import urllib.request
import math
from typing import Iterable, List

# Локальные embeddings через Ollama (по умолчанию).
# Вынесено в отдельный модуль, чтобы потом можно было заменить провайдера.

OLLAMA_URL = os.environ.get('SERVPY_OLLAMA_URL') or 'http://127.0.0.1:11434'
OLLAMA_EMBED_MODEL = os.environ.get('SERVPY_OLLAMA_EMBED_MODEL') or 'bge-m3'
EMBEDDING_DIM = int(os.environ.get('SERVPY_EMBEDDING_DIM') or '768')
EMBEDDING_TIMEOUT_SECONDS = float(os.environ.get('SERVPY_OLLAMA_TIMEOUT_SECONDS') or '60')
EMBEDDING_MAX_CHARS = int(os.environ.get('SERVPY_EMBEDDING_MAX_CHARS') or '12000')
EMBEDDING_RETRIES = int(os.environ.get('SERVPY_OLLAMA_RETRIES') or '2')
EMBEDDING_CHUNK_OVERLAP_CHARS = int(os.environ.get('SERVPY_EMBEDDING_CHUNK_OVERLAP_CHARS') or '200')


def _normalize_l2(vec: List[float]) -> List[float]:
    s = 0.0
    for x in vec:
        s += x * x
    if s <= 0:
        return vec
    inv = 1.0 / math.sqrt(s)
    return [x * inv for x in vec]


def _split_into_chunks(text: str, max_chars: int) -> List[str]:
    """
    Разбивает текст на фрагменты <= max_chars.
    Не обрезает смысл: переносит остаток в следующий чанк.
    """
    raw = (text or '').strip()
    if not raw:
        return []
    if len(raw) <= max_chars:
        return [raw]

    # Сначала режем на «параграфы», потом собираем чанки.
    parts = [p.strip() for p in raw.split('\n\n') if p.strip()]
    if not parts:
        parts = [raw]

    chunks: List[str] = []
    current: List[str] = []
    current_len = 0
    for part in parts:
        # Если один «параграф» сам по себе огромный — режем его на куски.
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

    # Небольшой overlap, чтобы не терять контекст на границах.
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


class EmbeddingsUnavailable(RuntimeError):
    pass


def _embed_text_single(prompt: str) -> List[float]:
    """
    Возвращает embedding для одного (уже короткого) prompt.

    Ожидает запущенный локальный Ollama:
      - URL: SERVPY_OLLAMA_URL (по умолчанию http://127.0.0.1:11434)
      - модель: SERVPY_OLLAMA_EMBED_MODEL (например bge-m3, nomic-embed-text)
    """
    prompt = (prompt or '').strip()
    if not prompt:
        return [0.0] * EMBEDDING_DIM

    url = f'{OLLAMA_URL.rstrip("/")}/api/embeddings'
    body = json.dumps({'model': OLLAMA_EMBED_MODEL, 'prompt': prompt}).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=body,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )

    last_error: Exception | None = None
    for attempt in range(EMBEDDING_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=EMBEDDING_TIMEOUT_SECONDS) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            last_error = None
            break
        except urllib.error.URLError as exc:
            last_error = exc
            is_timeout = isinstance(getattr(exc, 'reason', None), socket.timeout) or 'timed out' in str(exc).lower()
            if attempt >= EMBEDDING_RETRIES or not is_timeout:
                raise EmbeddingsUnavailable(
                    f'Ollama недоступен: {exc} (url={url}, model={OLLAMA_EMBED_MODEL}, timeout={EMBEDDING_TIMEOUT_SECONDS}s)'
                ) from exc
        except socket.timeout as exc:
            last_error = exc
            if attempt >= EMBEDDING_RETRIES:
                raise EmbeddingsUnavailable(
                    f'Не удалось получить embedding: TIMEOUT (url={url}, model={OLLAMA_EMBED_MODEL}, '
                    f'timeout={EMBEDDING_TIMEOUT_SECONDS}s, promptChars={len(prompt)})'
                ) from exc
        except Exception as exc:  # noqa: BLE001
            raise EmbeddingsUnavailable(
                f'Не удалось получить embedding: {exc} (url={url}, model={OLLAMA_EMBED_MODEL}, promptChars={len(prompt)})'
            ) from exc

        # Backoff: 0.5s, 1.0s, 2.0s...
        time.sleep(0.5 * (2**attempt))

    if last_error is not None:
        raise EmbeddingsUnavailable(f'Не удалось получить embedding: {last_error}') from last_error

    emb = data.get('embedding') if isinstance(data, dict) else None
    if not isinstance(emb, list) or not emb:
        raise EmbeddingsUnavailable('Ollama вернул пустой embedding')
    try:
        vec = [float(x) for x in emb]
    except Exception as exc:  # noqa: BLE001
        raise EmbeddingsUnavailable('Ollama вернул embedding в неверном формате') from exc
    if len(vec) != EMBEDDING_DIM:
        raise EmbeddingsUnavailable(
            (
                f'Размер embedding {len(vec)} не совпадает с SERVPY_EMBEDDING_DIM={EMBEDDING_DIM}. '
                f'Выставьте SERVPY_EMBEDDING_DIM={len(vec)} (или смените модель) и пересоздайте/очистите '
                f'таблицу block_embeddings под vector({len(vec)}), затем запустите переиндексацию.'
            )
        )
    return vec


def embed_text(text: str) -> List[float]:
    """
    Возвращает embedding для текста.

    Важно: длинный текст мы НЕ обрезаем, а разбиваем на фрагменты (чанки) и агрегируем
    embeddings по ним (среднее + L2-нормализация). Это сохраняет смысл и снижает риск таймаутов.
    """
    prompt = (text or '').strip()
    if not prompt:
        return [0.0] * EMBEDDING_DIM

    chunks = _split_into_chunks(prompt, EMBEDDING_MAX_CHARS)
    if not chunks:
        return [0.0] * EMBEDDING_DIM
    if len(chunks) == 1:
        return _normalize_l2(_embed_text_single(chunks[0]))

    acc = [0.0] * EMBEDDING_DIM
    count = 0
    for chunk in chunks:
        vec = _embed_text_single(chunk)
        for i, x in enumerate(vec):
            acc[i] += x
        count += 1
    if count <= 0:
        return [0.0] * EMBEDDING_DIM
    avg = [x / count for x in acc]
    return _normalize_l2(avg)


def embed_texts(texts: Iterable[str]) -> List[List[float]]:
    return [embed_text(t) for t in texts]
