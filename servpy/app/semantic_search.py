from __future__ import annotations

import threading
import logging
from datetime import datetime
from typing import Any, Iterable, List
from uuid import uuid4

from .db import CONN
from .embeddings import EmbeddingsUnavailable, embed_text
from .telegram_notify import notify_user
from .text_utils import strip_html

logger = logging.getLogger('uvicorn.error')

SEMANTIC_REINDEX_TASKS: dict[str, dict[str, Any]] = {}
_SEMANTIC_REINDEX_LOCK = threading.Lock()
SEMANTIC_REINDEX_COOLDOWN_SECONDS = 0 * 60


def _iso_now() -> str:
    return datetime.utcnow().isoformat()


def get_reindex_task(author_id: str) -> dict[str, Any] | None:
    if not author_id:
        return None
    with _SEMANTIC_REINDEX_LOCK:
        return SEMANTIC_REINDEX_TASKS.get(author_id)


def request_cancel_reindex_task(author_id: str) -> dict[str, Any] | None:
    if not author_id:
        return None
    with _SEMANTIC_REINDEX_LOCK:
        task = SEMANTIC_REINDEX_TASKS.get(author_id)
        if not task:
            return None
        if task.get('status') == 'running':
            task['cancelRequested'] = True
        return task


def start_reindex_task(author_id: str) -> dict[str, Any]:
    """
    Стартует (или возвращает уже запущенную) задачу переиндексации embeddings для пользователя.
    Делается в фоне, чтобы HTTP-запрос не висел и не падал по таймаутам клиента/прокси.
    """
    if not author_id:
        raise ValueError('author_id required')

    with _SEMANTIC_REINDEX_LOCK:
        existing = SEMANTIC_REINDEX_TASKS.get(author_id)
        if existing and existing.get('status') == 'running':
            return existing

        if existing and existing.get('finishedAt'):
            try:
                finished = datetime.fromisoformat(existing['finishedAt'])
                elapsed = (datetime.utcnow() - finished).total_seconds()
                if elapsed < SEMANTIC_REINDEX_COOLDOWN_SECONDS:
                    remaining = int(max(0, SEMANTIC_REINDEX_COOLDOWN_SECONDS - elapsed))
                    cooldown_until = finished.timestamp() + SEMANTIC_REINDEX_COOLDOWN_SECONDS
                    return {
                        **existing,
                        'status': 'cooldown',
                        'cooldownSeconds': SEMANTIC_REINDEX_COOLDOWN_SECONDS,
                        'cooldownRemainingSeconds': remaining,
                        'cooldownUntil': datetime.utcfromtimestamp(cooldown_until).isoformat(),
                    }
            except Exception:
                pass

        task_id = str(uuid4())
        task = {
            'id': task_id,
            'status': 'running',
            'startedAt': _iso_now(),
            'finishedAt': None,
            'lastActivityAt': _iso_now(),
            'currentBlockId': None,
            'currentArticleId': None,
            'total': 0,
            'processed': 0,
            'indexed': 0,
            'failed': 0,
            'error': None,
            'cancelRequested': False,
        }
        SEMANTIC_REINDEX_TASKS[author_id] = task

    def _runner():
        try:
            rows = CONN.execute(
                '''
                SELECT
                    b.id AS block_id,
                    b.article_id AS article_id,
                    a.title AS article_title,
                    b.text AS block_text,
                    b.updated_at AS updated_at
                FROM blocks b
                JOIN articles a ON a.id = b.article_id
                WHERE a.deleted_at IS NULL
                  AND a.author_id = ?
                ORDER BY b.updated_at DESC
                ''',
                (author_id,),
            ).fetchall()
            total = len(rows or [])
            with _SEMANTIC_REINDEX_LOCK:
                t = SEMANTIC_REINDEX_TASKS.get(author_id)
                if t:
                    t['total'] = total

            processed = 0
            indexed = 0
            failed = 0
            notified_first_failure = False
            for row in rows or []:
                with _SEMANTIC_REINDEX_LOCK:
                    t = SEMANTIC_REINDEX_TASKS.get(author_id)
                    if not t:
                        break
                    if t.get('cancelRequested'):
                        t['status'] = 'cancelled'
                        t['finishedAt'] = _iso_now()
                        t['lastActivityAt'] = _iso_now()
                        t['currentBlockId'] = None
                        t['currentArticleId'] = None
                        t['processed'] = processed
                        t['indexed'] = indexed
                        t['failed'] = failed
                        return

                bid = row.get('block_id') or ''
                if not bid:
                    processed += 1
                    continue
                with _SEMANTIC_REINDEX_LOCK:
                    t = SEMANTIC_REINDEX_TASKS.get(author_id)
                    if t:
                        t['currentBlockId'] = bid
                        t['currentArticleId'] = row.get('article_id') or None
                        t['lastActivityAt'] = _iso_now()
                try:
                    upsert_block_embedding(
                        author_id=author_id,
                        article_id=row.get('article_id') or '',
                        article_title=row.get('article_title') or '',
                        block_id=bid,
                        block_html=row.get('block_text') or '',
                        updated_at=row.get('updated_at') or '',
                    )
                    indexed += 1
                except EmbeddingsUnavailable:
                    # Фатальная ошибка (обычно: Ollama недоступен или неверная размерность embeddings).
                    # Нет смысла продолжать 28k блоков с тем же фейлом.
                    raise
                except Exception as exc:  # noqa: BLE001
                    failed += 1
                    logger.warning('Failed to reindex embedding for block %s: %r', bid, exc)
                    # Сообщаем пользователю один раз, если начались ошибки, но задача продолжает идти.
                    if not notified_first_failure:
                        notified_first_failure = True
                        notify_user(
                            author_id,
                            (
                                'Переиндексация семантического поиска: появились ошибки на отдельных блоках.\n'
                                f'Пример: block_id={bid}, error={exc!r}'
                            ),
                            key='semantic-reindex-partial',
                        )
                finally:
                    processed += 1
                    # Обновляем прогресс часто в начале, чтобы в UI сразу было видно,
                    # что задача реально выполняется (иначе "0" может висеть минутами).
                    should_update = processed <= 25 or processed % 10 == 0 or processed == total
                    if should_update:
                        with _SEMANTIC_REINDEX_LOCK:
                            t = SEMANTIC_REINDEX_TASKS.get(author_id)
                            if t:
                                t['processed'] = processed
                                t['indexed'] = indexed
                                t['failed'] = failed
                                t['lastActivityAt'] = _iso_now()
                                if processed == total:
                                    t['currentBlockId'] = None
                                    t['currentArticleId'] = None

            with _SEMANTIC_REINDEX_LOCK:
                t = SEMANTIC_REINDEX_TASKS.get(author_id)
                if t:
                    t['status'] = 'completed'
                    t['finishedAt'] = _iso_now()
                    t['processed'] = processed
                    t['indexed'] = indexed
                    t['failed'] = failed
                    t['lastActivityAt'] = _iso_now()
                    t['currentBlockId'] = None
                    t['currentArticleId'] = None
        except EmbeddingsUnavailable as exc:
            with _SEMANTIC_REINDEX_LOCK:
                t = SEMANTIC_REINDEX_TASKS.get(author_id)
                if t:
                    t['status'] = 'failed'
                    t['finishedAt'] = _iso_now()
                    t['error'] = str(exc)
                    t['lastActivityAt'] = _iso_now()
                    t['currentBlockId'] = None
                    t['currentArticleId'] = None
            notify_user(author_id, f'Переиндексация семантического поиска: ошибка embeddings — {exc}', key='semantic-reindex')
        except Exception as exc:  # noqa: BLE001
            with _SEMANTIC_REINDEX_LOCK:
                t = SEMANTIC_REINDEX_TASKS.get(author_id)
                if t:
                    t['status'] = 'failed'
                    t['finishedAt'] = _iso_now()
                    t['error'] = repr(exc)
                    t['lastActivityAt'] = _iso_now()
                    t['currentBlockId'] = None
                    t['currentArticleId'] = None
            notify_user(author_id, f'Переиндексация семантического поиска: ошибка — {exc!r}', key='semantic-reindex')

    thread = threading.Thread(target=_runner, name=f'semantic-reindex-{author_id}', daemon=True)
    thread.start()

    with _SEMANTIC_REINDEX_LOCK:
        return SEMANTIC_REINDEX_TASKS[author_id]

