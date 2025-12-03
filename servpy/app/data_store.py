from __future__ import annotations

import html as html_mod
import json
import logging
import re
import uuid
from datetime import datetime
from functools import wraps
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.engine import RowMapping

from .db import CONN, IS_POSTGRES, IS_SQLITE, mark_search_index_clean
from .schema import init_schema
from .html_sanitizer import sanitize_html
from .text_utils import build_lemma, build_lemma_tokens, build_normalized_tokens, strip_html

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


logger = logging.getLogger('uvicorn.error')


_PIPE_TABLE_RE = re.compile(
    r'^(?:\s*<p>(?:\s|\&nbsp;|<br\s*/?>)*\|.*?\|\s*</p>\s*)+$',
    re.IGNORECASE | re.DOTALL,
)


def _maybe_convert_pipe_table_html(html: str) -> str:
    """
    Детектирует и конвертирует Markdown-таблицу вида:
      <p>| col1 | col2 |</p><p>| row | ... |</p>
    в <table class="memus-table">...</table>.

    Также чинит старые случаи, когда к HTML уже был добавлен <table>,
    но перед ним остались исходные <p>|...|</p>: в этом случае оставляем только таблицу.
    """
    if not html:
        return ''

    # Если есть уже таблица и при этом остались строки с pipe-таблицей,
    # считаем, что это устаревший артефакт и оставляем только таблицу.
    if '<table' in html and '| Свойство |' in html or '<table' in html and '<p>|' in html:
        idx = html.find('<table')
        if idx != -1:
            return html[idx:]
        return html

    stripped = html.strip()
    if not _PIPE_TABLE_RE.match(stripped):
        return html

    # Вынимаем строки из <p>...</p>
    lines = []
    for m in re.finditer(r'<p>(.*?)</p>', stripped, flags=re.IGNORECASE | re.DOTALL):
        inner = m.group(1) or ''
        # Убираем возможные <br> и неразрывные пробелы.
        inner = re.sub(r'<br\s*/?>', '', inner, flags=re.IGNORECASE)
        text = html_mod.unescape(re.sub(r'<[^>]+>', '', inner))
        text = text.replace('\u00a0', ' ').strip()
        if text:
            lines.append(text)

    if len(lines) < 2:
        return html

    rows: list[list[str]] = []
    for raw in lines:
        line = raw.strip()
        if not (line.startswith('|') and '|' in line[1:]):
            # Не все строки подходят — оставляем как есть.
            return html
        inner = line[1:-1] if line.endswith('|') else line[1:]
        cells = [cell.strip() for cell in inner.split('|')]
        rows.append(cells)

    if not rows:
        return html

    header = rows[0]
    body = rows[1:]
    col_count = max(len(header), *(len(r) for r in body)) if body else len(header)
    col_count = max(col_count, 1)
    width = 100.0 / col_count

    parts: list[str] = []
    parts.append('<table class="memus-table"><colgroup>')
    for _ in range(col_count):
        parts.append(f'<col width="{width:.4f}%"/>')
    parts.append('</colgroup><thead><tr>')
    for i in range(col_count):
        cell = header[i] if i < len(header) else ''
        parts.append(f'<th>{html_mod.escape(cell, quote=False)}</th>')
    parts.append('</tr></thead><tbody>')
    for row in body:
        parts.append('<tr>')
        for i in range(col_count):
            cell = row[i] if i < len(row) else ''
            parts.append(f'<td>{html_mod.escape(cell, quote=False)}</td>')
        parts.append('</tr>')
    parts.append('</tbody></table>')
    return ''.join(parts)


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


def _extract_article_links_from_blocks(blocks: List[Dict[str, Any]]) -> List[str]:
    """
    Извлекает ID статей, на которые ссылаются блоки (по href="/article/<id>").
    Возвращает список уникальных to_id.
    """
    ids: set[str] = set()

    def walk(node_list: List[Dict[str, Any]]):
        for blk in node_list or []:
            text = blk.get('text') or ''
            if text and '/article/' in text:
                for match in re.finditer(r'href="/article/([0-9a-fA-F-]+)"', text):
                    target_id = match.group(1)
                    if target_id:
                        ids.add(target_id)
            children = blk.get('children') or []
            walk(children)

    walk(blocks or [])
    return list(ids)


def _update_article_links_for_article(article: Dict[str, Any]) -> None:
    """
    Перестраивает связи article_links для одной статьи:
    - удаляет все старые связи from_id = article['id'];
    - добавляет новые для всех ссылок href="/article/<id>" в блоках.
    Работает внутри существующей транзакции (использует глобальный CONN).
    """
    article_id = article.get('id')
    author_id = article.get('authorId')
    if not article_id or not author_id:
        return
    to_ids = _extract_article_links_from_blocks(article.get('blocks') or [])
    # Очищаем старые связи.
    CONN.execute('DELETE FROM article_links WHERE from_id = ?', (article_id,))
    if not to_ids:
        return
    # Вставляем новые, игнорируя ссылки на несуществующие статьи.
    values = [(article_id, tid, 'internal') for tid in to_ids if tid and tid != article_id]
    if not values:
        return
    # Используем единый синтаксис UPSERT, который поддерживается и SQLite (3.24+) и PostgreSQL.
    CONN.executemany(
        '''
        INSERT INTO article_links (from_id, to_id, kind)
        VALUES (?, ?, ?)
        ON CONFLICT (from_id, to_id) DO NOTHING
        ''',
        values,
    )


