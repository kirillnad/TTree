from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from .db import CONN
from .schema import init_schema
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
            'SELECT last_insert_rowid() as rowid'
        ).fetchone()['rowid']
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
        'text': 'Новый блок',
        'collapsed': False,
        'children': [],
    }


def clone_block(block: Dict[str, Any]) -> Dict[str, Any]:
    return {
        'id': block.get('id') or str(uuid.uuid4()),
        'text': strip_html(block.get('text', '')),
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
    article = get_article(article_id)
    if not article:
        return None
    located = find_block_recursive(article['blocks'], block_id)
    if not located:
        return None
    block = located['block']
    history_entry = None
    if 'text' in attrs:
        previous = block.get('text', '')
        new_text = attrs['text'] or ''
        history_entry = push_text_history_entry(article, block_id, previous, new_text)
        block['text'] = new_text
    if 'collapsed' in attrs:
        block['collapsed'] = bool(attrs['collapsed'])
    article['updatedAt'] = iso_now()
    save_article(article)
    response = block.copy()
    if history_entry:
        response['historyEntryId'] = history_entry['id']
    return response


def update_block_collapse(article_id: str, block_id: str, collapsed: bool) -> Optional[Dict[str, Any]]:
    return update_block(article_id, block_id, {'collapsed': collapsed})


def insert_block(article_id: str, target_block_id: str, direction: str, payload: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article:
        return None
    located = find_block_recursive(article['blocks'], target_block_id)
    if not located:
        return None
    siblings = located['siblings']
    index = located['index']
    parent = located['parent']
    new_block = clone_block(payload or create_default_block())
    insertion = index if direction == 'before' else index + 1
    siblings.insert(insertion, new_block)
    article['updatedAt'] = iso_now()
    save_article(article)
    return {'block': new_block, 'parentId': parent['id'] if parent else None, 'index': insertion}


def delete_block(article_id: str, block_id: str) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article:
        return None
    located = find_block_recursive(article['blocks'], block_id)
    if not located:
        return None
    siblings = located['siblings']
    index = located['index']
    removed = siblings.pop(index)
    article['updatedAt'] = iso_now()
    save_article(article)
    return {
        'removedBlockId': removed['id'],
        'parentId': located['parent']['id'] if located['parent'] else None,
        'index': index,
        'block': removed,
    }


def move_block(article_id: str, block_id: str, direction: str) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article or direction not in {'up', 'down'}:
        return None
    located = find_block_recursive(article['blocks'], block_id)
    if not located:
        return None
    siblings = located['siblings']
    index = located['index']
    target = index - 1 if direction == 'up' else index + 1
    if target < 0 or target >= len(siblings):
        return None
    block = siblings.pop(index)
    siblings.insert(target, block)
    article['updatedAt'] = iso_now()
    save_article(article)
    return {'block': block, 'parentId': located['parent']['id'] if located['parent'] else None}


def indent_block(article_id: str, block_id: str) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article:
        return None
    located = find_block_recursive(article['blocks'], block_id)
    if not located:
        return None
    siblings = located['siblings']
    index = located['index']
    if index == 0:
        return None
    previous = siblings[index - 1]
    block = siblings.pop(index)
    previous.setdefault('children', []).append(block)
    article['updatedAt'] = iso_now()
    save_article(article)
    return {'block': block, 'parentId': previous['id']}


def outdent_block(article_id: str, block_id: str) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article:
        return None
    located = find_block_recursive(article['blocks'], block_id)
    if not located or not located['parent']:
        return None
    parent = located['parent']
    grand_parent = find_block_recursive(article['blocks'], parent['id'])
    siblings = located['siblings']
    index = located['index']
    block = siblings.pop(index)
    block.setdefault('children', []).extend(siblings[index:])
    del siblings[index:]
    target_siblings = grand_parent['siblings'] if grand_parent else article['blocks']
    parent_index = target_siblings.index(parent)
    target_siblings.insert(parent_index + 1, block)
    article['updatedAt'] = iso_now()
    save_article(article)
    return {'block': block, 'parentId': grand_parent['parent']['id'] if grand_parent and grand_parent['parent'] else None}


def restore_block(article_id: str, parent_id: Optional[str], index: Optional[int], payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article:
        return None
    siblings = article['blocks']
    if parent_id:
        parent_loc = find_block_recursive(article['blocks'], parent_id)
        if not parent_loc:
            return None
        siblings = parent_loc['block'].setdefault('children', [])
    insertion = index if isinstance(index, int) else len(siblings)
    restored = clone_block(payload)
    siblings.insert(insertion, restored)
    article['updatedAt'] = iso_now()
    save_article(article)
    return {'block': restored, 'parentId': parent_id or None, 'index': insertion}


def update_article_meta(article_id: str, attrs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article:
        return None
    title = attrs.get('title')
    if title and title != article['title']:
        article['title'] = title
        article['updatedAt'] = iso_now()
        save_article(article)
    return article


def undo_block_text_change(article_id: str, entry_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article or not article.get('history'):
        return None
    history = article['history']
    if entry_id:
        index = next((i for i, item in enumerate(history) if item['id'] == entry_id), None)
    else:
        index = len(history) - 1
    if index is None or index < 0:
        return None
    entry = history.pop(index)
    block = find_block_recursive(article['blocks'], entry['blockId'])
    if not block:
        return None
    block['block']['text'] = entry['before']
    article.setdefault('redoHistory', []).append(entry)
    article['updatedAt'] = iso_now()
    save_article(article)
    return block['block']


def redo_block_text_change(article_id: str, entry_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article or not article.get('redoHistory'):
        return None
    redo = article['redoHistory']
    if entry_id:
        index = next((i for i, item in enumerate(redo) if item['id'] == entry_id), None)
    else:
        index = len(redo) - 1
    if index is None or index < 0:
        return None
    entry = redo.pop(index)
    block = find_block_recursive(article['blocks'], entry['blockId'])
    if not block:
        return None
    block['block']['text'] = entry['after']
    article.setdefault('history', []).append(entry)
    article['updatedAt'] = iso_now()
    save_article(article)
    return block['block']


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