def _vector_literal(vec: List[float]) -> str:
    # pgvector принимает формат вида: [0.1, 0.2, ...]
    return '[' + ','.join(f'{x:.8f}' for x in vec) + ']'


def _build_embedding_text(article_title: str, block_html: str) -> str:
    plain = strip_html(block_html or '')
    title = (article_title or '').strip()
    if title:
        return f'{title}\n{plain}'.strip()
    return plain.strip()


def upsert_block_embedding(*, author_id: str, article_id: str, article_title: str, block_id: str, block_html: str, updated_at: str) -> None:
    if not author_id or not article_id or not block_id:
        return
    text = _build_embedding_text(article_title, block_html)
    if not text:
        # Пустые блоки не индексируем.
        CONN.execute('DELETE FROM block_embeddings WHERE block_id = ?', (block_id,))
        return
    vec = embed_text(text)
    vec_lit = _vector_literal(vec)
    CONN.execute(
        '''
        INSERT INTO block_embeddings (block_id, author_id, article_id, article_title, plain_text, embedding, updated_at)
        VALUES (?, ?, ?, ?, ?, ?::vector, ?)
        ON CONFLICT (block_id) DO UPDATE
        SET author_id = EXCLUDED.author_id,
            article_id = EXCLUDED.article_id,
            article_title = EXCLUDED.article_title,
            plain_text = EXCLUDED.plain_text,
            embedding = EXCLUDED.embedding,
            updated_at = EXCLUDED.updated_at
        ''',
        (block_id, author_id, article_id, article_title or '', text, vec_lit, updated_at),
    )


