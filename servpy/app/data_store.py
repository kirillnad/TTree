from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from functools import wraps
from .db import CONN
from .schema import init_schema
from .html_sanitizer import sanitize_html
from .text_utils import (
    build_lemma,
    build_lemma_tokens,
    build_normalized_tokens,
    strip_html,
)

init_schema()


def iso_now() -> str:
    return datetime.utcnow().isoformat()


def serialize_history(history: List[Dict[str, Any]]) -> str:
    return json.dumps(history or [])


def deserialize_history(data: Optional[str]) -> List[Dict[str, Any]]:
    if not data:
        return []
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return []


# --- Пользовательские исключения для слоя данных ---
class DataStoreError(Exception):
    """Базовый класс для ошибок хранилища данных."""
    pass

class ArticleNotFound(DataStoreError):
    """Статья не найдена."""
    pass

class BlockNotFound(DataStoreError):
    """Блок не найден."""
    pass

class InvalidOperation(DataStoreError):
    """Недопустимая операция (например, перемещение первого блока вверх)."""
    pass


def with_article(func):
    """Декоратор для загрузки, модификации и сохранения статьи."""
    @wraps(func)
    def wrapper(article_id: str, *args, **kwargs):
        article = get_article(article_id)
        if not article:
            raise ArticleNotFound(f'Статья с ID {article_id} не найдена')

        # Передаем статью в оборачиваемую функцию
        result = func(article, *args, **kwargs)

        # Если функция вернула что-то (успех), сохраняем изменения
        if result is not None:
            article['updatedAt'] = iso_now()
            save_article(article)
        return result
    return wrapper


def rows_to_tree(article_id: str) -> List[Dict[str, Any]]:
    rows = CONN.execute(
        '''
        SELECT block_rowid, id, parent_id, text, collapsed, position
        FROM blocks
        WHERE article_id = ?
        ORDER BY position ASC
        ''',
        (article_id,),
    ).fetchall()
    id_map: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        id_map[row['id']] = {
            'id': row['id'],
            'text': row['text'],
            'collapsed': bool(row['collapsed']),
            'children': [],
        }
    roots: List[Dict[str, Any]] = []
    for row in rows:
        node = id_map[row['id']]
        parent_id = row['parent_id']
        if parent_id and parent_id in id_map:
            id_map[parent_id]['children'].append(node)
        else:
            roots.append(node)
    return roots


def build_article_from_row(row: sqlite3.Row) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    return {
        'id': row['id'],
        'title': row['title'],
        'createdAt': row['created_at'],
        'updatedAt': row['updated_at'],
        'history': deserialize_history(row['history']),
        'redoHistory': deserialize_history(row['redo_history']),
        'blocks': rows_to_tree(row['id']),
    }


def get_articles() -> List[Dict[str, Any]]:
    rows = CONN.execute('SELECT * FROM articles ORDER BY updated_at DESC').fetchall()
    return [build_article_from_row(row) for row in rows if row]


def get_article(article_id: str) -> Optional[Dict[str, Any]]:
    row = CONN.execute('SELECT * FROM articles WHERE id = ?', (article_id,)).fetchone()
    return build_article_from_row(row)


def delete_article(article_id: str) -> bool:
    """Удаляет статью и связанные блоки/индексы. Возвращает True, если статья существовала."""
    with CONN:
        exists = CONN.execute('SELECT 1 FROM articles WHERE id = ?', (article_id,)).fetchone()
        if not exists:
            return False
        CONN.execute('DELETE FROM blocks_fts WHERE article_id = ?', (article_id,))
        CONN.execute('DELETE FROM blocks WHERE article_id = ?', (article_id,))
        CONN.execute('DELETE FROM articles WHERE id = ?', (article_id,))
    return True