BLOCK_INSERT_SQL = '''
    INSERT INTO blocks
      (id, article_id, parent_id, position, text, normalized_text, collapsed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
'''
TOKEN_SANITIZE_RE = re.compile(r'[^0-9a-zа-яё]+', re.IGNORECASE)

WIKILINK_RE = re.compile(r'\[\[([^\]]+)\]\]')


def _expand_wikilinks(html_text: str, author_id: str) -> str:
    """
    Раскрывает wikilinks вида [[Название]] в ссылки на существующие статьи пользователя.
    Поиск статьи по названию делается регистронезависимо.
    """
    if not html_text or '[[' not in html_text:
        return html_text

    def _replace(match: re.Match[str]) -> str:
        title_raw = (match.group(1) or '').strip()
        if not title_raw:
            return match.group(0)
        key = title_raw.lower()
        try:
            row = CONN.execute(
                '''
                SELECT id
                FROM articles
                WHERE deleted_at IS NULL
                  AND author_id = ?
                  AND LOWER(title) = ?
                LIMIT 1
                ''',
                (author_id, key),
            ).fetchone()
        except Exception as exc:  # noqa: BLE001
            logger.warning('[wikilink] failed to resolve [[%s]] for author %s: %r', title_raw, author_id, exc)
            return match.group(0)
        if not row:
            # Статья с таким названием не найдена — оставляем как есть.
            return match.group(0)
        article_id = row['id']
        safe_text = html_mod.escape(title_raw, quote=False)
        href = f'/article/{article_id}'
        return f'<a href="{href}">{safe_text}</a>'

    return WIKILINK_RE.sub(_replace, html_text)


def _insert_block_row(params: Tuple[Any, ...]) -> int:
    if IS_POSTGRES:
        row = CONN.execute(BLOCK_INSERT_SQL + ' RETURNING block_rowid', params).fetchone()
        return int(row['block_rowid']) if row else 0
    CONN.execute(BLOCK_INSERT_SQL, params)
    return int(CONN.execute('SELECT last_insert_rowid() as block_rowid').fetchone()['block_rowid'])


def upsert_block_search_index(
    block_rowid: int,
    article_id: str,
    text: str,
    lemma: str,
    normalized_text: str,
) -> None:
    if IS_SQLITE:
        CONN.execute(
            '''
            INSERT OR REPLACE INTO blocks_fts
              (block_rowid, article_id, text, lemma, normalized_text)
            VALUES (?, ?, ?, ?, ?)
            ''',
            (block_rowid, article_id, text, lemma, normalized_text),
        )
        return
    CONN.execute(
        '''
        INSERT INTO blocks_fts (block_rowid, article_id, text, lemma, normalized_text)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (block_rowid) DO UPDATE
        SET article_id = EXCLUDED.article_id,
            text = EXCLUDED.text,
            lemma = EXCLUDED.lemma,
            normalized_text = EXCLUDED.normalized_text
        ''',
        (block_rowid, article_id, text, lemma, normalized_text),
    )


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


def build_article_from_row(row: RowMapping | None) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    raw_encrypted_flag = bool(row.get('is_encrypted', 0))
    has_crypto_meta = bool(row.get('encryption_salt')) and bool(row.get('encryption_verifier'))
    encrypted_flag = raw_encrypted_flag or has_crypto_meta
    if encrypted_flag and not raw_encrypted_flag:
        # Логируем случаи, когда статья считается зашифрованной только по метаданным.
        print(
            '[article_encryption] inferred encrypted article without flag',
            row['id'],
            'salt=' if row.get('encryption_salt') else 'no-salt',
            'verifier=' if row.get('encryption_verifier') else 'no-verifier',
        )
    return {
        'id': row['id'],
        'title': row['title'],
        'createdAt': row['created_at'],
        'updatedAt': row['updated_at'],
        'deletedAt': row['deleted_at'],
        'authorId': row.get('author_id'),
        'publicSlug': row.get('public_slug'),
        'history': deserialize_history(row['history']),
        'redoHistory': deserialize_history(row['redo_history']),
        'encrypted': encrypted_flag,
        'encryptionSalt': row.get('encryption_salt'),
        'encryptionVerifier': row.get('encryption_verifier'),
        'encryptionHint': row.get('encryption_hint'),
        'blocks': rows_to_tree(row['id']),
    }