def delete_block_embeddings(block_ids: Iterable[str]) -> None:
    ids = [bid for bid in (block_ids or []) if bid]
    if not ids:
        return
    placeholders = ','.join('?' for _ in ids)
    CONN.execute(f'DELETE FROM block_embeddings WHERE block_id IN ({placeholders})', tuple(ids))


def upsert_embeddings_for_block_tree(
    *,
    author_id: str,
    article_id: str,
    article_title: str,
    blocks: Iterable[dict[str, Any]] | None,
    updated_at: str,
) -> None:
    def _walk(nodes: Iterable[dict[str, Any]] | None) -> None:
        if not nodes:
            return
        for blk in nodes:
            if not isinstance(blk, dict):
                continue
            bid = blk.get('id') or ''
            if bid:
                try:
                    upsert_block_embedding(
                        author_id=author_id,
                        article_id=article_id,
                        article_title=article_title,
                        block_id=bid,
                        block_html=blk.get('text') or '',
                        updated_at=updated_at,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning('Failed to upsert embedding for block %s: %r', bid, exc)
            children = blk.get('children') or []
            if children:
                _walk(children)

    _walk(blocks)


def search_similar_blocks(*, author_id: str, query: str, limit: int = 30) -> List[dict[str, Any]]:
    q = (query or '').strip()
    if not q:
        return []
    vec = embed_text(q)
    vec_lit = _vector_literal(vec)
    rows = CONN.execute(
        '''
        SELECT
            block_id AS "blockId",
            article_id AS "articleId",
            article_title AS "articleTitle",
            plain_text AS "blockText",
            (1 - (embedding <=> ?::vector)) AS score
        FROM block_embeddings
        WHERE author_id = ?
        ORDER BY embedding <=> ?::vector
        LIMIT ?
        ''',
        (vec_lit, author_id, vec_lit, int(limit)),
    ).fetchall()
    results: List[dict[str, Any]] = []
    for row in rows or []:
        block_text = row.get('blockText') or ''
        snippet = block_text[:240]
        results.append(
            {
                'type': 'block',
                'articleId': row.get('articleId'),
                'articleTitle': row.get('articleTitle') or '',
                'blockId': row.get('blockId'),
                'snippet': snippet,
                'blockText': block_text,
                'score': float(row.get('score') or 0.0),
            }
        )
    return results


def try_semantic_search(author_id: str, query: str, limit: int = 30) -> List[dict[str, Any]]:
    try:
        return search_similar_blocks(author_id=author_id, query=query, limit=limit)
    except EmbeddingsUnavailable as exc:
        logger.warning('Semantic search unavailable: %s', exc)
        raise


def reindex_user_embeddings(author_id: str) -> dict[str, Any]:
    """
    Полная переиндексация embeddings для пользователя: все блоки всех не-удалённых статей.
    """
    # Legacy sync API (оставлено для совместимости внутренних вызовов).
    # Рекомендуемый путь — start_reindex_task + status endpoint.
    task = start_reindex_task(author_id)
    return {'taskId': task.get('id'), 'status': task.get('status')}