def insert_blocks_recursive(
    article_id: str,
    blocks: List[Dict[str, Any]],
    timestamp: str,
    parent_id: Optional[str] = None,
) -> None:
    for index, block in enumerate(blocks):
        plain_text = strip_html(block.get('text', ''))
        lemma = build_lemma(plain_text)
        normalized_text = build_normalized_tokens(plain_text)
        CONN.execute(
            '''
            INSERT INTO blocks
              (id, article_id, parent_id, position, text, normalized_text, collapsed, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                block['id'],
                article_id,
                parent_id,
                index,
                block.get('text', ''),
                normalized_text,
                int(block.get('collapsed', False)),
                timestamp,
                timestamp,
            ),
        )
        block_rowid = CONN.execute(
            'SELECT last_insert_rowid() as block_rowid'
        ).fetchone()['block_rowid']
        CONN.execute(
            '''
            INSERT OR REPLACE INTO blocks_fts
              (block_rowid, article_id, text, lemma, normalized_text)
            VALUES (?, ?, ?, ?, ?)
            ''',
            (block_rowid, article_id, block.get('text', ''), lemma, normalized_text),
        )
        if block.get('children'):
            insert_blocks_recursive(article_id, block['children'], timestamp, block['id'])


def normalize_article(article: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not article:
        return None
    article.setdefault('blocks', [])
    article.setdefault('history', [])
    article.setdefault('redoHistory', [])
    return article


def save_article(article: Dict[str, Any]) -> None:
    normalized = normalize_article(article)
    if not normalized:
        return
    now = normalized.get('updatedAt', iso_now())
    normalized['updatedAt'] = now
    with CONN:
        exists = CONN.execute(
            'SELECT created_at FROM articles WHERE id = ?', (normalized['id'],)
        ).fetchone()
        if exists:
            CONN.execute(
                '''
                UPDATE articles
                SET title = ?, updated_at = ?, history = ?, redo_history = ?
                WHERE id = ?
                ''',
                (
                    normalized.get('title', 'Новая статья'),
                    now,
                    serialize_history(normalized['history']),
                    serialize_history(normalized['redoHistory']),
                    normalized['id'],
                ),
            )
        else:
            CONN.execute(
                '''
                INSERT INTO articles (id, title, created_at, updated_at, history, redo_history)
                VALUES (?, ?, ?, ?, ?, ?)
                ''',
                (
                    normalized['id'],
                    normalized.get('title', 'Новая статья'),
                    now,
                    now,
                    serialize_history(normalized['history']),
                    serialize_history(normalized['redoHistory']),
                ),
            )
        CONN.execute('DELETE FROM blocks WHERE article_id = ?', (normalized['id'],))
        CONN.execute('DELETE FROM blocks_fts WHERE article_id = ?', (normalized['id'],))
        insert_blocks_recursive(normalized['id'], normalized['blocks'], now)


def ensure_sample_article():
    if CONN.execute('SELECT 1 FROM articles LIMIT 1').fetchone():
        return
    sample_id = str(uuid.uuid4())
    intro_block = {
        'id': str(uuid.uuid4()),
        'text': 'Примерный узел',
        'collapsed': False,
        'children': [
            {'id': str(uuid.uuid4()), 'text': 'Дочерний элемент', 'collapsed': False, 'children': []},
            {
                'id': str(uuid.uuid4()),
                'text': 'Развивающая ветка',
                'collapsed': False,
                'children': [
                    {'id': str(uuid.uuid4()), 'text': 'Глубоко вложенный блок', 'collapsed': False, 'children': []}
                ],
            },
        ],
    }
    article = {
        'id': sample_id,
        'title': 'Пример статьи',
        'createdAt': iso_now(),
        'updatedAt': iso_now(),
        'blocks': [intro_block],
        'history': [],
        'redoHistory': [],
    }
    save_article(article)


def create_article(title: Optional[str] = None) -> Dict[str, Any]:
    now = iso_now()
    article = {
        'id': str(uuid.uuid4()),
        'title': title or 'Новая статья',
        'createdAt': now,
        'updatedAt': now,
        'blocks': [create_default_block()],
        'history': [],
        'redoHistory': [],
    }
    save_article(article)
    return article


def create_default_block() -> Dict[str, Any]:
    return {
        'id': str(uuid.uuid4()),
        'text': '',
        'collapsed': False,
        'children': [],
    }


def count_blocks(blocks: List[Dict[str, Any]]) -> int:
    total = 0
    for block in blocks or []:
        total += 1
        total += count_blocks(block.get('children', []))
    return total


def clone_block(block: Dict[str, Any]) -> Dict[str, Any]:
    return {
        'id': block.get('id') or str(uuid.uuid4()),
        'text': sanitize_html(block.get('text', '')),
        'collapsed': bool(block.get('collapsed')),
        'children': [clone_block(child) for child in block.get('children', [])],
    }


def find_block_recursive(blocks: List[Dict[str, Any]], block_id: str, parent: Optional[Dict[str, Any]] = None):
    for index, block in enumerate(blocks):
        if block['id'] == block_id:
            return {'block': block, 'parent': parent, 'index': index, 'siblings': blocks}
        found = find_block_recursive(block.get('children', []), block_id, block)
        if found:
            return found
    return None


def _parent_clause(parent_id: Optional[str]) -> Tuple[str, Tuple]:
    if parent_id is None:
        return 'parent_id IS NULL', ()
    return 'parent_id = ?', (parent_id,)


def _fetch_siblings(article_id: str, parent_id: Optional[str]) -> List[sqlite3.Row]:
    clause, params = _parent_clause(parent_id)
    return CONN.execute(
        f'''
        SELECT block_rowid, id, parent_id, position, text, collapsed, created_at, updated_at
        FROM blocks
        WHERE article_id = ? AND {clause}
        ORDER BY position ASC
        ''',
        (article_id, *params),
    ).fetchall()


def _reindex_siblings(article_id: str, parent_id: Optional[str]) -> None:
    siblings = _fetch_siblings(article_id, parent_id)
    with CONN:
        for idx, row in enumerate(siblings):
            if row['position'] != idx:
                clause, params = _parent_clause(parent_id)
                CONN.execute(
                    f'UPDATE blocks SET position = ? WHERE article_id = ? AND {clause} AND id = ?',
                    (idx, article_id, *params, row['id']),
                )


def _insert_block_tree(article_id: str, block: Dict[str, Any], parent_id: Optional[str], position: int, timestamp: str) -> Dict[str, Any]:
    block_id = block.get('id') or str(uuid.uuid4())
    text = sanitize_html(block.get('text', ''))
    plain_text = strip_html(text)
    lemma = block.get('lemma') or build_lemma(plain_text)
    normalized_text = block.get('normalized_text') or build_normalized_tokens(plain_text)
    created_at = block.get('createdAt', timestamp)
    collapsed = int(bool(block.get('collapsed')))

    with CONN:
        clause, params = _parent_clause(parent_id)
        CONN.execute(
            f'''
            UPDATE blocks
            SET position = position + 1
            WHERE article_id = ? AND {clause} AND position >= ?
            ''',
            (article_id, *params, position),
        )
        CONN.execute(
            '''
            INSERT INTO blocks
              (id, article_id, parent_id, position, text, normalized_text, collapsed, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (block_id, article_id, parent_id, position, text, normalized_text, collapsed, created_at, timestamp),
        )
        block_rowid = CONN.execute('SELECT last_insert_rowid() as block_rowid').fetchone()['block_rowid']
        CONN.execute(
            '''
            INSERT OR REPLACE INTO blocks_fts
              (block_rowid, article_id, text, lemma, normalized_text)
            VALUES (?, ?, ?, ?, ?)
            ''',
            (block_rowid, article_id, text, lemma, normalized_text),
        )
    for idx, child in enumerate(block.get('children') or []):
        _insert_block_tree(article_id, child, block_id, idx, timestamp)
    inserted = clone_block(block)
    inserted['id'] = block_id
    return inserted


def push_text_history_entry(article: Dict[str, Any], block_id: str, before: str, after: str) -> Optional[Dict[str, Any]]:
    if before == after:
        return None
    entry = {
        'id': str(uuid.uuid4()),
        'blockId': block_id,
        'before': before,
        'after': after,
        'timestamp': iso_now(),
    }
    article.setdefault('history', []).append(entry)
    article['redoHistory'] = []
    return entry


def update_block(article_id: str, block_id: str, attrs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    # Оптимизированный вариант, который не перезаписывает всю статью
    if 'text' in attrs or 'collapsed' in attrs:
        now = iso_now()
        history_entry = None
        response: Dict[str, Any] = {'id': block_id}

        with CONN:
            # Получаем данные блока один раз, чтобы проверить его существование
            # и получить необходимые поля (text и rowid)
            block_data = CONN.execute('SELECT text, block_rowid FROM blocks WHERE id = ?', (block_id,)).fetchone()
            if not block_data:
                raise BlockNotFound(f'Блок с ID {block_id} не найден.')
            block_rowid = block_data['block_rowid']

            if 'text' in attrs:
                previous_text = block_data['text']
                new_text = sanitize_html(attrs['text'] or '')
                
                # Получаем текущую историю для добавления новой записи
                article_row = CONN.execute('SELECT history, redo_history FROM articles WHERE id = ?', (article_id,)).fetchone()
                if not article_row:
                    raise ArticleNotFound(f'Статья с ID {article_id} не найдена при обновлении блока')
                article_history = deserialize_history(article_row['history'])
                
                history_entry = push_text_history_entry({'history': article_history, 'redoHistory': []}, block_id, previous_text, new_text)
                
                plain_text = strip_html(new_text)
                lemma = build_lemma(plain_text)
                normalized_text = build_normalized_tokens(plain_text)

                CONN.execute('UPDATE blocks SET text = ?, normalized_text = ?, updated_at = ? WHERE id = ?', (new_text, normalized_text, now, block_id))
                CONN.execute('INSERT OR REPLACE INTO blocks_fts (block_rowid, article_id, text, lemma, normalized_text) VALUES (?, ?, ?, ?, ?)', (block_rowid, article_id, new_text, lemma, normalized_text))
                CONN.execute('UPDATE articles SET updated_at = ?, history = ?, redo_history = ? WHERE id = ?', (now, serialize_history(article_history), '[]', article_id))
                response['text'] = new_text

            if 'collapsed' in attrs:
                collapsed_val = bool(attrs['collapsed'])
                CONN.execute('UPDATE blocks SET collapsed = ?, updated_at = ? WHERE id = ?', (int(collapsed_val), now, block_id))
                CONN.execute('UPDATE articles SET updated_at = ? WHERE id = ?', (now, article_id))
                response['collapsed'] = collapsed_val

        if history_entry:
            response['historyEntryId'] = history_entry['id']
        return response

    # Старая логика для других атрибутов или как fallback
    article = get_article(article_id)
    if not article:
        raise ArticleNotFound(f'Статья с ID {article_id} не найдена')
    located = find_block_recursive(article['blocks'], block_id)
    if not located:
        raise BlockNotFound(f'Блок с ID {block_id} не найден')

    block = located['block']
    history_entry = None
    article['updatedAt'] = iso_now()
    save_article(article)
    response = block.copy()
    return response


def update_block_collapse(article_id: str, block_id: str, collapsed: bool) -> Optional[Dict[str, Any]]:
    return update_block(article_id, block_id, {'collapsed': collapsed})


def insert_block(article_id: str, target_block_id: str, direction: str, payload: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    target = CONN.execute(
        'SELECT id, parent_id, position FROM blocks WHERE id = ? AND article_id = ?',
        (target_block_id, article_id),
    ).fetchone()
    if not target:
        raise BlockNotFound(f'Block {target_block_id} not found')

    siblings = _fetch_siblings(article_id, target['parent_id'])
    target_index = next((i for i, row in enumerate(siblings) if row['id'] == target_block_id), None)
    if target_index is None:
        raise BlockNotFound(f'Block {target_block_id} not found')
    insertion = target_index if direction == 'before' else target_index + 1
    now = iso_now()
    new_block = clone_block(payload or create_default_block())
    inserted = _insert_block_tree(article_id, new_block, target['parent_id'], insertion, now)
    with CONN:
        CONN.execute('UPDATE articles SET updated_at = ? WHERE id = ?', (now, article_id))
    return {'block': inserted, 'parentId': target['parent_id'], 'index': insertion}


def delete_block(article_id: str, block_id: str) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article:
        raise ArticleNotFound(f'Article {article_id} not found')
    if count_blocks(article['blocks']) <= 1:
        raise ValueError('Need to keep at least one block')
    located = find_block_recursive(article['blocks'], block_id)
    if not located:
        raise BlockNotFound(f'Block {block_id} not found')
    target_row = CONN.execute(
        'SELECT id, parent_id, position FROM blocks WHERE id = ? AND article_id = ?',
        (block_id, article_id),
    ).fetchone()
    if not target_row:
        raise BlockNotFound(f'Block {block_id} not found')
    removed = clone_block(located['block'])
    parent_id = located['parent']['id'] if located['parent'] else None
    index = located['index']
    now = iso_now()
    clause, params = _parent_clause(parent_id)
    with CONN:
        rowids = [
            row['block_rowid']
            for row in CONN.execute(
                '''
                WITH RECURSIVE subtree(id) AS (
                    SELECT id FROM blocks WHERE id = ? AND article_id = ?
                    UNION ALL
                    SELECT b.id FROM blocks b JOIN subtree s ON b.parent_id = s.id
                )
                SELECT block_rowid FROM blocks WHERE article_id = ? AND id IN (SELECT id FROM subtree)
                ''',
                (block_id, article_id, article_id),
            ).fetchall()
        ]
        if rowids:
            placeholders = ','.join('?' for _ in rowids)
            CONN.execute(f'DELETE FROM blocks_fts WHERE block_rowid IN ({placeholders})', rowids)
        CONN.execute('DELETE FROM blocks WHERE id = ? AND article_id = ?', (block_id, article_id))
        CONN.execute(
            f'UPDATE blocks SET position = position - 1 WHERE article_id = ? AND {clause} AND position > ?',
            (article_id, *params, target_row['position']),
        )
        CONN.execute('UPDATE articles SET updated_at = ? WHERE id = ?', (now, article_id))
    return {
        'removedBlockId': block_id,
        'parentId': parent_id,
        'index': index,
        'block': removed,
    }


def move_block(article_id: str, block_id: str, direction: str) -> Optional[Dict[str, Any]]:
    if direction not in {'up', 'down'}:
        return None
    target = CONN.execute(
        'SELECT id, parent_id, position FROM blocks WHERE id = ? AND article_id = ?',
        (block_id, article_id),
    ).fetchone()
    if not target:
        raise BlockNotFound(f'Block {block_id} not found')
    siblings = _fetch_siblings(article_id, target['parent_id'])
    index = next((i for i, row in enumerate(siblings) if row['id'] == block_id), None)
    if index is None:
        raise BlockNotFound(f'Block {block_id} not found')
    target_index = index - 1 if direction == 'up' else index + 1
    if target_index < 0 or target_index >= len(siblings):
        raise InvalidOperation(f'Cannot move {direction}')

    order = [row['id'] for row in siblings]
    order.pop(index)
    order.insert(target_index, block_id)
    now = iso_now()
    with CONN:
        for pos, bid in enumerate(order):
            CONN.execute('UPDATE blocks SET position = ? WHERE id = ? AND article_id = ?', (pos, bid, article_id))
        CONN.execute('UPDATE blocks SET updated_at = ? WHERE id = ? AND article_id = ?', (now, block_id, article_id))
        CONN.execute('UPDATE articles SET updated_at = ? WHERE id = ?', (now, article_id))
    return {'block': {'id': block_id}, 'parentId': target['parent_id']}


def indent_block(article_id: str, block_id: str) -> Optional[Dict[str, Any]]:
    target = CONN.execute(
        'SELECT id, parent_id, position FROM blocks WHERE id = ? AND article_id = ?',
        (block_id, article_id),
    ).fetchone()
    if not target:
        raise BlockNotFound(f'Block {block_id} not found')
    siblings = _fetch_siblings(article_id, target['parent_id'])
    index = next((i for i, row in enumerate(siblings) if row['id'] == block_id), None)
    if index is None:
        raise BlockNotFound(f'Block {block_id} not found')
    if index == 0:
        raise InvalidOperation('Cannot indent first item')

    new_parent_id = siblings[index - 1]['id']
    clause_old, params_old = _parent_clause(target['parent_id'])
    child_clause, child_params = _parent_clause(new_parent_id)
    child_count = CONN.execute(
        f'SELECT COUNT(*) as cnt FROM blocks WHERE article_id = ? AND {child_clause}',
        (article_id, *child_params),
    ).fetchone()['cnt']
    now = iso_now()
    with CONN:
        CONN.execute(
            f'UPDATE blocks SET position = position - 1 WHERE article_id = ? AND {clause_old} AND position > ?',
            (article_id, *params_old, target['position']),
        )
        CONN.execute(
            'UPDATE blocks SET parent_id = ?, position = ?, updated_at = ? WHERE id = ? AND article_id = ?',
            (new_parent_id, child_count, now, block_id, article_id),
        )
        CONN.execute('UPDATE articles SET updated_at = ? WHERE id = ?', (now, article_id))
    return {'block': {'id': block_id}, 'parentId': new_parent_id}


def outdent_block(article_id: str, block_id: str) -> Optional[Dict[str, Any]]:
    target = CONN.execute(
        'SELECT id, parent_id, position FROM blocks WHERE id = ? AND article_id = ?',
        (block_id, article_id),
    ).fetchone()
    if not target:
        raise BlockNotFound(f'Block {block_id} not found')
    if not target['parent_id']:
        raise InvalidOperation('Cannot outdent root')

    parent_row = CONN.execute(
        'SELECT id, parent_id, position FROM blocks WHERE id = ? AND article_id = ?',
        (target['parent_id'], article_id),
    ).fetchone()
    if not parent_row:
        raise InvalidOperation('Invalid parent structure')

    clause_old, params_old = _parent_clause(target['parent_id'])
    target_clause, target_params = _parent_clause(parent_row['parent_id'])
    insert_pos = parent_row['position'] + 1
    now = iso_now()
    with CONN:
        CONN.execute(
            f'UPDATE blocks SET position = position - 1 WHERE article_id = ? AND {clause_old} AND position > ?',
            (article_id, *params_old, target['position']),
        )
        CONN.execute(
            f'UPDATE blocks SET position = position + 1 WHERE article_id = ? AND {target_clause} AND position >= ?',
            (article_id, *target_params, insert_pos),
        )
        CONN.execute(
            'UPDATE blocks SET parent_id = ?, position = ?, updated_at = ? WHERE id = ? AND article_id = ?',
            (parent_row['parent_id'], insert_pos, now, block_id, article_id),
        )
        CONN.execute('UPDATE articles SET updated_at = ? WHERE id = ?', (now, article_id))
    return {'block': {'id': block_id}, 'parentId': parent_row['parent_id']}


def restore_block(article_id: str, parent_id: Optional[str], index: Optional[int], payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    siblings = _fetch_siblings(article_id, parent_id)
    insertion = index if isinstance(index, int) and 0 <= index <= len(siblings) else len(siblings)
    now = iso_now()
    restored = clone_block(payload)
    inserted = _insert_block_tree(article_id, restored, parent_id, insertion, now)
    with CONN:
        CONN.execute('UPDATE articles SET updated_at = ? WHERE id = ?', (now, article_id))
    return {'block': inserted, 'parentId': parent_id or None, 'index': insertion}


def update_article_meta(article_id: str, attrs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article:
        raise ArticleNotFound(f'Article {article_id} not found')
    title = attrs.get('title')
    if not title or title == article['title']:
        return None
    now = iso_now()
    with CONN:
        CONN.execute('UPDATE articles SET title = ?, updated_at = ? WHERE id = ?', (title, now, article_id))
    article['title'] = title
    article['updatedAt'] = now
    return article


def undo_block_text_change(article_id: str, entry_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    article_row = CONN.execute('SELECT history, redo_history FROM articles WHERE id = ?', (article_id,)).fetchone()
    if not article_row:
        raise ArticleNotFound(f'Article {article_id} not found')
    history = deserialize_history(article_row['history'])
    redo = deserialize_history(article_row['redo_history'])
    if not history:
        raise InvalidOperation('Nothing to undo')
    if entry_id:
        index = next((i for i, item in enumerate(history) if item['id'] == entry_id), None)
    else:
        index = len(history) - 1
    if index is None or index < 0 or index >= len(history):
        raise InvalidOperation('Nothing to undo')
    entry = history.pop(index)
    redo.append(entry)
    block_id = entry['blockId']
    block_row = CONN.execute('SELECT block_rowid FROM blocks WHERE id = ? AND article_id = ?', (block_id, article_id)).fetchone()
    if not block_row:
        raise BlockNotFound(f'Block {block_id} not found')
    new_text = sanitize_html(entry.get('before') or '')
    plain_text = strip_html(new_text)
    lemma = build_lemma(plain_text)
    normalized_text = build_normalized_tokens(plain_text)
    now = iso_now()
    with CONN:
        CONN.execute(
            'UPDATE blocks SET text = ?, normalized_text = ?, updated_at = ? WHERE id = ? AND article_id = ?',
            (new_text, normalized_text, now, block_id, article_id),
        )
        CONN.execute(
            'INSERT OR REPLACE INTO blocks_fts (block_rowid, article_id, text, lemma, normalized_text) VALUES (?, ?, ?, ?, ?)',
            (block_row['block_rowid'], article_id, new_text, lemma, normalized_text),
        )
        CONN.execute(
            'UPDATE articles SET history = ?, redo_history = ?, updated_at = ? WHERE id = ?',
            (serialize_history(history), serialize_history(redo), now, article_id),
        )
    return {'blockId': block_id, 'block': {'id': block_id, 'text': new_text}}


def redo_block_text_change(article_id: str, entry_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    article_row = CONN.execute('SELECT history, redo_history FROM articles WHERE id = ?', (article_id,)).fetchone()
    if not article_row:
        raise ArticleNotFound(f'Article {article_id} not found')
    history = deserialize_history(article_row['history'])
    redo = deserialize_history(article_row['redo_history'])
    if not redo:
        raise InvalidOperation('Nothing to redo')
    if entry_id:
        index = next((i for i, item in enumerate(redo) if item['id'] == entry_id), None)
    else:
        index = len(redo) - 1
    if index is None or index < 0 or index >= len(redo):
        raise InvalidOperation('Nothing to redo')
    entry = redo.pop(index)
    history.append(entry)
    block_id = entry['blockId']
    block_row = CONN.execute('SELECT block_rowid FROM blocks WHERE id = ? AND article_id = ?', (block_id, article_id)).fetchone()
    if not block_row:
        raise BlockNotFound(f'Block {block_id} not found')
    new_text = sanitize_html(entry.get('after') or '')
    plain_text = strip_html(new_text)
    lemma = build_lemma(plain_text)
    normalized_text = build_normalized_tokens(plain_text)
    now = iso_now()
    with CONN:
        CONN.execute(
            'UPDATE blocks SET text = ?, normalized_text = ?, updated_at = ? WHERE id = ? AND article_id = ?',
            (new_text, normalized_text, now, block_id, article_id),
        )
        CONN.execute(
            'INSERT OR REPLACE INTO blocks_fts (block_rowid, article_id, text, lemma, normalized_text) VALUES (?, ?, ?, ?, ?)',
            (block_row['block_rowid'], article_id, new_text, lemma, normalized_text),
        )
        CONN.execute(
            'UPDATE articles SET history = ?, redo_history = ?, updated_at = ? WHERE id = ?',
            (serialize_history(history), serialize_history(redo), now, article_id),
        )
    return {'blockId': block_id, 'block': {'id': block_id, 'text': new_text}}


def build_fts_query(term: str) -> str:
    lemma_tokens = build_lemma_tokens(term)
    normalized_tokens = [token for token in build_normalized_tokens(term).split() if token]
    parts = []
    if lemma_tokens:
        parts.append(' OR '.join(f'lemma:{token}*' for token in lemma_tokens))
    if normalized_tokens:
        parts.append(' OR '.join(f'normalized_text:{token}*' for token in normalized_tokens))
    return ' OR '.join(parts)


def search_blocks(query: str, limit: int = 20) -> List[Dict[str, Any]]:
    fts_query = build_fts_query(query)
    if not fts_query:
        return []
    rows = CONN.execute(
        '''
        SELECT
            blocks.id AS blockId,
            articles.id AS articleId,
            articles.title AS articleTitle,
            snippet(blocks_fts, '', '', '...', -1, 64) AS snippet,
            blocks.text AS blockText
        FROM blocks_fts
        JOIN blocks ON blocks.rowid = blocks_fts.block_rowid
        JOIN articles ON articles.id = blocks.article_id
        WHERE blocks_fts MATCH ?
        ORDER BY bm25(blocks_fts) ASC
        LIMIT ?
        ''',
        (fts_query, limit),
    ).fetchall()
    results = []
    for row in rows:
        block_text = row['blockText'] or ''
        snippet = row['snippet'] or strip_html(block_text)[:160]
        results.append(
            {
                'articleId': row['articleId'],
                'articleTitle': row['articleTitle'],
                'blockId': row['blockId'],
                'snippet': snippet,
                'blockText': block_text,
            }
        )
    return results