def get_articles(author_id: str) -> List[Dict[str, Any]]:
    rows = CONN.execute(
        'SELECT * FROM articles WHERE deleted_at IS NULL AND author_id = ? ORDER BY updated_at DESC',
        (author_id,),
    ).fetchall()
    return [build_article_from_row(row) for row in rows if row]


def get_deleted_articles(author_id: str) -> List[Dict[str, Any]]:
    rows = CONN.execute(
        'SELECT * FROM articles WHERE deleted_at IS NOT NULL AND author_id = ? ORDER BY deleted_at DESC',
        (author_id,),
    ).fetchall()
    return [build_article_from_row(row) for row in rows if row]


def get_article(article_id: str, author_id: Optional[str] = None, include_deleted: bool = False) -> Optional[Dict[str, Any]]:
    sql = 'SELECT * FROM articles WHERE id = ?'
    params: List[Any] = [article_id]
    if author_id is not None:
        sql += ' AND author_id = ?'
        params.append(author_id)
    if not include_deleted:
        sql += ' AND deleted_at IS NULL'
    row = CONN.execute(sql, tuple(params)).fetchone()
    return build_article_from_row(row)


def delete_article(article_id: str, force: bool = False) -> bool:
    """Soft-delete article or remove permanently when force=True."""
    with CONN:
        exists = CONN.execute('SELECT 1 FROM articles WHERE id = ?', (article_id,)).fetchone()
        if not exists:
            return False
        if force:
            CONN.execute('DELETE FROM blocks_fts WHERE article_id = ?', (article_id,))
            CONN.execute('DELETE FROM articles_fts WHERE article_id = ?', (article_id,))
            CONN.execute('DELETE FROM blocks WHERE article_id = ?', (article_id,))
            CONN.execute('DELETE FROM articles WHERE id = ?', (article_id,))
        else:
            now = iso_now()
            CONN.execute(
                'UPDATE articles SET deleted_at = ?, updated_at = ? WHERE id = ?',
                (now, now, article_id),
            )
    return True
