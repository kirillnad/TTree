from __future__ import annotations

import os
import threading
import logging
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime
from typing import Any, Iterable, List
from uuid import uuid4

from .db import CONN
from .embeddings import EmbeddingInputUnsupported, EmbeddingsUnavailable, embed_text, embed_text_batch
from .telegram_notify import notify_user
from .text_utils import strip_html

logger = logging.getLogger('uvicorn.error')

SEMANTIC_REINDEX_TASKS: dict[str, dict[str, Any]] = {}
_SEMANTIC_REINDEX_LOCK = threading.Lock()
SEMANTIC_REINDEX_COOLDOWN_SECONDS = 0 * 60
SEMANTIC_REINDEX_CONCURRENCY = int(os.environ.get('SERVPY_SEMANTIC_REINDEX_CONCURRENCY') or '4')
SEMANTIC_REINDEX_BLOCK_BATCH_SIZE = int(os.environ.get('SERVPY_SEMANTIC_REINDEX_BLOCK_BATCH_SIZE') or '32')


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
            rows_list = list(rows or [])
            concurrency = max(1, int(SEMANTIC_REINDEX_CONCURRENCY))
            concurrency = min(concurrency, max(1, len(rows_list)))
            block_batch_size = max(1, int(SEMANTIC_REINDEX_BLOCK_BATCH_SIZE))

            def _process_batch(batch_rows: List[dict[str, Any]]) -> tuple[int, int, int]:
                """
                Возвращает (processed, indexed, failed) для батча блоков.
                processed = сколько блоков в батче рассмотрели (включая skip/empty)
                indexed = сколько реально записали embedding
                failed = сколько не смогли обработать (кроме skip)
                """
                if not batch_rows:
                    return (0, 0, 0)

                # 1) Подготовка и быстрый skip по updated_at (одним запросом)
                valid_rows: List[dict[str, Any]] = []
                block_ids: List[str] = []
                for r in batch_rows:
                    bid = (r.get('block_id') or '') if r else ''
                    if bid:
                        valid_rows.append(r)
                        block_ids.append(str(bid))
                if not valid_rows:
                    return (len(batch_rows), 0, 0)

                existing_map: dict[str, str] = {}
                try:
                    placeholders = ','.join('?' for _ in block_ids)
                    existing_rows = CONN.execute(
                        f'''
                        SELECT block_id AS "blockId", updated_at AS "updatedAt"
                        FROM block_embeddings
                        WHERE block_id IN ({placeholders})
                        ''',
                        tuple(block_ids),
                    ).fetchall()
                    for row in existing_rows or []:
                        bid = row.get('blockId')
                        if bid:
                            existing_map[str(bid)] = str(row.get('updatedAt') or '')
                except Exception:
                    existing_map = {}

                todo_rows: List[dict[str, Any]] = []
                processed_local = 0
                indexed_local = 0
                failed_local = 0
                for r in valid_rows:
                    bid = str(r.get('block_id') or '')
                    updated_at = str(r.get('updated_at') or '')
                    if updated_at and existing_map.get(bid) == updated_at:
                        processed_local += 1
                        continue
                    todo_rows.append(r)

                if not todo_rows:
                    return (processed_local, 0, 0)

                # 2) Пустые блоки: удаляем и считаем processed
                embed_rows: List[dict[str, Any]] = []
                embed_texts_list: List[str] = []
                empty_ids: List[str] = []
                plain_texts: List[str] = []
                for r in todo_rows:
                    bid = str(r.get('block_id') or '')
                    text = _build_embedding_text(r.get('article_title') or '', r.get('block_text') or '')
                    if not text:
                        empty_ids.append(bid)
                        processed_local += 1
                        continue
                    embed_rows.append(r)
                    embed_texts_list.append(text)
                    plain_texts.append(text)

                if empty_ids:
                    delete_block_embeddings(empty_ids)

                if not embed_rows:
                    return (processed_local, 0, 0)

                # 3) Embeddings одним/несколькими запросами + запись в БД
                try:
                    vectors = embed_text_batch(embed_texts_list)
                except EmbeddingInputUnsupported:
                    # Если батч запрос упал из-за одного "плохого" input (например, зашифрованного),
                    # деградируем на поштучные вызовы, чтобы пропустить проблемный блок.
                    vectors = []
                    for t in embed_texts_list:
                        try:
                            vectors.append(embed_text(t))
                        except EmbeddingInputUnsupported:
                            vectors.append([])
                for r, vec, plain in zip(embed_rows, vectors, plain_texts):
                    bid = str(r.get('block_id') or '')
                    if not bid:
                        continue
                    processed_local += 1
                    if not vec:
                        # unsupported input
                        failed_local += 1
                        CONN.execute('DELETE FROM block_embeddings WHERE block_id = ?', (bid,))
                        continue
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
                        (
                            bid,
                            author_id,
                            r.get('article_id') or '',
                            r.get('article_title') or '',
                            plain,
                            vec_lit,
                            r.get('updated_at') or '',
                        ),
                    )
                    indexed_local += 1

                return (processed_local, indexed_local, failed_local)

            in_flight: set = set()
            next_index = 0

            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                while next_index < len(rows_list) or in_flight:
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
                            for fut in list(in_flight):
                                fut.cancel()
                            return

                    while next_index < len(rows_list) and len(in_flight) < concurrency:
                        batch = rows_list[next_index : next_index + block_batch_size]
                        next_index += len(batch)
                        first = batch[0] if batch else None
                        bid = (first.get('block_id') or '') if first else ''
                        if bid:
                            with _SEMANTIC_REINDEX_LOCK:
                                t = SEMANTIC_REINDEX_TASKS.get(author_id)
                                if t:
                                    t['currentBlockId'] = bid
                                    t['currentArticleId'] = first.get('article_id') or None
                                    t['lastActivityAt'] = _iso_now()
                        in_flight.add(pool.submit(_process_batch, batch))

                    if not in_flight:
                        break

                    done, _pending = wait(in_flight, return_when=FIRST_COMPLETED, timeout=1.0)
                    if not done:
                        continue

                    for fut in done:
                        in_flight.discard(fut)
                        try:
                            p, i, f = fut.result()
                            processed += int(p or 0)
                            indexed += int(i or 0)
                            failed += int(f or 0)
                            if total and processed > total:
                                processed = total
                        except EmbeddingInputUnsupported as exc:
                            failed += 1
                            logger.warning('Skip block (unsupported embedding input): %r', exc)
                        except EmbeddingsUnavailable:
                            # Это фатально (настройка/сеть/провайдер недоступен): останавливаем всю задачу.
                            raise
                        except Exception as exc:  # noqa: BLE001
                            # Ошибка батча: считаем как минимум один failure
                            failed += 1
                            logger.warning('Failed to reindex embedding: %r', exc)
                            if not notified_first_failure:
                                notified_first_failure = True
                                notify_user(
                                    author_id,
                                    (
                                        'Переиндексация семантического поиска: появились ошибки на отдельных блоках.\n'
                                        f'Пример: error={exc!r}'
                                    ),
                                    key='semantic-reindex-partial',
                                )
                        finally:
                            should_update = processed <= 50 or processed % 25 == 0 or processed == total
                            if should_update:
                                with _SEMANTIC_REINDEX_LOCK:
                                    t = SEMANTIC_REINDEX_TASKS.get(author_id)
                                    if t:
                                        t['processed'] = processed
                                        t['indexed'] = indexed
                                        t['failed'] = failed
                                        t['lastActivityAt'] = _iso_now()

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
    # Если embedding уже рассчитан для этого updated_at — ничего не делаем.
    # Это важно для ускорения переиндексации и для повторных запусков reindex.
    try:
        existing = CONN.execute(
            'SELECT updated_at AS updatedAt FROM block_embeddings WHERE block_id = ?',
            (block_id,),
        ).fetchone()
        existing_updated_at = (existing or {}).get('updatedAt') if existing else None
        if existing_updated_at and updated_at and str(existing_updated_at) == str(updated_at):
            return
    except Exception:
        # Если таблица/pgvector недоступны — пусть ниже упадёт/обработается в вызывающем коде.
        pass
    text = _build_embedding_text(article_title, block_html)
    if not text:
        # Пустые блоки не индексируем.
        CONN.execute('DELETE FROM block_embeddings WHERE block_id = ?', (block_id,))
        return
    try:
        vec = embed_text(text)
    except EmbeddingInputUnsupported:
        # Например, зашифрованный контент: этот backend не может эмбеддить такие блоки.
        # Считаем это нефатальным: просто удаляем/не создаём embedding.
        CONN.execute('DELETE FROM block_embeddings WHERE block_id = ?', (block_id,))
        return
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