def restore_article(article_id: str, author_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    with CONN:
        sql = 'SELECT * FROM articles WHERE id = ? AND deleted_at IS NOT NULL'
        params: List[Any] = [article_id]
        if author_id is not None:
            sql += ' AND author_id = ?'
            params.append(author_id)
        row = CONN.execute(sql, tuple(params)).fetchone()
        if not row:
            return None
        now = iso_now()
        CONN.execute(
            'UPDATE articles SET deleted_at = NULL, updated_at = ? WHERE id = ?',
            (now, article_id),
        )
    return get_article(article_id, author_id=author_id, include_deleted=True)

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
        block_rowid = _insert_block_row(
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
        upsert_block_search_index(
            block_rowid,
            article_id,
            block.get('text', ''),
            lemma,
            normalized_text,
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


def _article_search_fields(title: str = '') -> Tuple[str, str, str]:
    plain_title = strip_html(title or '')
    lemma = build_lemma(plain_title)
    normalized = build_normalized_tokens(plain_title)
    return plain_title, lemma, normalized


def upsert_article_search_index(article_id: str, title: str, *, use_transaction: bool = True) -> None:
    plain_title, lemma, normalized = _article_search_fields(title)
    def _execute():
        if IS_SQLITE:
            CONN.execute(
                '''
                INSERT OR REPLACE INTO articles_fts (article_id, title, lemma, normalized_text)
                VALUES (?, ?, ?, ?)
                ''',
                (article_id, plain_title, lemma, normalized),
            )
        else:
            CONN.execute(
                '''
                INSERT INTO articles_fts (article_id, title, lemma, normalized_text)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (article_id) DO UPDATE
                SET title = EXCLUDED.title,
                    lemma = EXCLUDED.lemma,
                    normalized_text = EXCLUDED.normalized_text
                ''',
                (article_id, plain_title, lemma, normalized),
            )
    if use_transaction:
        with CONN:
            _execute()
    else:
        _execute()


def save_article(article: Dict[str, Any]) -> None:
    normalized = normalize_article(article)
    if not normalized:
        return
    now = normalized.get('updatedAt', iso_now())
    normalized['updatedAt'] = now
    title_value = normalized.get('title') or 'Новая статья'
    author_id = normalized.get('authorId')
    public_slug = normalized.get('publicSlug')
    with CONN:
        exists = CONN.execute(
            'SELECT created_at FROM articles WHERE id = ?', (normalized['id'],)
        ).fetchone()
        if exists:
            CONN.execute(
                '''
                UPDATE articles
                SET title = ?, updated_at = ?, history = ?, redo_history = ?, public_slug = ?
                WHERE id = ?
                ''',
                (
                    title_value,
                    now,
                    serialize_history(normalized['history']),
                    serialize_history(normalized['redoHistory']),
                    public_slug,
                    normalized['id'],
                ),
            )
        else:
            CONN.execute(
                '''
                INSERT INTO articles (id, title, created_at, updated_at, history, redo_history, author_id, public_slug)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    normalized['id'],
                    title_value,
                    now,
                    now,
                    serialize_history(normalized['history']),
                    serialize_history(normalized['redoHistory']),
                    author_id,
                    public_slug,
                ),
            )
        CONN.execute('DELETE FROM blocks WHERE article_id = ?', (normalized['id'],))
        CONN.execute('DELETE FROM blocks_fts WHERE article_id = ?', (normalized['id'],))
        insert_blocks_recursive(normalized['id'], normalized['blocks'], now)
        # Обновляем карту ссылок статьи на другие статьи.
        _update_article_links_for_article(normalized)
    upsert_article_search_index(normalized['id'], title_value)


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
    # Примерная статья теперь создаётся только в пользовательском контексте.
    return


def ensure_inbox_article():
    # Глобальный inbox отключён в многопользовательском режиме.
    return


def get_or_create_user_inbox(author_id: str) -> Dict[str, Any]:
    """
    Возвращает статью-инбокс для указанного пользователя, создавая её при необходимости.
    Для каждого пользователя используется свой собственный инбокс с предсказуемым ID.
    """
    inbox_id = f'inbox-{author_id}'
    existing = get_article(inbox_id, author_id=author_id, include_deleted=True)
    if existing:
        # Если инбокс был в корзине — восстанавливаем.
        if existing.get('deletedAt'):
            existing['deletedAt'] = None
            existing['updatedAt'] = iso_now()
            save_article(existing)
        return existing

    now = iso_now()
    article = {
        'id': inbox_id,
        'title': 'Быстрые заметки',
        'createdAt': now,
        'updatedAt': now,
        'blocks': [create_default_block()],
        'history': [],
        'redoHistory': [],
        'authorId': author_id,
    }
    save_article(article)
    return article


def create_article(title: Optional[str] = None, author_id: Optional[str] = None) -> Dict[str, Any]:
    now = iso_now()
    article = {
        'id': str(uuid.uuid4()),
        'title': title or 'Новая статья',
        'createdAt': now,
        'updatedAt': now,
        'blocks': [create_default_block()],
        'history': [],
        'redoHistory': [],
        'authorId': author_id,
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


def delete_user_with_data(user_id: str) -> None:
    """
    Удаляет пользователя, все его статьи и связанные данные (блоки, FTS-индексы, вложения в БД).
    Файлы uploads для этого пользователя удаляются на уровне сервера (см. main.py).
    """
    with CONN:
        article_rows = CONN.execute(
            'SELECT id FROM articles WHERE author_id = ?',
            (user_id,),
        ).fetchall()
        for row in article_rows:
            delete_article(row['id'], force=True)
        # Очистить сессии пользователя, если таблица существует.
        try:
            CONN.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
        except Exception:
            # Таблицы sessions может не быть в старой схеме.
            pass
        CONN.execute('DELETE FROM users WHERE id = ?', (user_id,))


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


def _fetch_siblings(article_id: str, parent_id: Optional[str]) -> List[RowMapping]:
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
        block_rowid = _insert_block_row(
            (block_id, article_id, parent_id, position, text, normalized_text, collapsed, created_at, timestamp)
        )
        upsert_block_search_index(block_rowid, article_id, text, lemma, normalized_text)
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
                new_text = _maybe_convert_pipe_table_html(new_text)

                # Автоматически разворачиваем wikilinks [[...]] в ссылки на статьи пользователя.
                article_row = CONN.execute(
                    'SELECT history, redo_history, author_id FROM articles WHERE id = ?',
                    (article_id,),
                ).fetchone()
                if not article_row:
                    raise ArticleNotFound(f'Статья с ID {article_id} не найдена при обновлении блока')
                author_id = article_row['author_id']
                if author_id:
                    new_text = _expand_wikilinks(new_text, author_id)
                
                article_history = deserialize_history(article_row['history'])
                
                history_entry = push_text_history_entry({'history': article_history, 'redoHistory': []}, block_id, previous_text, new_text)
                
                plain_text = strip_html(new_text)
                lemma = build_lemma(plain_text)
                normalized_text = build_normalized_tokens(plain_text)

                CONN.execute('UPDATE blocks SET text = ?, normalized_text = ?, updated_at = ? WHERE id = ?', (new_text, normalized_text, now, block_id))
                upsert_block_search_index(block_rowid, article_id, new_text, lemma, normalized_text)
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
            CONN.execute(f'DELETE FROM blocks_fts WHERE block_rowid IN ({placeholders})', tuple(rowids))
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


def move_block_to_parent(
    article_id: str,
    block_id: str,
    target_parent_id: Optional[str],
    target_index: Optional[int],
    anchor_id: Optional[str] = None,
    placement: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article:
        raise ArticleNotFound(f'Article {article_id} not found')
    located = find_block_recursive(article['blocks'], block_id)
    if not located:
        raise BlockNotFound(f'Block {block_id} not found')

    # запрет перемещения в себя/потомков
    def collect_ids(block: Dict[str, Any], acc: set[str]) -> None:
        acc.add(block['id'])
        for child in block.get('children') or []:
            collect_ids(child, acc)

    forbidden: set[str] = set()
    collect_ids(located['block'], forbidden)
    if target_parent_id in forbidden:
        raise InvalidOperation('Cannot move into self or descendant')

    # проверим, что целевой родитель существует (если задан)
    if target_parent_id:
        target_parent = find_block_recursive(article['blocks'], target_parent_id)
        if not target_parent:
            raise BlockNotFound(f'Target parent {target_parent_id} not found')

    origin_parent_id = located['parent']['id'] if located['parent'] else None

    # строим порядок siblings по текущему дереву, а не по position
    def build_order_map(blocks: list[Dict[str, Any]], parent_id: Optional[str], mapping: dict[Optional[str], list[str]]):
        mapping.setdefault(parent_id, [])
        for child in blocks or []:
            mapping[parent_id].append(child['id'])
            build_order_map(child.get('children') or [], child['id'], mapping)

    orders: dict[Optional[str], list[str]] = {}
    build_order_map(article.get('blocks') or [], None, orders)

    origin_order = list(orders.get(origin_parent_id, []))
    if block_id not in origin_order:
        raise BlockNotFound(f'Block {block_id} not found in origin siblings')

    target_order = list(orders.get(target_parent_id, []))

    # если целевой родитель тот же, базовый порядок — origin без блока
    if target_parent_id == origin_parent_id:
        target_order = [bid for bid in origin_order if bid != block_id]
    else:
        # удаляем блок, если вдруг он уже фигурирует в целевом списке
        target_order = [bid for bid in target_order if bid != block_id]

    # приоритет: вставка по anchor_id + placement, fallback — по индексу
    insertion_index = None
    if anchor_id and anchor_id in target_order:
        anchor_idx = target_order.index(anchor_id)
        if placement == 'before':
            insertion_index = anchor_idx
        elif placement == 'after':
            insertion_index = anchor_idx + 1
        elif placement == 'inside':
            insertion_index = anchor_idx + 1
    if insertion_index is None:
        desired_index = target_index if isinstance(target_index, int) and target_index >= 0 else len(target_order)
        insertion_index = min(desired_index, len(target_order))
    target_order.insert(insertion_index, block_id)

    now = iso_now()
    with CONN:
        if target_parent_id != origin_parent_id:
            # сжимаем порядок в исходном родителе
            origin_compact = [bid for bid in origin_order if bid != block_id]
            for pos, bid in enumerate(origin_compact):
                CONN.execute(
                    'UPDATE blocks SET position = ?, updated_at = ? WHERE id = ? AND article_id = ?',
                    (pos, now, bid, article_id),
                )

        # выставляем порядок в целевом родителе
        for pos, bid in enumerate(target_order):
            CONN.execute(
                'UPDATE blocks SET parent_id = ?, position = ?, updated_at = ? WHERE id = ? AND article_id = ?',
                (target_parent_id, pos, now, bid, article_id),
            )
        CONN.execute('UPDATE articles SET updated_at = ? WHERE id = ?', (now, article_id))

    return {
        'block': {'id': block_id},
        'parentId': target_parent_id or None,
        'index': insertion_index,
    }


def move_block_to_article(src_article_id: str, block_id: str, target_article_id: str) -> Optional[Dict[str, Any]]:
    if src_article_id == target_article_id:
        raise InvalidOperation('Source and target article are the same')
    src_article = get_article(src_article_id)
    target_article = get_article(target_article_id)
    if not src_article:
        raise ArticleNotFound(f'Article {src_article_id} not found')
    if not target_article:
        raise ArticleNotFound(f'Article {target_article_id} not found')
    located = find_block_recursive(src_article['blocks'], block_id)
    if not located:
        raise BlockNotFound(f'Block {block_id} not found')
    # keep id, move entire subtree
    # remove from source
    removed = delete_block(src_article_id, block_id)
    if not removed or not removed.get('block'):
        raise BlockNotFound(f'Block {block_id} not found')
    payload = removed['block']
    # insert into target as last root child
    siblings = _fetch_siblings(target_article_id, None)
    insertion = len(siblings)
    inserted = _insert_block_tree(target_article_id, payload, None, insertion, iso_now())
    with CONN:
        CONN.execute('UPDATE articles SET updated_at = ? WHERE id = ?', (iso_now(), target_article_id))
    return {'block': inserted, 'targetArticleId': target_article_id, 'index': insertion}


def update_article_meta(article_id: str, attrs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    article = get_article(article_id)
    if not article:
        raise ArticleNotFound(f'Article {article_id} not found')
    title = attrs.get('title')
    encrypted_flag = attrs.get('encrypted')
    salt = attrs.get('encryptionSalt') if 'encryptionSalt' in attrs else None
    verifier = attrs.get('encryptionVerifier') if 'encryptionVerifier' in attrs else None
    hint = attrs.get('encryptionHint') if 'encryptionHint' in attrs else None

    # Determine if anything actually changes.
    title_changed = bool(title) and title != article['title']
    updates: List[str] = []
    params: List[Any] = []

    if title_changed:
        updates.append('title = ?')
        params.append(title)

    if encrypted_flag is not None:
        current = bool(article.get('encrypted'))
        desired = bool(encrypted_flag)
        if desired != current:
            updates.append('is_encrypted = ?')
            # Для SQLite это сохранится как 0/1, для Postgres — как true/false.
            params.append(desired)
            article['encrypted'] = desired

    if 'encryptionSalt' in attrs:
        if salt != article.get('encryptionSalt'):
            updates.append('encryption_salt = ?')
            params.append(salt)
            article['encryptionSalt'] = salt

    if 'encryptionVerifier' in attrs:
        if verifier != article.get('encryptionVerifier'):
            updates.append('encryption_verifier = ?')
            params.append(verifier)
            article['encryptionVerifier'] = verifier

    if 'encryptionHint' in attrs:
        if hint != article.get('encryptionHint'):
            updates.append('encryption_hint = ?')
            params.append(hint)
            article['encryptionHint'] = hint

    if not updates:
        return None

    now = iso_now()
    updates.append('updated_at = ?')
    params.append(now)
    params.append(article_id)
    with CONN:
        CONN.execute(f'UPDATE articles SET {", ".join(updates)} WHERE id = ?', tuple(params))

    if title_changed and title is not None:
        article['title'] = title
    article['updatedAt'] = now
    if title_changed and title is not None:
        upsert_article_search_index(article_id, title)

    # Логируем финальное состояние шифрования статьи для отладки.
    print(
        '[article_encryption] update_article_meta',
        article_id,
        'encrypted=',
        article.get('encrypted'),
        'salt=',
        bool(article.get('encryptionSalt')),
        'verifier=',
        bool(article.get('encryptionVerifier')),
        'hint=',
        bool(article.get('encryptionHint')),
    )
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
        upsert_block_search_index(block_row['block_rowid'], article_id, new_text, lemma, normalized_text)
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
        upsert_block_search_index(block_row['block_rowid'], article_id, new_text, lemma, normalized_text)
        CONN.execute(
            'UPDATE articles SET history = ?, redo_history = ?, updated_at = ? WHERE id = ?',
            (serialize_history(history), serialize_history(redo), now, article_id),
        )
    return {'blockId': block_id, 'block': {'id': block_id, 'text': new_text}}


def _attachment_public_paths(article_id: str, stored_path: str) -> Tuple[str, str]:
    """
    Build a public storedPath (legacy, article-scoped) and a download URL.

    Internally, files are stored under /uploads/<user_id>/attachments/<article_id>/<filename>,
    but API responses historically exposed paths starting with /uploads/<article_id>/.
    To keep compatibility with existing clients and tests, we expose:
      - storedPath: /uploads/<article_id>/<filename>
      - url: the actual download URL (stored_path as saved in DB)
    """
    if not stored_path:
        return f'/uploads/{article_id}/', ''
    filename = stored_path.rsplit('/', 1)[-1]
    public_stored = f'/uploads/{article_id}/{filename}'
    return public_stored, stored_path


def _attachment_from_row(row: RowMapping) -> Dict[str, Any]:
    public_stored, url = _attachment_public_paths(row['article_id'], row['stored_path'])
    return {
        'id': row['id'],
        'articleId': row['article_id'],
        'storedPath': public_stored,
        'originalName': row['original_name'],
        'contentType': row['content_type'] or '',
        'size': row['size'],
        'createdAt': row['created_at'],
        'url': url,
    }


@with_article
def create_attachment(article: Dict[str, Any], stored_path: str, original_name: str, content_type: str, size: int) -> Dict[str, Any]:
    attachment_id = str(uuid.uuid4())
    now = iso_now()
    CONN.execute(
        '''
        INSERT INTO attachments (id, article_id, stored_path, original_name, content_type, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ''',
        (attachment_id, article['id'], stored_path, original_name, content_type or '', size or 0, now),
    )
    public_stored, url = _attachment_public_paths(article['id'], stored_path)
    return {
        'id': attachment_id,
        'articleId': article['id'],
        'storedPath': public_stored,
        'originalName': original_name,
        'contentType': content_type or '',
        'size': size or 0,
        'createdAt': now,
        'url': url,
    }


def list_attachments(article_id: str) -> List[Dict[str, Any]]:
    rows = CONN.execute(
        '''
        SELECT id, article_id, stored_path, original_name, content_type, size, created_at
        FROM attachments
        WHERE article_id = ?
        ORDER BY created_at DESC
        ''',
        (article_id,),
    ).fetchall()
    return [_attachment_from_row(row) for row in rows]


def _tokenize_search_term(term: str) -> Tuple[List[str], List[str]]:
    """
    Разбивает поисковый запрос на леммы и нормализованные токены.
    Дополнительно добавляет "укороченные" префиксы нормализованных токенов, чтобы
    запросы вроде "приветик" могли находить "Привет" (по общему началу слова).
    """
    lemma_tokens = build_lemma_tokens(term)
    base_tokens = [token for token in build_normalized_tokens(term).split() if token]
    prefix_tokens: List[str] = []
    for token in base_tokens:
        # Для более-менее длинных слов добавляем префикс из первых 4–5 символов.
        # Например, "приветик" -> "приве", "integration" -> "integ".
        if len(token) >= 5:
            prefix = token[:5]
            if prefix not in base_tokens:
                prefix_tokens.append(prefix)
    # Сохраняем порядок и убираем дубликаты.
    all_normalized: List[str] = []
    for tok in base_tokens + prefix_tokens:
        if tok not in all_normalized:
            all_normalized.append(tok)
    return lemma_tokens, all_normalized


def _mapping_get_first(mapping: Any, *keys: str) -> Any:
    """
    Безопасно достаёт значение из RowMapping/словаря по первому существующему ключу.
    Нужен из‑за различий в регистре/формате имён колонок между SQLite и Postgres.
    """
    if mapping is None:
        return None
    try:
        keys_view = mapping.keys()
    except Exception:  # noqa: BLE001
        keys_view = ()
    for key in keys:
        if key in keys_view:
            try:
                return mapping[key]
            except Exception:  # noqa: BLE001
                continue
    return None


def build_sqlite_fts_query(term: str) -> str:
    lemma_tokens, normalized_tokens = _tokenize_search_term(term)
    parts = []
    if lemma_tokens:
        parts.append(' OR '.join(f'lemma:{token}*' for token in lemma_tokens))
    if normalized_tokens:
        parts.append(' OR '.join(f'normalized_text:{token}*' for token in normalized_tokens))
    return ' OR '.join(parts)


def build_postgres_ts_query(term: str) -> str:
    lemma_tokens, normalized_tokens = _tokenize_search_term(term)
    cleaned: List[str] = []
    for token in lemma_tokens + normalized_tokens:
        normalized = TOKEN_SANITIZE_RE.sub('', token.lower())
        if normalized:
            cleaned.append(normalized)
    # Preserve order but deduplicate tokens to keep queries short.
    unique_tokens: List[str] = []
    for token in cleaned:
        if token not in unique_tokens:
            unique_tokens.append(token)
    return ' | '.join(f"{token}:*" for token in unique_tokens)


def search_articles(query: str, limit: int = 10, author_id: Optional[str] = None) -> List[Dict[str, Any]]:
    if IS_SQLITE:
        fts_query = build_sqlite_fts_query(query)
        if not fts_query:
            return []
        sql = '''
            SELECT
                articles.id AS articleId,
                articles.title AS title,
                snippet(articles_fts, '', '', '...', -1, 48) AS snippet
            FROM articles_fts
            JOIN articles ON articles.id = articles_fts.article_id
            WHERE articles_fts MATCH ? AND articles.deleted_at IS NULL
        '''
        params: List[Any] = [fts_query]
        if author_id is not None:
            sql += ' AND articles.author_id = ?'
            params.append(author_id)
        sql += ' ORDER BY bm25(articles_fts) ASC LIMIT ?'
        params.append(limit)
        rows = CONN.execute(sql, tuple(params)).fetchall()
    else:
        ts_query = build_postgres_ts_query(query)
        if not ts_query:
            return []
        base_sql = '''
            SELECT
                articles.id AS articleId,
                articles.title AS title,
                ts_headline('simple', articles_fts.title, to_tsquery('simple', ?)) AS snippet,
                ts_rank_cd(articles_fts.search_vector, to_tsquery('simple', ?)) AS rank
            FROM articles_fts
            JOIN articles ON articles.id = articles_fts.article_id
            WHERE articles.deleted_at IS NULL
              AND articles_fts.search_vector @@ to_tsquery('simple', ?)
        '''
        params: List[Any] = [ts_query, ts_query, ts_query]
        if author_id is not None:
            base_sql += ' AND articles.author_id = %s'
            params.append(author_id)
        base_sql += ' ORDER BY rank DESC, articles.updated_at DESC LIMIT %s'
        params.append(limit)
        rows = CONN.execute(base_sql, tuple(params)).fetchall()
    results: List[Dict[str, Any]] = []
    for row in rows:
        mapping = getattr(row, '_mapping', row)
        title = _mapping_get_first(mapping, 'title') or ''
        snippet = _mapping_get_first(mapping, 'snippet') or title
        article_id = _mapping_get_first(mapping, 'articleId', 'articleid', 'article_id')
        results.append(
            {
                'type': 'article',
                'articleId': article_id,
                'articleTitle': title,
                'snippet': snippet,
            }
        )
    return results


def search_blocks(query: str, limit: int = 20, author_id: Optional[str] = None) -> List[Dict[str, Any]]:
    if IS_SQLITE:
        fts_query = build_sqlite_fts_query(query)
        if not fts_query:
            return []
        sql = '''
            SELECT
                blocks.id AS blockId,
                articles.id AS articleId,
                articles.title AS articleTitle,
                snippet(blocks_fts, '', '', '...', -1, 64) AS snippet,
                blocks.text AS blockText
            FROM blocks_fts
            JOIN blocks ON blocks.block_rowid = blocks_fts.block_rowid
            JOIN articles ON articles.id = blocks.article_id
            WHERE blocks_fts MATCH ? AND articles.deleted_at IS NULL
        '''
        params: List[Any] = [fts_query]
        if author_id is not None:
            sql += ' AND articles.author_id = ?'
            params.append(author_id)
        sql += ' ORDER BY bm25(blocks_fts) ASC LIMIT ?'
        params.append(limit)
        rows = CONN.execute(sql, tuple(params)).fetchall()
    else:
        ts_query = build_postgres_ts_query(query)
        if not ts_query:
            return []
        base_sql = '''
            SELECT
                blocks.id AS blockId,
                articles.id AS articleId,
                articles.title AS articleTitle,
                ts_headline('simple', blocks_fts.text, to_tsquery('simple', ?)) AS snippet,
                blocks.text AS blockText,
                ts_rank_cd(blocks_fts.search_vector, to_tsquery('simple', ?)) AS rank
            FROM blocks_fts
            JOIN blocks ON blocks.block_rowid = blocks_fts.block_rowid
            JOIN articles ON articles.id = blocks.article_id
            WHERE articles.deleted_at IS NULL
              AND blocks_fts.search_vector @@ to_tsquery('simple', ?)
        '''
        params: List[Any] = [ts_query, ts_query, ts_query]
        if author_id is not None:
            base_sql += ' AND articles.author_id = %s'
            params.append(author_id)
        base_sql += ' ORDER BY rank DESC, blocks.updated_at DESC LIMIT %s'
        params.append(limit)
        rows = CONN.execute(base_sql, tuple(params)).fetchall()
    results: List[Dict[str, Any]] = []
    for row in rows:
        mapping = getattr(row, '_mapping', row)
        block_text = _mapping_get_first(mapping, 'blockText', 'blocktext', 'block_text', 'text') or ''
        snippet = _mapping_get_first(mapping, 'snippet') or strip_html(block_text)[:160]
        article_id = _mapping_get_first(mapping, 'articleId', 'articleid', 'article_id')
        article_title = _mapping_get_first(mapping, 'articleTitle', 'articletitle', 'article_title') or ''
        block_id = _mapping_get_first(mapping, 'blockId', 'blockid', 'block_id')
        results.append(
            {
                'type': 'block',
                'articleId': article_id,
                'articleTitle': article_title,
                'blockId': block_id,
                'snippet': snippet,
                'blockText': block_text,
            }
        )
    return results


def search_everything(query: str, block_limit: int = 20, article_limit: int = 10, author_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Combined search for articles (by title) and blocks (by content) to support a single search box.
    """
    # Фильтрация по автору делается на уровне SQL join с таблицей articles;
    # поэтому здесь достаточно передать запрос и лимиты, а author_id использовать в SQL.
    articles = search_articles(query, limit=article_limit, author_id=author_id)
    blocks = search_blocks(query, limit=block_limit, author_id=author_id)
    return articles + blocks


def rebuild_search_indexes() -> None:
    """
    Rebuild FTS indexes for articles and blocks from stored data.
    Useful after schema migrations or cold start when virtual tables were recreated.
    """
    with CONN:
        CONN.execute('DELETE FROM blocks_fts')
        CONN.execute('DELETE FROM articles_fts')
    block_rows = CONN.execute(
        'SELECT block_rowid, article_id, text, normalized_text FROM blocks'
    ).fetchall()
    with CONN:
        for row in block_rows:
            plain_text = strip_html(row['text'] or '')
            lemma = build_lemma(plain_text)
            normalized = row['normalized_text'] or build_normalized_tokens(plain_text)
            upsert_block_search_index(
                row['block_rowid'],
                row['article_id'],
                row['text'] or '',
                lemma,
                normalized,
            )
    article_rows = CONN.execute('SELECT id, title FROM articles').fetchall()
    with CONN:
        for row in article_rows:
            upsert_article_search_index(row['id'], row['title'] or '', use_transaction=False)
    mark_search_index_clean()
