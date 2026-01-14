from __future__ import annotations

import html as html_mod
import json
import logging
import os
import re
import uuid
from datetime import datetime
from functools import wraps
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.engine import RowMapping

from .db import CONN, mark_search_index_clean
from .schema import init_schema
from .html_sanitizer import sanitize_html
from .text_utils import build_lemma, build_lemma_tokens, build_normalized_tokens, strip_html
from .outline_doc_json import (
    build_outline_section_internal_links_map,
    build_outline_section_plain_text,
    build_outline_section_plain_text_map,
    build_outline_section_fragments_map,
)
from .blocks_to_outline_doc_json import convert_blocks_to_outline_doc_json
from .semantic_search import (
    delete_block_embeddings,
    upsert_block_embedding,
    upsert_embeddings_for_block_tree,
    upsert_embeddings_for_plain_texts,
)
from .telegram_notify import notify_user

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


def _should_log_structure_snapshot(article_id: str) -> bool:
    """
    Debug logging for /api/articles/{id}/structure/snapshot.

    Enable:
      - SERVPY_DEBUG_STRUCTURE_SNAPSHOT_V1=1
    Optional filter:
      - SERVPY_DEBUG_STRUCTURE_SNAPSHOT_ARTICLE_ID=<article uuid>
    """
    try:
        flag = str(os.environ.get('SERVPY_DEBUG_STRUCTURE_SNAPSHOT_V1') or '').strip().lower()
        if flag not in {'1', 'true', 'yes'}:
            return False
        only_id = str(os.environ.get('SERVPY_DEBUG_STRUCTURE_SNAPSHOT_ARTICLE_ID') or '').strip()
        if only_id and str(article_id or '') != only_id:
            return False
        return True
    except Exception:
        return False


def _json_is_outline_heading(node: Any) -> bool:
    return isinstance(node, dict) and node.get('type') == 'outlineHeading' and isinstance(node.get('content', []), list)


def _json_is_outline_body(node: Any) -> bool:
    return isinstance(node, dict) and node.get('type') == 'outlineBody' and isinstance(node.get('content', []), list)


def _ensure_outline_section_node(section_id: str, *, heading: Any | None = None, body: Any | None = None) -> dict[str, Any]:
    sid = str(section_id or '').strip()
    if not sid:
        raise InvalidOperation('sectionId is required')
    heading_node = heading if _json_is_outline_heading(heading) else {'type': 'outlineHeading', 'content': []}
    body_node = body if _json_is_outline_body(body) else {'type': 'outlineBody', 'content': [{'type': 'paragraph'}]}
    return {
        'type': 'outlineSection',
        'attrs': {'id': sid, 'collapsed': False},
        'content': [
            heading_node,
            body_node,
            {'type': 'outlineChildren', 'content': []},
        ],
    }


def _walk_outline_sections(doc_json: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        if node.get('type') == 'outlineSection':
            out.append(node)
            for child in node.get('content') or []:
                if isinstance(child, dict) and child.get('type') == 'outlineChildren':
                    walk(child.get('content') or [])
                    break
            return
        walk(node.get('content') or [])

    walk(doc_json)
    return out


def _find_outline_section_by_id(doc_json: Any, section_id: str) -> dict[str, Any] | None:
    sid = str(section_id or '').strip()
    if not sid:
        return None
    for sec in _walk_outline_sections(doc_json):
        attrs = sec.get('attrs') or {}
        if str(attrs.get('id') or '').strip() == sid:
            return sec
    return None


def _delete_outline_section_by_id(doc_json: Any, section_id: str) -> bool:
    sid = str(section_id or '').strip()
    if not sid or not isinstance(doc_json, dict):
        return False

    def filter_sections(items: list[Any]) -> tuple[list[Any], bool]:
        changed = False
        out_items: list[Any] = []
        for item in items:
            if isinstance(item, dict) and item.get('type') == 'outlineSection':
                attrs = item.get('attrs') or {}
                if str(attrs.get('id') or '').strip() == sid:
                    changed = True
                    continue
                for child in item.get('content') or []:
                    if isinstance(child, dict) and child.get('type') == 'outlineChildren':
                        new_children, ch = filter_sections(child.get('content') or [])
                        if ch:
                            child['content'] = new_children
                            changed = True
                        break
            out_items.append(item)
        return out_items, changed

    root = doc_json.get('content') or []
    if not isinstance(root, list):
        return False
    new_root, changed = filter_sections(root)
    if changed:
        doc_json['content'] = new_root
    return changed


def _build_outline_structure_nodes(doc_json: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def walk_list(items: list[Any], parent_id: str | None) -> None:
        pos = 0
        for item in items:
            if not isinstance(item, dict) or item.get('type') != 'outlineSection':
                continue
            attrs = item.get('attrs') or {}
            sid = str(attrs.get('id') or '').strip()
            if not sid:
                continue
            out.append(
                {
                    'sectionId': sid,
                    'parentId': parent_id,
                    'position': pos,
                    'collapsed': bool(attrs.get('collapsed', False)),
                }
            )
            pos += 1
            for child in item.get('content') or []:
                if isinstance(child, dict) and child.get('type') == 'outlineChildren':
                    walk_list(child.get('content') or [], sid)
                    break

    if isinstance(doc_json, dict) and isinstance(doc_json.get('content'), list):
        walk_list(doc_json.get('content') or [], None)
    return out


def _apply_outline_structure_snapshot(doc_json: Any, nodes: list[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(doc_json, dict) or doc_json.get('type') != 'doc' or not isinstance(doc_json.get('content'), list):
        doc_json = {'type': 'doc', 'content': []}

    existing_by_id: dict[str, dict[str, Any]] = {}
    for sec in _walk_outline_sections(doc_json):
        attrs = sec.get('attrs') or {}
        sid = str(attrs.get('id') or '').strip()
        if sid:
            existing_by_id[sid] = sec

    mentioned: set[str] = set()
    children_by_parent: dict[str | None, list[tuple[int, str, dict[str, Any]]]] = {}
    for row in nodes or []:
        sid = str(row.get('sectionId') or '').strip()
        if not sid:
            continue
        # Structure snapshots must not create missing sections.
        # Section creation is done via content upsert; snapshots only re-parent/reorder/collapse existing nodes.
        sec = existing_by_id.get(sid)
        if not sec:
            continue
        parent_raw = row.get('parentId')
        parent_id = str(parent_raw).strip() if parent_raw is not None and str(parent_raw).strip() else None
        try:
            pos = int(row.get('position') or 0)
        except Exception:
            pos = 0
        collapsed = bool(row.get('collapsed', False))
        attrs = sec.get('attrs') or {}
        attrs['id'] = sid
        attrs['collapsed'] = collapsed
        sec['attrs'] = attrs
        content = sec.get('content') or []
        # Ensure basic shape and children container.
        if not isinstance(content, list) or len(content) < 3:
            heading = None
            body = None
            for c in content if isinstance(content, list) else []:
                if isinstance(c, dict) and c.get('type') == 'outlineHeading':
                    heading = c
                elif isinstance(c, dict) and c.get('type') == 'outlineBody':
                    body = c
            sec['content'] = [
                heading if _json_is_outline_heading(heading) else {'type': 'outlineHeading', 'content': []},
                body if _json_is_outline_body(body) else {'type': 'outlineBody', 'content': [{'type': 'paragraph'}]},
                {'type': 'outlineChildren', 'content': []},
            ]
        else:
            if not isinstance(content[2], dict) or content[2].get('type') != 'outlineChildren':
                content[2] = {'type': 'outlineChildren', 'content': []}
            elif not isinstance(content[2].get('content'), list):
                content[2]['content'] = []
            sec['content'] = content

        existing_by_id[sid] = sec
        mentioned.add(sid)
        children_by_parent.setdefault(parent_id, []).append((pos, sid, sec))

    for parent_id, lst in children_by_parent.items():
        lst.sort(key=lambda t: (t[0], t[1]))
        children_by_parent[parent_id] = lst

    for sid, sec in existing_by_id.items():
        children = [row[2] for row in children_by_parent.get(sid, [])]
        try:
            sec['content'][2]['content'] = children
        except Exception:
            pass

    root = [row[2] for row in children_by_parent.get(None, [])]
    for sid, sec in existing_by_id.items():
        if sid in mentioned:
            continue
        root.append(sec)

    doc_json['type'] = 'doc'
    doc_json['content'] = root
    return doc_json


def _try_mark_op_applied(op_id: str, *, article_id: str, op_type: str, section_id: str | None = None) -> bool:
    oid = str(op_id or '').strip()
    if not oid:
        return True
    now = iso_now()
    now_dt = datetime.utcnow()
    now_dt = datetime.utcnow()
    now_dt = datetime.utcnow()
    try:
        with CONN:
            row = CONN.execute('SELECT 1 AS ok FROM applied_ops WHERE op_id = ?', (oid,)).fetchone()
            if row:
                return False
            CONN.execute(
                'INSERT INTO applied_ops (op_id, article_id, section_id, op_type, created_at) VALUES (?, ?, ?, ?, ?)',
                (oid, article_id, section_id, op_type, now),
            )
    except Exception:
        return True
    return True


def _coerce_embedding_to_list(value: Any) -> list[float]:
    """
    Converts pgvector/driver embedding values into a JSON-serializable list[float].
    Handles cases where driver returns:
      - list[float]
      - tuple[float]
      - string like '[0.1, 0.2, ...]'
    """
    if value is None:
        return []
    if isinstance(value, list):
        try:
            return [float(x) for x in value]
        except Exception:
            return []
    if isinstance(value, tuple):
        try:
            return [float(x) for x in value]
        except Exception:
            return []
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return []
        # pgvector often renders as '[..]'. Sometimes as '(..)'.
        if raw[0] == '(' and raw[-1] == ')':
            raw = '[' + raw[1:-1] + ']'
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [float(x) for x in parsed]
        except Exception:
            pass
        # fallback: split by comma
        if raw.startswith('[') and raw.endswith(']'):
            raw = raw[1:-1]
        parts = [p.strip() for p in raw.split(',') if p.strip()]
        try:
            return [float(p) for p in parts]
        except Exception:
            return []
    return []


def get_article_block_embeddings(
    *,
    article_id: str,
    author_id: str,
    since: str | None = None,
    block_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    """
    Returns embeddings for outline sections (block_id == section_id) for a given article.
    Used for offline-first client to perform semantic ranking locally.
    """
    if not article_id or not author_id:
        return []
    ids = [str(x) for x in (block_ids or []) if str(x)]
    sql = (
        'SELECT be.block_id AS blockId, be.article_id AS articleId, be.updated_at AS updatedAt, be.embedding AS embedding '
        'FROM block_embeddings be '
        'JOIN articles a ON a.id = be.article_id '
        'WHERE a.deleted_at IS NULL AND be.article_id = ? AND be.author_id = ?'
    )
    params: list[Any] = [article_id, author_id]
    if since:
        sql += ' AND be.updated_at > ?'
        params.append(since)
    if ids:
        placeholders = ','.join('?' for _ in ids)
        sql += f' AND be.block_id IN ({placeholders})'
        params.extend(ids)
    sql += ' ORDER BY be.updated_at DESC'
    rows = CONN.execute(sql, tuple(params)).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows or []:
        mapping = getattr(row, '_mapping', row)
        bid = _mapping_get_first(mapping, 'blockId', 'blockid', 'block_id') or ''
        updated_at = _mapping_get_first(mapping, 'updatedAt', 'updated_at') or ''
        emb = _mapping_get_first(mapping, 'embedding')  # may be list/str
        out.append(
            {
                'blockId': bid,
                'updatedAt': updated_at,
                'embedding': _coerce_embedding_to_list(emb),
            }
        )
    return out


_PIPE_TABLE_RE = re.compile(
    r'^(?:\s*<p>(?:\s|\&nbsp;|<br\s*/?>)*\|.*?\|\s*</p>\s*)+$',
    re.IGNORECASE | re.DOTALL,
)

_INTERNAL_ARTICLE_HREF_RE = re.compile(
    r'href="/article/([0-9a-fA-F-]+)"',
    re.IGNORECASE,
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


def get_yandex_tokens(user_id: str) -> Optional[Dict[str, Any]]:
    if not user_id:
        return None
    row = CONN.execute(
        'SELECT user_id, access_token, refresh_token, expires_at, disk_root, initialized '
        'FROM user_yandex_tokens WHERE user_id = ?',
        (user_id,),
    ).fetchone()
    if not row:
        return None
    return {
        'userId': row['user_id'],
        'accessToken': row['access_token'],
        'refreshToken': row.get('refresh_token'),
        'expiresAt': row.get('expires_at'),
        'diskRoot': row.get('disk_root') or 'app:/',
        'initialized': bool(row.get('initialized')),
    }


def upsert_yandex_tokens(
    user_id: str,
    access_token: str,
    refresh_token: Optional[str] = None,
    expires_at: Optional[str] = None,
    disk_root: str = 'disk:/Memus',
) -> None:
    if not user_id or not access_token:
        return
    existing = CONN.execute(
        'SELECT user_id FROM user_yandex_tokens WHERE user_id = ?',
        (user_id,),
    ).fetchone()
    if existing:
        CONN.execute(
            '''
            UPDATE user_yandex_tokens
            SET access_token = ?, refresh_token = ?, expires_at = ?, disk_root = ?
            WHERE user_id = ?
            ''',
            (access_token, refresh_token, expires_at, disk_root, user_id),
        )
    else:
        CONN.execute(
            '''
            INSERT INTO user_yandex_tokens (user_id, access_token, refresh_token, expires_at, disk_root, initialized)
            VALUES (?, ?, ?, ?, ?, FALSE)
            ''',
            (user_id, access_token, refresh_token, expires_at, disk_root),
        )


def _extract_article_ids_from_html(html_text: str) -> set[str]:
    """
    Извлекает ID статей из HTML‑фрагмента по href="/article/<id>".
    Возвращает множество уникальных to_id.
    """
    ids: set[str] = set()
    if not html_text or '/article/' not in html_text:
        return ids
    for match in _INTERNAL_ARTICLE_HREF_RE.finditer(html_text):
        target_id = match.group(1)
        if target_id:
            ids.add(target_id)
    return ids


def _extract_article_links_from_blocks(blocks: List[Dict[str, Any]]) -> List[str]:
    """
    Извлекает ID статей, на которые ссылаются блоки (по href="/article/<id>").
    Возвращает список уникальных to_id.
    """
    ids: set[str] = set()

    def walk(node_list: List[Dict[str, Any]]):
        for blk in node_list or []:
            text = blk.get('text') or ''
            ids.update(_extract_article_ids_from_html(text))
            children = blk.get('children') or []
            walk(children)

    walk(blocks or [])
    return list(ids)


def _rebuild_article_links_for_article_id(article_id: str, *, doc_json: Any | None = None) -> None:
    """
    Пересобирает связи article_links для статьи по всем её блокам
    (используется при инкрементальном редактировании блоков).
    """
    if not article_id:
        return

    # doc_json-first: extract links from outline sections (heading+body, without children).
    if doc_json is not None:
        CONN.execute('DELETE FROM article_links WHERE from_id = ?', (article_id,))
        values: list[tuple[str, str, str, str]] = []
        try:
            link_map = build_outline_section_internal_links_map(doc_json)
        except Exception:
            link_map = {}
        for section_id, targets in (link_map or {}).items():
            for target_id in targets or set():
                if not target_id or target_id == article_id:
                    continue
                values.append((article_id, section_id, target_id, 'internal'))
        if values:
            # IMPORTANT:
            # `article_links.to_id` has a FK to `articles.id`. Links to missing articles MUST be skipped,
            # otherwise Postgres marks the whole transaction as aborted and callers (like structure snapshots)
            # get rolled back.
            #
            # Do it in a single statement with a JOIN to `articles` to guarantee FK safety.
            placeholders = ','.join(['(?, ?, ?)'] * len(values))
            params: list[Any] = []
            for _, block_id, to_id, kind in values:
                params.extend([block_id, to_id, kind])
            CONN.execute(
                f'''
                INSERT INTO article_links (from_id, block_id, to_id, kind)
                SELECT ?, v.block_id, v.to_id, v.kind
                FROM (VALUES {placeholders}) AS v(block_id, to_id, kind)
                JOIN articles a ON a.id = v.to_id
                ON CONFLICT (from_id, block_id, to_id) DO NOTHING
                ''',
                (article_id, *params),
            )
        return

    rows = CONN.execute(
        'SELECT id, text FROM blocks WHERE article_id = ?',
        (article_id,),
    ).fetchall()

    # Очищаем старые связи.
    CONN.execute('DELETE FROM article_links WHERE from_id = ?', (article_id,))

    values: list[tuple[str, str, str, str]] = []
    for row in rows or []:
        block_id = row.get('id')
        text = row.get('text') or ''
        if not block_id or not text:
            continue
        to_ids = _extract_article_ids_from_html(text)
        for target_id in to_ids:
            if target_id and target_id != article_id:
                values.append((article_id, block_id, target_id, 'internal'))

    if not values:
        return

    CONN.executemany(
        '''
        INSERT INTO article_links (from_id, block_id, to_id, kind)
        VALUES (?, ?, ?, ?)
        ''',
        values,
    )


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
    # Полностью пересчитываем связи по всем блокам статьи.
    _rebuild_article_links_for_article_id(article_id)


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
    row = CONN.execute(BLOCK_INSERT_SQL + ' RETURNING block_rowid', params).fetchone()
    return int(row['block_rowid']) if row else 0


def upsert_block_search_index(
    block_rowid: int,
    article_id: str,
    text: str,
    lemma: str,
    normalized_text: str,
) -> None:
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


def upsert_outline_section_search_index(
    section_id: str,
    article_id: str,
    text: str,
    lemma: str,
    normalized_text: str,
    updated_at: str,
) -> None:
    if not section_id:
        return
    CONN.execute(
        '''
        INSERT INTO outline_sections_fts (section_id, article_id, text, lemma, normalized_text, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (section_id) DO UPDATE
        SET article_id = EXCLUDED.article_id,
            text = EXCLUDED.text,
            lemma = EXCLUDED.lemma,
            normalized_text = EXCLUDED.normalized_text,
            updated_at = EXCLUDED.updated_at
        ''',
        (section_id, article_id, text, lemma, normalized_text, updated_at),
    )


def delete_outline_sections_search_index(section_ids: list[str]) -> None:
    ids = [s for s in (section_ids or []) if s]
    if not ids:
        return
    placeholders = ','.join('?' for _ in ids)
    CONN.execute(f'DELETE FROM outline_sections_fts WHERE section_id IN ({placeholders})', tuple(ids))


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


def build_article_from_row(row: RowMapping | None, *, include_blocks: bool = True) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    encrypted_flag = _infer_article_encrypted_flag(row, log_inferred=True)
    doc_json_value = None
    if not encrypted_flag:
        raw_doc_json = row.get('article_doc_json')
        if raw_doc_json:
            try:
                parsed = json.loads(raw_doc_json)
                # Treat empty/invalid outline docs as missing to enable self-heal from legacy blocks/versions.
                if (
                    isinstance(parsed, dict)
                    and parsed.get('type') == 'doc'
                    and isinstance(parsed.get('content'), list)
                    and len(parsed.get('content') or []) > 0
                ):
                    doc_json_value = parsed
                else:
                    doc_json_value = None
            except Exception:
                doc_json_value = None

    article = {
        'id': row['id'],
        'title': row['title'],
        'createdAt': row['created_at'],
        'updatedAt': row['updated_at'],
        'deletedAt': row['deleted_at'],
        'parentId': row.get('parent_id'),
        'position': row.get('position') or 0,
        'authorId': row.get('author_id'),
        'publicSlug': row.get('public_slug'),
        'outlineStructureRev': int(row.get('outline_structure_rev') or 0) if row.get('outline_structure_rev') is not None else 0,
        'history': deserialize_history(row['history']),
        'redoHistory': deserialize_history(row['redo_history']),
        'blockTrash': deserialize_history(row.get('block_trash')),
        'encrypted': encrypted_flag,
        'encryptionSalt': row.get('encryption_salt'),
        'encryptionVerifier': row.get('encryption_verifier'),
        'encryptionHint': row.get('encryption_hint'),
        'docJson': doc_json_value,
    }
    # Legacy HTML blocks storage is deprecated; always return empty blocks.
    article['blocks'] = []
    return article


def _infer_article_encrypted_flag(row: RowMapping, *, log_inferred: bool = False) -> bool:
    raw_encrypted_flag = bool(row.get('is_encrypted', 0))
    has_crypto_meta = bool(row.get('encryption_salt')) and bool(row.get('encryption_verifier'))
    encrypted_flag = raw_encrypted_flag or has_crypto_meta
    if log_inferred and encrypted_flag and not raw_encrypted_flag:
        # Логируем случаи, когда статья считается зашифрованной только по метаданным.
        print(
            '[article_encryption] inferred encrypted article without flag',
            row['id'],
            'salt=' if row.get('encryption_salt') else 'no-salt',
            'verifier=' if row.get('encryption_verifier') else 'no-verifier',
        )
    return encrypted_flag


def get_articles(author_id: str) -> List[Dict[str, Any]]:
    rows = CONN.execute(
        'SELECT * FROM articles WHERE deleted_at IS NULL AND author_id = ? ORDER BY parent_id IS NOT NULL, parent_id, position, updated_at DESC',
        (author_id,),
    ).fetchall()
    return [build_article_from_row(row, include_blocks=False) for row in rows if row]


def get_articles_index(author_id: str) -> List[Dict[str, Any]]:
    """
    Лёгкий индекс статей для UI/оффлайна.
    ВАЖНО: не парсит article_doc_json и не десериализует history, чтобы /api/articles был быстрым.
    """
    rows = CONN.execute(
        """
        SELECT id, title, updated_at, parent_id, position, public_slug, is_encrypted, encryption_salt, encryption_verifier
        FROM articles
        WHERE deleted_at IS NULL AND author_id = ?
        ORDER BY parent_id IS NOT NULL, parent_id, position, updated_at DESC
        """,
        (author_id,),
    ).fetchall()
    out: List[Dict[str, Any]] = []
    for row in rows:
        if not row:
            continue
        out.append(
            {
                'id': row['id'],
                'title': row['title'],
                'updatedAt': row['updated_at'],
                'parentId': row.get('parent_id'),
                'position': row.get('position') or 0,
                'publicSlug': row.get('public_slug'),
                'encrypted': _infer_article_encrypted_flag(row, log_inferred=False),
            }
        )
    return out


def get_deleted_articles(author_id: str) -> List[Dict[str, Any]]:
    rows = CONN.execute(
        'SELECT * FROM articles WHERE deleted_at IS NOT NULL AND author_id = ? ORDER BY deleted_at DESC',
        (author_id,),
    ).fetchall()
    return [build_article_from_row(row, include_blocks=False) for row in rows if row]


def _fetch_article_siblings(parent_id: Optional[str], author_id: str) -> list[RowMapping]:
    if parent_id is None:
        return CONN.execute(
            'SELECT id, parent_id, position FROM articles WHERE deleted_at IS NULL AND author_id = ? AND parent_id IS NULL ORDER BY position',
            (author_id,),
        ).fetchall()
    return CONN.execute(
        'SELECT id, parent_id, position FROM articles WHERE deleted_at IS NULL AND author_id = ? AND parent_id = ? ORDER BY position',
        (author_id, parent_id),
    ).fetchall()


def move_article_to_parent(
    article_id: str,
    target_parent_id: Optional[str],
    author_id: str,
    anchor_id: Optional[str] = None,
    placement: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Перемещает статью в новый родитель и позицию внутри него.

    Поведение похоже на move_block_to_parent:
    - target_parent_id = None — корень;
    - anchor_id + placement ('before'/'after'/'inside') определяют место вставки;
    - если anchor_id не задан, статья добавляется в конец children целевого родителя.
    """
    rows = CONN.execute(
        'SELECT id, parent_id, position FROM articles WHERE deleted_at IS NULL AND author_id = ? ORDER BY position',
        (author_id,),
    ).fetchall()
    if not rows:
        raise ArticleNotFound('Article not found')

    # Собираем дерево: parent_id -> [child_ids] в порядке position.
    children_map: dict[Optional[str], list[str]] = {}
    for row in rows:
        pid = row['parent_id']
        aid = row['id']
        children_map.setdefault(pid, []).append(aid)

    all_ids = {row['id'] for row in rows}
    if article_id not in all_ids:
        raise ArticleNotFound('Article not found')
    if target_parent_id is not None and target_parent_id not in all_ids:
        raise ArticleNotFound('Target parent not found')

    # Запрещаем перемещение в себя или в потомка.
    descendants: set[str] = set()

    def collect_descendants(current_id: str) -> None:
        for child_id in children_map.get(current_id, []):
            if child_id not in descendants:
                descendants.add(child_id)
                collect_descendants(child_id)

    collect_descendants(article_id)
    if target_parent_id is not None and target_parent_id in descendants.union({article_id}):
        raise InvalidOperation('Cannot move article into itself or its descendant')

    # Исходный родитель.
    origin_parent_id: Optional[str] = None
    for row in rows:
        if row['id'] == article_id:
            origin_parent_id = row['parent_id']
            break

    origin_order = list(children_map.get(origin_parent_id, []))
    if article_id not in origin_order:
        raise ArticleNotFound('Article not found in origin siblings')

    # Базовый список потомков целевого родителя.
    target_order = list(children_map.get(target_parent_id, []))
    # Удаляем статью, если она там уже фигурирует.
    target_order = [aid for aid in target_order if aid != article_id]

    # Если целевой родитель тот же, работаем с origin без текущей статьи.
    if target_parent_id == origin_parent_id:
        target_order = [aid for aid in origin_order if aid != article_id]

    insertion_index: Optional[int] = None
    # Вставка «внутрь» всегда делает статью последним ребёнком,
    # независимо от положения курсора или anchor_id.
    if placement == 'inside':
        insertion_index = len(target_order)
    elif anchor_id and anchor_id in target_order:
        anchor_idx = target_order.index(anchor_id)
        if placement == 'before':
            insertion_index = anchor_idx
        elif placement == 'after':
            insertion_index = anchor_idx + 1
    if insertion_index is None:
        insertion_index = len(target_order)

    insertion_index = max(0, min(insertion_index, len(target_order)))
    target_order.insert(insertion_index, article_id)

    now = iso_now()
    with CONN:
        if target_parent_id != origin_parent_id:
            # Сжимаем порядок в исходном родителе.
            origin_compact = [aid for aid in origin_order if aid != article_id]
            for pos, aid in enumerate(origin_compact):
                CONN.execute(
                    'UPDATE articles SET position = ?, updated_at = ? WHERE id = ? AND author_id = ?',
                    (pos, now, aid, author_id),
                )

        # Выставляем порядок для целевого родителя.
        for pos, aid in enumerate(target_order):
            CONN.execute(
                'UPDATE articles SET parent_id = ?, position = ?, updated_at = ? WHERE id = ? AND author_id = ?',
                (target_parent_id, pos, now, aid, author_id),
            )

    return get_article(article_id, author_id)


def move_article(article_id: str, direction: str, author_id: str) -> Dict[str, Any]:
    row = CONN.execute(
        'SELECT parent_id FROM articles WHERE id = ? AND author_id = ? AND deleted_at IS NULL',
        (article_id, author_id),
    ).fetchone()
    if not row:
        raise ArticleNotFound('Article not found')
    parent_id = row['parent_id']
    siblings = _fetch_article_siblings(parent_id, author_id)
    ids = [r['id'] for r in siblings]
    if article_id not in ids:
        raise ArticleNotFound('Article not found')
    idx = ids.index(article_id)
    if direction == 'up' and idx == 0:
        return get_article(article_id, author_id)
    if direction == 'down' and idx == len(ids) - 1:
        return get_article(article_id, author_id)
    new_idx = idx - 1 if direction == 'up' else idx + 1
    ids[idx], ids[new_idx] = ids[new_idx], ids[idx]
    with CONN:
        for pos, aid in enumerate(ids):
            CONN.execute(
                'UPDATE articles SET position = ? WHERE id = ? AND author_id = ?',
                (pos, aid, author_id),
            )
    return get_article(article_id, author_id)


def indent_article(article_id: str, author_id: str) -> Dict[str, Any]:
    row = CONN.execute(
        'SELECT parent_id FROM articles WHERE id = ? AND author_id = ? AND deleted_at IS NULL',
        (article_id, author_id),
    ).fetchone()
    if not row:
        raise ArticleNotFound('Article not found')
    parent_id = row['parent_id']
    siblings = _fetch_article_siblings(parent_id, author_id)
    ids = [r['id'] for r in siblings]
    if article_id not in ids:
        raise ArticleNotFound('Article not found')
    idx = ids.index(article_id)
    if idx == 0:
        # Не во что вкладывать.
        return get_article(article_id, author_id)
    new_parent_id = ids[idx - 1]
    max_pos_row = CONN.execute(
        'SELECT MAX(position) AS maxp FROM articles WHERE parent_id = ? AND author_id = ? AND deleted_at IS NULL',
        (new_parent_id, author_id),
    ).fetchone()
    new_pos = (max_pos_row['maxp'] or 0) + 1
    now = iso_now()
    with CONN:
        CONN.execute(
            'UPDATE articles SET parent_id = ?, position = ?, updated_at = ? WHERE id = ? AND author_id = ?',
            (new_parent_id, new_pos, now, article_id, author_id),
        )
    return get_article(article_id, author_id)


def outdent_article(article_id: str, author_id: str) -> Dict[str, Any]:
    row = CONN.execute(
        'SELECT parent_id FROM articles WHERE id = ? AND author_id = ? AND deleted_at IS NULL',
        (article_id, author_id),
    ).fetchone()
    if not row:
        raise ArticleNotFound('Article not found')
    parent_id = row['parent_id']
    if not parent_id:
        # Уже в корне
        return get_article(article_id, author_id)

    parent_row = CONN.execute(
        'SELECT parent_id FROM articles WHERE id = ? AND author_id = ? AND deleted_at IS NULL',
        (parent_id, author_id),
    ).fetchone()
    new_parent_id = parent_row['parent_id'] if parent_row else None

    siblings = _fetch_article_siblings(new_parent_id, author_id)
    ids = [r['id'] for r in siblings]
    insert_after_idx = len(ids) - 1
    if parent_id in ids:
        insert_after_idx = ids.index(parent_id)
    # Строим новый порядок: оставляем все, но добавим/переместим article_id после parent_id.
    if article_id in ids:
        ids.remove(article_id)
    ids.insert(insert_after_idx + 1, article_id)

    now = iso_now()
    with CONN:
        for pos, aid in enumerate(ids):
            CONN.execute(
                'UPDATE articles SET parent_id = ?, position = ?, updated_at = ? WHERE id = ? AND author_id = ?',
                (new_parent_id, pos, now, aid, author_id),
            )
    return get_article(article_id, author_id)


def get_article(
    article_id: str,
    author_id: Optional[str] = None,
    include_deleted: bool = False,
    *,
    include_blocks: bool = True,
) -> Optional[Dict[str, Any]]:
    sql = 'SELECT * FROM articles WHERE id = ?'
    params: List[Any] = [article_id]
    if author_id is not None:
        sql += ' AND author_id = ?'
        params.append(author_id)
    if not include_deleted:
        sql += ' AND deleted_at IS NULL'
    row = CONN.execute(sql, tuple(params)).fetchone()
    article = build_article_from_row(row, include_blocks=include_blocks)
    if not row or not article:
        return article
    try:
        encrypted_flag = bool(row.get('is_encrypted', 0)) or (
            bool(row.get('encryption_salt')) and bool(row.get('encryption_verifier'))
        )
        has_doc_json = bool(article.get('docJson'))

        def _touch_doc_json(doc_json: Any) -> bool:
            """
            Persist docJson and bump updated_at.
            This is a recovery-only helper (rare path) so client meta checks notice the change.
            """
            try:
                doc_json_str = json.dumps(doc_json, ensure_ascii=False)
            except Exception:
                return False
            now = iso_now()
            with CONN:
                CONN.execute(
                    'UPDATE articles SET article_doc_json = ?, updated_at = ?, redo_history = ? WHERE id = ?',
                    (doc_json_str, now, '[]', article_id),
                )
            return True

        def _try_restore_from_latest_version() -> bool:
            try:
                ver = CONN.execute(
                    'SELECT doc_json FROM article_versions WHERE article_id = ? AND doc_json IS NOT NULL ORDER BY created_at DESC LIMIT 1',
                    (article_id,),
                ).fetchone()
                raw_ver = (ver.get('doc_json') if ver else None) or ''
                if not raw_ver:
                    return False
                vj = json.loads(raw_ver)
                if isinstance(vj, dict) and vj.get('content'):
                    return _touch_doc_json(vj)
            except Exception:
                return False
            return False

        def _try_restore_inbox_from_history() -> bool:
            # Inbox is outline-first: blocks table is not authoritative and can be incomplete/empty.
            try:
                raw_hist = row.get('history') or '[]'
                hist = json.loads(raw_hist) if isinstance(raw_hist, str) else (raw_hist or [])
            except Exception:
                hist = []
            if not isinstance(hist, list) or not hist:
                return False
            latest_by_id: dict[str, dict[str, Any]] = {}
            ts_by_id: dict[str, float] = {}
            for e in hist:
                if not isinstance(e, dict):
                    continue
                sid = str(e.get('blockId') or '').strip()
                if not sid:
                    continue
                ts = 0.0
                try:
                    ts = datetime.fromisoformat(str(e.get('timestamp') or '')).timestamp()
                except Exception:
                    ts = 0.0
                # Keep newest per section.
                if sid in ts_by_id and ts <= ts_by_id[sid]:
                    continue
                after_heading = e.get('afterHeadingJson')
                after_body = e.get('afterBodyJson')
                if not isinstance(after_heading, dict) and not isinstance(after_body, dict):
                    continue
                latest_by_id[sid] = {
                    'heading': after_heading if isinstance(after_heading, dict) else {'type': 'outlineHeading', 'content': []},
                    'body': after_body if isinstance(after_body, dict) else {'type': 'outlineBody', 'content': [{'type': 'paragraph'}]},
                }
                ts_by_id[sid] = ts

            if not latest_by_id:
                return False

            ordered = sorted(latest_by_id.keys(), key=lambda sid: (ts_by_id.get(sid, 0.0), sid), reverse=True)
            rebuilt: dict[str, Any] = {'type': 'doc', 'content': []}
            for sid in ordered:
                frag = latest_by_id[sid]
                rebuilt['content'].append(
                    {
                        'type': 'outlineSection',
                        'attrs': {'id': sid, 'collapsed': False},
                        'content': [
                            frag.get('heading') or {'type': 'outlineHeading', 'content': []},
                            frag.get('body') or {'type': 'outlineBody', 'content': [{'type': 'paragraph'}]},
                            {'type': 'outlineChildren', 'content': []},
                        ],
                    }
                )
            return _touch_doc_json(rebuilt)

        # Self-heal: if doc_json is missing/invalid, try to restore it.
        if (not encrypted_flag) and (not has_doc_json):
            # Inbox is outline-first: never rebuild from legacy blocks.
            if str(article_id).startswith('inbox-'):
                if _try_restore_inbox_from_history() or _try_restore_from_latest_version():
                    row2 = CONN.execute(sql, tuple(params)).fetchone()
                    article2 = build_article_from_row(row2, include_blocks=include_blocks)
                    return article2 or article
                return article

            # For legacy articles, prefer restoring from the latest version snapshot first.
            if _try_restore_from_latest_version():
                row2 = CONN.execute(sql, tuple(params)).fetchone()
                article2 = build_article_from_row(row2, include_blocks=include_blocks)
                return article2 or article

            # No fallback to legacy blocks: docJson is the only source of truth.
    except Exception:
        return article
    return article


def delete_article(article_id: str, force: bool = False) -> bool:
    """Soft-delete article or remove permanently when force=True."""
    with CONN:
        exists = CONN.execute('SELECT 1 FROM articles WHERE id = ?', (article_id,)).fetchone()
        if not exists:
            return False
        if force:
            CONN.execute('DELETE FROM outline_sections_fts WHERE article_id = ?', (article_id,))
            CONN.execute('DELETE FROM articles_fts WHERE article_id = ?', (article_id,))
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


def update_article_doc_json(article_id: str, author_id: str, doc_json: Any) -> bool:
    """
    Updates `articles.article_doc_json` without touching blocks/history/updated_at.
    Intended for bootstrap: store TipTap doc_json derived from existing blocks.
    """
    if not article_id or not author_id:
        return False
    doc_json_str = None
    try:
        doc_json_str = json.dumps(doc_json)
    except Exception:
        doc_json_str = None
    with CONN:
        row = CONN.execute(
            'SELECT author_id, is_encrypted, encryption_salt, encryption_verifier FROM articles WHERE id = ?',
            (article_id,),
        ).fetchone()
        if not row:
            return False
        if str(row.get('author_id') or '') != str(author_id):
            return False
        encrypted_flag = bool(row.get('is_encrypted', 0)) or (
            bool(row.get('encryption_salt')) and bool(row.get('encryption_verifier'))
        )
        if encrypted_flag:
            # Never store plaintext docJson for encrypted articles.
            return False
        CONN.execute('UPDATE articles SET article_doc_json = ? WHERE id = ?', (doc_json_str, article_id))
    return True


def save_article_doc_json(
    *,
    article_id: str,
    author_id: str,
    doc_json: Any,
    create_version_if_stale_hours: int | None = None,
) -> dict[str, Any]:
    """
    Outline-first save: persist `articles.article_doc_json` and update derived indexes:
    - outline_sections_fts (FTS),
    - block_embeddings (semantic),
    - article_links (internal links).

    Also updates `articles.updated_at`, clears redo history, and appends per-section history entries
    (plain text before/after).
    """
    if not article_id or not author_id:
        raise ArticleNotFound('Article not found')
    if doc_json is None:
        raise InvalidOperation('doc_json is required')

    now = iso_now()
    now_dt = datetime.utcnow()

    # Concurrency guard: lock the article row and apply save to the latest doc_json.
    # Otherwise concurrent operations can read stale doc_json and later overwrite newer state.
    with CONN:
        article_row = CONN.execute(
            'SELECT id, author_id, title, updated_at, history, redo_history, is_encrypted, encryption_salt, encryption_verifier, article_doc_json '
            'FROM articles WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
            (article_id,),
        ).fetchone()
        if not article_row or str(article_row.get('author_id') or '') != str(author_id):
            raise ArticleNotFound('Article not found')

        encrypted_flag = bool(article_row.get('is_encrypted', 0)) or (
            bool(article_row.get('encryption_salt')) and bool(article_row.get('encryption_verifier'))
        )
        if encrypted_flag:
            # For encrypted articles we don't accept plaintext doc_json.
            raise InvalidOperation('Encrypted articles are not supported in outline save')

        history = deserialize_history(article_row.get('history'))
        history_entries_added: list[dict[str, Any]] = []

        # Auto-version "before first edit after N hours".
        if create_version_if_stale_hours:
            try:
                hours = int(create_version_if_stale_hours)
            except Exception:
                hours = 0
            if hours > 0:
                updated_at_raw = (article_row.get('updated_at') or '').strip()
                if updated_at_raw:
                    try:
                        updated_dt = datetime.fromisoformat(updated_at_raw)
                        age_seconds = (now_dt - updated_dt).total_seconds()
                        if age_seconds >= hours * 3600:
                            CONN.execute(
                                '''
                                INSERT INTO article_versions (id, article_id, author_id, created_at, reason, label, blocks_json, doc_json)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                ''',
                                (
                                    str(uuid.uuid4()),
                                    article_id,
                                    author_id,
                                    now,
                                    f'auto-{hours}h',
                                    None,
                                    json.dumps([]),
                                    article_row.get('article_doc_json'),
                                ),
                            )
                    except Exception:
                        pass

        # Diff sections based on plain text (heading+body).
        prev_map: dict[str, str] = {}
        prev_frags: dict[str, dict[str, Any]] = {}
        raw_prev = article_row.get('article_doc_json') or ''
        if raw_prev:
            try:
                prev_doc = json.loads(raw_prev) if isinstance(raw_prev, str) else raw_prev
                prev_map = build_outline_section_plain_text_map(prev_doc)
                prev_frags = build_outline_section_fragments_map(prev_doc)
            except Exception:
                prev_map = {}
                prev_frags = {}
        next_map = build_outline_section_plain_text_map(doc_json)
        next_frags = build_outline_section_fragments_map(doc_json)

        removed_ids = set(prev_map.keys()) - set(next_map.keys())
        changed_ids: set[str] = set()
        for sid, new_text in next_map.items():
            if prev_map.get(sid, '') != (new_text or ''):
                changed_ids.add(sid)

        def _push_history(section_id: str, before_plain: str, after_plain: str) -> None:
            if before_plain == after_plain:
                return
            before_frag = prev_frags.get(section_id) or {}
            after_frag = next_frags.get(section_id) or {}
            entry = {
                'id': str(uuid.uuid4()),
                'blockId': section_id,
                'before': before_plain,
                'after': after_plain,
                'beforeHeadingJson': before_frag.get('heading'),
                'beforeBodyJson': before_frag.get('body'),
                'afterHeadingJson': after_frag.get('heading'),
                'afterBodyJson': after_frag.get('body'),
                'timestamp': now,
            }
            history.append(entry)
            history_entries_added.append(entry)

        for sid in sorted(changed_ids):
            _push_history(sid, prev_map.get(sid, ''), next_map.get(sid, ''))

        # Persist article_doc_json and metadata.
        doc_json_str = json.dumps(doc_json, ensure_ascii=False)
        CONN.execute(
            'UPDATE articles SET updated_at = ?, history = ?, redo_history = ?, article_doc_json = ? WHERE id = ?',
            (now, serialize_history(history), '[]', doc_json_str, article_id),
        )

        # Rebuild internal links from doc_json (best-effort: never fail the save).
        try:
            _rebuild_article_links_for_article_id(article_id, doc_json=doc_json)
        except Exception as exc:  # noqa: BLE001
            logger.warning('Failed to rebuild article_links for save_article_doc_json: %r', exc)

        # Rebuild section FTS for the whole article (best-effort: never fail the save).
        try:
            CONN.execute('DELETE FROM outline_sections_fts WHERE article_id = ?', (article_id,))
            for sid, plain in (next_map or {}).items():
                text = (plain or '').strip()
                lemma = build_lemma(text)
                normalized = build_normalized_tokens(text)
                upsert_outline_section_search_index(sid, article_id, text, lemma, normalized, now)
        except Exception as exc:  # noqa: BLE001
            logger.warning('Failed to rebuild outline_sections_fts for save_article_doc_json: %r', exc)

    # Semantic embeddings updates after transaction.
    try:
        if removed_ids:
            delete_block_embeddings(list(removed_ids))
        if changed_ids:
            changed_plain = {sid: next_map.get(sid, '') for sid in changed_ids}
            upsert_embeddings_for_plain_texts(
                author_id=author_id,
                article_id=article_id,
                article_title=article_row.get('title') or '',
                block_texts=changed_plain,
                updated_at=now,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning('Failed to update semantic embeddings after save_article_doc_json: %r', exc)

    return {
        'status': 'ok',
        'articleId': article_id,
        'updatedAt': now,
        'changedBlockIds': sorted(changed_ids),
        'removedBlockIds': sorted(list(removed_ids)),
        'historyEntriesAdded': history_entries_added,
    }


def upsert_outline_section_content(
    *,
    article_id: str,
    author_id: str,
    section_id: str,
    heading_json: Any,
    body_json: Any,
    seq: int,
    op_id: str | None = None,
    create_version_if_stale_hours: int | None = None,
) -> dict[str, Any]:
    """
    Content-only upsert for a single outline section (heading+body).
    - Does not change structure.
    - Uses per-section seq to avoid stale updates.
    - Uses optional op_id for idempotency.
    """
    if not article_id or not author_id:
        raise ArticleNotFound('Article not found')
    sid = str(section_id or '').strip()
    if not sid:
        raise InvalidOperation('sectionId is required')
    if not _json_is_outline_heading(heading_json) or not _json_is_outline_body(body_json):
        raise InvalidOperation('Invalid section JSON')
    try:
        seq_num = int(seq)
    except Exception:
        seq_num = 0
    if seq_num <= 0:
        raise InvalidOperation('seq must be positive')

    now = iso_now()
    now_dt = datetime.utcnow()
    # Concurrency guard: lock the article row and patch against the latest doc_json.
    # This prevents lost updates when concurrent saves modify different parts of the doc.
    with CONN:
        article_row = CONN.execute(
            'SELECT id, author_id, title, updated_at, history, is_encrypted, encryption_salt, encryption_verifier, article_doc_json '
            'FROM articles WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
            (article_id,),
        ).fetchone()
        if not article_row or str(article_row.get('author_id') or '') != str(author_id):
            raise ArticleNotFound('Article not found')

        encrypted_flag = bool(article_row.get('is_encrypted', 0)) or (
            bool(article_row.get('encryption_salt')) and bool(article_row.get('encryption_verifier'))
        )
        if encrypted_flag:
            raise InvalidOperation('Encrypted articles are not supported')

        if op_id:
            newly = _try_mark_op_applied(op_id, article_id=article_id, op_type='section.upsertContent', section_id=sid)
            if not newly:
                return {'status': 'duplicate'}

        meta_row = CONN.execute(
            'SELECT last_seq, history_window_started_at, history_window_entry_id '
            'FROM outline_section_meta WHERE article_id = ? AND section_id = ? FOR UPDATE',
            (article_id, sid),
        ).fetchone()
        last_seq = int(meta_row['last_seq']) if meta_row and meta_row.get('last_seq') is not None else 0
        window_started_at_raw = (meta_row.get('history_window_started_at') or '').strip() if meta_row else ''
        window_entry_id = (meta_row.get('history_window_entry_id') or '').strip() if meta_row else ''
        window_started_dt: datetime | None = None
        if window_started_at_raw:
            try:
                window_started_dt = datetime.fromisoformat(window_started_at_raw)
            except Exception:
                window_started_dt = None
        if seq_num <= last_seq:
            return {'status': 'ignored', 'reason': 'stale', 'lastSeq': last_seq}

        # Auto-version best-effort: reuse existing full-save logic only for staleness condition.
        if create_version_if_stale_hours:
            try:
                hours = int(create_version_if_stale_hours)
            except Exception:
                hours = 0
            if hours > 0:
                updated_at_raw = (article_row.get('updated_at') or '').strip()
                if updated_at_raw:
                    try:
                        updated_dt = datetime.fromisoformat(updated_at_raw)
                        age_seconds = (datetime.utcnow() - updated_dt).total_seconds()
                        if age_seconds >= hours * 3600:
                            CONN.execute(
                                '''
                                INSERT INTO article_versions (id, article_id, author_id, created_at, reason, label, blocks_json, doc_json)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                ''',
                                (
                                    str(uuid.uuid4()),
                                    article_id,
                                    author_id,
                                    now,
                                    f'auto-{hours}h',
                                    None,
                                    json.dumps([]),
                                    article_row.get('article_doc_json'),
                                ),
                            )
                    except Exception:
                        pass

        raw_prev = article_row.get('article_doc_json') or ''
        prev_doc: Any = None
        if raw_prev:
            try:
                prev_doc = json.loads(raw_prev) if isinstance(raw_prev, str) else raw_prev
            except Exception:
                prev_doc = None
        if not isinstance(prev_doc, dict):
            prev_doc = {'type': 'doc', 'content': []}

        before_plain = build_outline_section_plain_text(prev_doc, sid)
        before_frags = build_outline_section_fragments_map(prev_doc).get(sid) or {}

        # Patch the section in-place (keep children intact).
        doc_json = prev_doc
        sec = _find_outline_section_by_id(doc_json, sid)
        if sec is None:
            # Important: do NOT resurrect deleted sections.
            #
            # We use `outline_section_meta` to track per-section seq. If a section has meta, it existed
            # before (we've applied at least one content update). If it's now missing from docJson,
            # it was deleted by a delete op. Late/duplicate upserts (e.g. delayed spellcheck/autosave)
            # must be ignored instead of re-creating the section at the end of the article.
            if meta_row:
                return {'status': 'ignored', 'reason': 'missing', 'lastSeq': last_seq}

            # New section: allow creating it from the first content upsert.
            sec = _ensure_outline_section_node(sid, heading=heading_json, body=body_json)
            if not isinstance(doc_json.get('content'), list):
                doc_json['content'] = []
            # Inbox should behave like "newest first": when a section is missing from structure,
            # create it at the top-level root and put it first.
            # NOTE: the public id is "inbox", but in DB it is "inbox-<user_id>".
            if str(article_id).startswith('inbox-'):
                doc_json['content'].insert(0, sec)
            else:
                doc_json['content'].append(sec)
        else:
            content = sec.get('content') or []
            if not isinstance(content, list) or len(content) < 3:
                # keep whatever children we can find
                children = None
                for c in content if isinstance(content, list) else []:
                    if isinstance(c, dict) and c.get('type') == 'outlineChildren':
                        children = c
                        break
                sec['content'] = [heading_json, body_json, children or {'type': 'outlineChildren', 'content': []}]
            else:
                # Replace heading/body nodes by type.
                h_idx = None
                b_idx = None
                for i, c in enumerate(content):
                    if isinstance(c, dict) and c.get('type') == 'outlineHeading' and h_idx is None:
                        h_idx = i
                    elif isinstance(c, dict) and c.get('type') == 'outlineBody' and b_idx is None:
                        b_idx = i
                if h_idx is None:
                    content.insert(0, heading_json)
                else:
                    content[h_idx] = heading_json
                if b_idx is None:
                    insert_at = 1 if h_idx in (None, 0) else h_idx + 1
                    content.insert(insert_at, body_json)
                else:
                    content[b_idx] = body_json
                # Ensure children container exists at the end.
                if not any(isinstance(c, dict) and c.get('type') == 'outlineChildren' for c in content):
                    content.append({'type': 'outlineChildren', 'content': []})
                sec['content'] = content

        after_plain = build_outline_section_plain_text(doc_json, sid)
        after_frags = build_outline_section_fragments_map(doc_json).get(sid) or {}

        history = deserialize_history(article_row.get('history'))
        history_entries_added: list[dict[str, Any]] = []

        history_window_seconds = 3600
        should_consider_history = before_plain != after_plain
        should_update_window = (
            bool(window_entry_id)
            and window_started_dt is not None
            and (now_dt - window_started_dt).total_seconds() < history_window_seconds
        )
        history_window_entry_updated = False
        history_window_entry_id_to_set: str | None = None
        history_window_started_at_to_set: str | None = None

        if should_consider_history:
            if should_update_window:
                # Sliding window: update the existing history entry (keep "before" from the first change in the window).
                try:
                    for e in history:
                        if (
                            isinstance(e, dict)
                            and str(e.get('id') or '') == window_entry_id
                            and str(e.get('blockId') or '') == sid
                        ):
                            e['after'] = after_plain
                            e['afterHeadingJson'] = after_frags.get('heading')
                            e['afterBodyJson'] = after_frags.get('body')
                            # Keep e['timestamp'] as window start; optionally track last update time.
                            e['updatedAt'] = now
                            history_window_entry_updated = True
                            break
                except Exception:
                    history_window_entry_updated = False

            if not history_window_entry_updated:
                entry_id = str(uuid.uuid4())
                entry = {
                    'id': entry_id,
                    'blockId': sid,
                    'before': before_plain,
                    'after': after_plain,
                    'beforeHeadingJson': before_frags.get('heading'),
                    'beforeBodyJson': before_frags.get('body'),
                    'afterHeadingJson': after_frags.get('heading'),
                    'afterBodyJson': after_frags.get('body'),
                    'timestamp': now,
                }
                history.append(entry)
                history_entries_added.append(entry)
                history_window_entry_id_to_set = entry_id
                history_window_started_at_to_set = now

        doc_json_str = json.dumps(doc_json, ensure_ascii=False)
        CONN.execute(
            'UPDATE articles SET updated_at = ?, history = ?, redo_history = ?, article_doc_json = ? WHERE id = ?',
            (now, serialize_history(history), '[]', doc_json_str, article_id),
        )
        if meta_row:
            if history_window_entry_id_to_set is not None:
                CONN.execute(
                    'UPDATE outline_section_meta SET last_seq = ?, history_window_started_at = ?, history_window_entry_id = ?, updated_at = ? WHERE article_id = ? AND section_id = ?',
                    (seq_num, history_window_started_at_to_set, history_window_entry_id_to_set, now, article_id, sid),
                )
            else:
                CONN.execute(
                    'UPDATE outline_section_meta SET last_seq = ?, updated_at = ? WHERE article_id = ? AND section_id = ?',
                    (seq_num, now, article_id, sid),
                )
        else:
            CONN.execute(
                'INSERT INTO outline_section_meta (article_id, section_id, last_seq, history_window_started_at, history_window_entry_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                (
                    article_id,
                    sid,
                    seq_num,
                    history_window_started_at_to_set,
                    history_window_entry_id_to_set,
                    now,
                    now,
                ),
            )
        # Update FTS for this section only.
        plain = (after_plain or '').strip()
        lemma = build_lemma(plain)
        normalized = build_normalized_tokens(plain)
        upsert_outline_section_search_index(sid, article_id, plain, lemma, normalized, now)

    try:
        upsert_embeddings_for_plain_texts(
            author_id=author_id,
            article_id=article_id,
            article_title=article_row.get('title') or '',
            block_texts={sid: after_plain},
            updated_at=now,
        )
    except Exception:
        pass

    return {
        'status': 'ok',
        'articleId': article_id,
        'updatedAt': now,
        'changedBlockIds': [sid],
        'removedBlockIds': [],
        'historyEntriesAdded': history_entries_added,
    }


def apply_outline_structure_snapshot(
    *,
    article_id: str,
    author_id: str,
    nodes: list[dict[str, Any]],
    op_id: str | None = None,
    base_rev: int | None = None,
) -> dict[str, Any]:
    if not article_id or not author_id:
        raise ArticleNotFound('Article not found')
    if nodes is None or not isinstance(nodes, list):
        raise InvalidOperation('nodes must be a list')

    oid = str(op_id or '').strip() or None

    # Concurrency guard: lock the article row and apply snapshot to the latest doc_json.
    # Otherwise an older operation can read stale doc_json, wait on a row lock, and later overwrite newer state.
    with CONN:
        article_row = CONN.execute(
            'SELECT id, author_id, updated_at, outline_structure_rev, is_encrypted, encryption_salt, encryption_verifier, article_doc_json '
            'FROM articles WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
            (article_id,),
        ).fetchone()
        if not article_row or str(article_row.get('author_id') or '') != str(author_id):
            raise ArticleNotFound('Article not found')
        current_rev = int(article_row.get('outline_structure_rev') or 0)
        if _should_log_structure_snapshot(article_id):
            logger.error(
                '[structure/snapshot][enter] articleId=%s opId=%s baseRev=%s currentRev=%s updatedAt=%s nodesCount=%s',
                article_id,
                oid,
                base_rev,
                current_rev,
                str(article_row.get('updated_at') or ''),
                len(nodes or []),
            )
        if oid:
            dup = CONN.execute('SELECT 1 AS ok FROM applied_ops WHERE op_id = ?', (oid,)).fetchone()
            if dup:
                if _should_log_structure_snapshot(article_id):
                    logger.error(
                        '[structure/snapshot][duplicate] articleId=%s opId=%s currentRev=%s updatedAt=%s',
                        article_id,
                        oid,
                        current_rev,
                        str(article_row.get('updated_at') or ''),
                    )
                return {
                    'status': 'duplicate',
                    'articleId': article_id,
                    'updatedAt': article_row.get('updated_at') or iso_now(),
                }
        if base_rev is not None:
            try:
                base_rev_num = int(base_rev)
            except Exception:
                base_rev_num = None
            if base_rev_num is None:
                raise InvalidOperation('baseStructureRev must be integer')
            # Guard against stale clients only.
            # If client is behind (base_rev < current_rev) — ignore to prevent overwriting newer structure.
            # If client is ahead (base_rev > current_rev) — allow applying snapshot as a repair:
            # this can happen after cache/db restores or other incidents where server structure_rev lags behind.
            if base_rev_num < current_rev:
                if _should_log_structure_snapshot(article_id):
                    logger.error(
                        '[structure/snapshot][ignored-stale] articleId=%s opId=%s baseRev=%s currentRev=%s updatedAt=%s',
                        article_id,
                        oid,
                        base_rev_num,
                        current_rev,
                        str(article_row.get('updated_at') or ''),
                    )
                return {
                    'status': 'ignored',
                    'reason': 'stale',
                    'articleId': article_id,
                    'updatedAt': article_row.get('updated_at') or iso_now(),
                    'currentStructureRev': current_rev,
                }
        encrypted_flag = bool(article_row.get('is_encrypted', 0)) or (
            bool(article_row.get('encryption_salt')) and bool(article_row.get('encryption_verifier'))
        )
        if encrypted_flag:
            raise InvalidOperation('Encrypted articles are not supported')

        raw_prev = article_row.get('article_doc_json') or ''
        prev_doc: Any = None
        if raw_prev:
            try:
                prev_doc = json.loads(raw_prev) if isinstance(raw_prev, str) else raw_prev
            except Exception:
                prev_doc = None
        if not isinstance(prev_doc, dict):
            prev_doc = {'type': 'doc', 'content': []}

        doc_json = _apply_outline_structure_snapshot(prev_doc, nodes)
        doc_json_str = json.dumps(doc_json, ensure_ascii=False)
        now = iso_now()

        if oid:
            # Mark op as applied ONLY if we are going to actually apply it (i.e. base_rev is not stale).
            try:
                CONN.execute(
                    'INSERT INTO applied_ops (op_id, article_id, section_id, op_type, created_at) VALUES (?, ?, ?, ?, ?)',
                    (oid, article_id, None, 'structure.snapshot', now),
                )
            except Exception:
                return {
                    'status': 'duplicate',
                    'articleId': article_id,
                    'updatedAt': article_row.get('updated_at') or iso_now(),
                }

        CONN.execute(
            'UPDATE articles SET updated_at = ?, redo_history = ?, article_doc_json = ?, outline_structure_rev = outline_structure_rev + 1 WHERE id = ?',
            (now, '[]', doc_json_str, article_id),
        )
        if _should_log_structure_snapshot(article_id):
            after_row = CONN.execute(
                'SELECT updated_at, outline_structure_rev FROM articles WHERE id = ?',
                (article_id,),
            ).fetchone()
            logger.error(
                '[structure/snapshot][applied] articleId=%s opId=%s updatedAt_before=%s updatedAt_after=%s rev_before=%s rev_after=%s',
                article_id,
                oid,
                str(article_row.get('updated_at') or ''),
                str((after_row or {}).get('updated_at') or ''),
                current_rev,
                int((after_row or {}).get('outline_structure_rev') or 0),
            )
        # NOTE: We intentionally DO NOT rebuild `article_links` here.
        # `structure/snapshot` is a structure-only operation (parent/position/collapsed) and does not change
        # section contents, so the set of internal links is unchanged. Rebuilding derived data here would be
        # redundant work and increases the risk of unnecessary failures.

    out = {'status': 'ok', 'articleId': article_id, 'updatedAt': now, 'newStructureRev': current_rev + 1}
    if _should_log_structure_snapshot(article_id):
        logger.error(
            '[structure/snapshot][response] articleId=%s opId=%s status=%s updatedAt=%s newStructureRev=%s',
            article_id,
            oid,
            out.get('status'),
            out.get('updatedAt'),
            out.get('newStructureRev'),
        )
    return out


def delete_outline_sections(
    *,
    article_id: str,
    author_id: str,
    section_ids: list[str],
    op_id: str | None = None,
) -> dict[str, Any]:
    """
    Delete one or more outline sections by id (structure-only: removes nodes from docJson).
    This is cheaper than full doc-json/save and avoids rebuilding unrelated derived data.
    """
    if not article_id or not author_id:
        raise ArticleNotFound('Article not found')
    ids = [str(x or '').strip() for x in (section_ids or []) if str(x or '').strip()]
    if not ids:
        raise InvalidOperation('sectionIds is required')

    if op_id:
        newly = _try_mark_op_applied(op_id, article_id=article_id, op_type='sections.delete', section_id=None)
        if not newly:
            return {'status': 'duplicate'}

    with CONN:
        article_row = CONN.execute(
            'SELECT id, author_id, is_encrypted, encryption_salt, encryption_verifier, article_doc_json '
            'FROM articles WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
            (article_id,),
        ).fetchone()
        if not article_row or str(article_row.get('author_id') or '') != str(author_id):
            raise ArticleNotFound('Article not found')
        encrypted_flag = bool(article_row.get('is_encrypted', 0)) or (
            bool(article_row.get('encryption_salt')) and bool(article_row.get('encryption_verifier'))
        )
        if encrypted_flag:
            raise InvalidOperation('Encrypted articles are not supported')

        raw_prev = article_row.get('article_doc_json') or ''
        prev_doc: Any = None
        if raw_prev:
            try:
                prev_doc = json.loads(raw_prev) if isinstance(raw_prev, str) else raw_prev
            except Exception:
                prev_doc = None
        if not isinstance(prev_doc, dict):
            prev_doc = {'type': 'doc', 'content': []}

        before_ids = {str((sec.get('attrs') or {}).get('id') or '').strip() for sec in _walk_outline_sections(prev_doc)}

        changed = False
        for sid in ids:
            try:
                if _delete_outline_section_by_id(prev_doc, sid):
                    changed = True
            except Exception:
                continue

        after_ids = {str((sec.get('attrs') or {}).get('id') or '').strip() for sec in _walk_outline_sections(prev_doc)}
        removed_ids = sorted([sid for sid in before_ids if sid and sid not in after_ids])

        # If nothing changed, keep the server state as-is (idempotent).
        if not changed and not removed_ids:
            return {'status': 'ok', 'articleId': article_id, 'updatedAt': article_row.get('updated_at') or iso_now(), 'removedBlockIds': []}

        doc_json_str = json.dumps(prev_doc, ensure_ascii=False)
        now = iso_now()
        CONN.execute(
            'UPDATE articles SET updated_at = ?, redo_history = ?, article_doc_json = ? WHERE id = ?',
            (now, '[]', doc_json_str, article_id),
        )

        # Best-effort derived updates limited to what depends on structure.
        try:
            _rebuild_article_links_for_article_id(article_id, doc_json=prev_doc)
        except Exception:
            pass
        try:
            if removed_ids:
                delete_outline_sections_search_index(removed_ids)
        except Exception:
            pass
        try:
            if removed_ids:
                delete_block_embeddings(list(removed_ids))
        except Exception:
            pass

    return {'status': 'ok', 'articleId': article_id, 'updatedAt': now, 'removedBlockIds': removed_ids}


def sync_outline_compact(
    *,
    article_id: str,
    author_id: str,
    deletes: list[dict[str, Any]] | None = None,
    upserts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Batch sync for outline:
    - deletes: [{ opId, sectionIds }]
    - upserts: [{ opId, sectionId, headingJson, bodyJson, seq }]

    The server applies deletes first, then upserts (content-only). Structure snapshots are handled
    by /structure/snapshot separately.
    """
    latest_updated_at: str | None = None
    delete_acks: list[dict[str, Any]] = []
    upsert_acks: list[dict[str, Any]] = []

    def _pick_latest(a: str | None, b: str | None) -> str | None:
        if not a:
            return b
        if not b:
            return a
        return b if str(b) > str(a) else a

    for item in deletes or []:
        op_id = str((item or {}).get('opId') or '').strip()
        section_ids = (item or {}).get('sectionIds') or []
        if not op_id:
            raise InvalidOperation('delete.opId is required')
        if not isinstance(section_ids, list):
            raise InvalidOperation('delete.sectionIds must be list')
        out = delete_outline_sections(
            article_id=article_id,
            author_id=author_id,
            section_ids=[str(x or '').strip() for x in section_ids],
            op_id=op_id,
        )
        latest_updated_at = _pick_latest(latest_updated_at, str(out.get('updatedAt') or '').strip() or None)
        if out.get('status') == 'duplicate':
            delete_acks.append({'opId': op_id, 'result': 'duplicate', 'removedBlockIds': []})
        else:
            delete_acks.append(
                {
                    'opId': op_id,
                    'result': 'ok',
                    'removedBlockIds': out.get('removedBlockIds') or [],
                }
            )

    for item in upserts or []:
        op_id = str((item or {}).get('opId') or '').strip()
        section_id = str((item or {}).get('sectionId') or '').strip()
        heading_json = (item or {}).get('headingJson')
        body_json = (item or {}).get('bodyJson')
        seq = (item or {}).get('seq')
        if not op_id:
            raise InvalidOperation('upsert.opId is required')
        if not section_id:
            raise InvalidOperation('upsert.sectionId is required')
        try:
            seq_num = int(seq) if seq is not None else 0
        except Exception:
            raise InvalidOperation('upsert.seq must be integer') from None
        out = upsert_outline_section_content(
            article_id=article_id,
            author_id=author_id,
            section_id=section_id,
            heading_json=heading_json,
            body_json=body_json,
            seq=seq_num,
            op_id=op_id,
            create_version_if_stale_hours=12,
        )
        latest_updated_at = _pick_latest(latest_updated_at, str(out.get('updatedAt') or '').strip() or None)
        status = str(out.get('status') or '')
        if status == 'duplicate':
            upsert_acks.append({'opId': op_id, 'sectionId': section_id, 'result': 'duplicate'})
        elif status == 'ignored' and str(out.get('reason') or '') == 'stale':
            upsert_acks.append(
                {
                    'opId': op_id,
                    'sectionId': section_id,
                    'result': 'conflict',
                    'reason': 'stale',
                    'lastSeq': out.get('lastSeq'),
                }
            )
        elif status == 'ok':
            upsert_acks.append({'opId': op_id, 'sectionId': section_id, 'result': 'ok'})
        else:
            upsert_acks.append(
                {
                    'opId': op_id,
                    'sectionId': section_id,
                    'result': 'ignored',
                    'reason': out.get('reason') or status or 'ignored',
                }
            )

    return {
        'status': 'ok',
        'articleId': article_id,
        'updatedAt': latest_updated_at or iso_now(),
        'deleteAcks': delete_acks,
        'upsertAcks': upsert_acks,
    }


def get_block_text_history(article_id: str, author_id: str, block_id: str, limit: int = 100) -> dict[str, Any]:
    if not article_id or not author_id or not block_id:
        raise ArticleNotFound('Article not found')
    row = CONN.execute(
        '''
        SELECT author_id, history, redo_history, is_encrypted, encryption_salt, encryption_verifier
        FROM articles
        WHERE id = ? AND deleted_at IS NULL
        ''',
        (article_id,),
    ).fetchone()
    if not row or str(row.get('author_id') or '') != str(author_id):
        raise ArticleNotFound('Article not found')
    encrypted_flag = bool(row.get('is_encrypted', 0)) or (
        bool(row.get('encryption_salt')) and bool(row.get('encryption_verifier'))
    )
    if encrypted_flag:
        raise InvalidOperation('Block history is not available for encrypted articles')
    history = deserialize_history(row.get('history'))
    entries = [h for h in (history or []) if str(h.get('blockId') or '') == str(block_id)]
    if limit and limit > 0:
        entries = entries[-int(limit) :]
    # newest first
    entries = list(reversed(entries))
    return {'entries': entries}

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
    article.setdefault('blockTrash', [])
    return article


def _article_search_fields(title: str = '') -> Tuple[str, str, str]:
    plain_title = strip_html(title or '')
    lemma = build_lemma(plain_title)
    normalized = build_normalized_tokens(plain_title)
    return plain_title, lemma, normalized


def upsert_article_search_index(article_id: str, title: str, *, use_transaction: bool = True) -> None:
    plain_title, lemma, normalized = _article_search_fields(title)
    def _execute():
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
                SET title = ?, updated_at = ?, history = ?, redo_history = ?, block_trash = ?, public_slug = ?
                WHERE id = ?
                ''',
                (
                    title_value,
                    now,
                    serialize_history(normalized['history']),
                    serialize_history(normalized['redoHistory']),
                    serialize_history(normalized['blockTrash']),
                    public_slug,
                    normalized['id'],
                ),
            )
        else:
            CONN.execute(
                '''
                INSERT INTO articles (id, title, created_at, updated_at, history, redo_history, block_trash, author_id, public_slug)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    normalized['id'],
                    title_value,
                    now,
                    now,
                    serialize_history(normalized['history']),
                    serialize_history(normalized['redoHistory']),
                    serialize_history(normalized['blockTrash']),
                    author_id,
                    public_slug,
                ),
            )
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
            now = iso_now()
            with CONN:
                CONN.execute(
                    'UPDATE articles SET deleted_at = NULL, updated_at = ? WHERE id = ? AND author_id = ?',
                    (now, inbox_id, author_id),
                )
            existing = get_article(inbox_id, author_id=author_id, include_deleted=True) or existing
        return existing

    now = iso_now()
    # Outline-first: inbox is stored as docJson and never rebuilt from legacy blocks.
    section_id = str(uuid.uuid4())
    doc_json = {'type': 'doc', 'content': [_ensure_outline_section_node(section_id)]}
    with CONN:
        CONN.execute(
            '''
            INSERT INTO articles (id, title, created_at, updated_at, history, redo_history, block_trash, author_id, public_slug, article_doc_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                inbox_id,
                'Быстрые заметки',
                now,
                now,
                serialize_history([]),
                serialize_history([]),
                serialize_history([]),
                author_id,
                None,
                json.dumps(doc_json, ensure_ascii=False),
            ),
        )
    # Build derived indexes/links/embeddings. (No history diff because docJson already stored.)
    try:
        save_article_doc_json(article_id=inbox_id, author_id=author_id, doc_json=doc_json)
    except Exception:
        pass
    return get_article(inbox_id, author_id=author_id, include_deleted=True) or {
        'id': inbox_id,
        'title': 'Быстрые заметки',
        'createdAt': now,
        'updatedAt': now,
        'deletedAt': None,
        'parentId': None,
        'position': 0,
        'authorId': author_id,
        'publicSlug': None,
        'history': [],
        'redoHistory': [],
        'blockTrash': [],
        'encrypted': False,
        'docJson': doc_json,
        'blocks': [],
    }


def create_article(title: Optional[str] = None, author_id: Optional[str] = None, article_id: Optional[str] = None) -> Dict[str, Any]:
    now = iso_now()
    new_id = str(article_id or uuid.uuid4())
    section_id = str(uuid.uuid4())
    doc_json = {'type': 'doc', 'content': [_ensure_outline_section_node(section_id)]}
    created_new = False
    with CONN:
        exists = CONN.execute('SELECT author_id FROM articles WHERE id = ?', (new_id,)).fetchone()
        if exists:
            if author_id is not None and str(exists.get('author_id') or '') != str(author_id):
                raise InvalidOperation('Cannot create/update чужую статью')
            CONN.execute(
                'UPDATE articles SET title = ?, updated_at = ? WHERE id = ?',
                (title or 'Новая статья', now, new_id),
            )
        else:
            created_new = True
            CONN.execute(
                '''
                INSERT INTO articles (id, title, created_at, updated_at, history, redo_history, block_trash, author_id, public_slug, article_doc_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    new_id,
                    title or 'Новая статья',
                    now,
                    now,
                    serialize_history([]),
                    serialize_history([]),
                    serialize_history([]),
                    author_id,
                    None,
                    json.dumps(doc_json, ensure_ascii=False),
                ),
            )
    if created_new:
        try:
            save_article_doc_json(article_id=new_id, author_id=author_id or '', doc_json=doc_json)
        except Exception:
            pass
    return get_article(new_id, author_id=author_id, include_deleted=True) or {
        'id': new_id,
        'title': title or 'Новая статья',
        'createdAt': now,
        'updatedAt': now,
        'deletedAt': None,
        'parentId': None,
        'position': 0,
        'authorId': author_id,
        'publicSlug': None,
        'history': [],
        'redoHistory': [],
        'blockTrash': [],
        'encrypted': False,
        'docJson': doc_json,
        'blocks': [],
    }


def upsert_article_doc_json_snapshot(
    *,
    article_id: str,
    author_id: str,
    title: str,
    doc_json: Any,
    created_at: str | None = None,
    updated_at: str | None = None,
    public_slug: str | None = None,
    reset_history: bool = False,
) -> None:
    """
    Upsert article row with `article_doc_json` set to `doc_json`.

    Intended for imports/bootstrap flows:
    - we store the final docJson first,
    - then call `save_article_doc_json` with the same docJson to (re)build derived indexes
      without producing a large history diff.
    """
    if not article_id or not author_id:
        raise ArticleNotFound('Article not found')
    now = updated_at or iso_now()
    created = created_at or now
    try:
        doc_json_str = json.dumps(doc_json, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        raise InvalidOperation('Invalid doc_json') from exc

    with CONN:
        row = CONN.execute('SELECT author_id FROM articles WHERE id = ?', (article_id,)).fetchone()
        if row:
            if str(row.get('author_id') or '') != str(author_id):
                raise InvalidOperation('Cannot overwrite чужую статью')
            if reset_history:
                CONN.execute(
                    '''
                    UPDATE articles
                    SET title = ?, updated_at = ?, deleted_at = NULL, history = ?, redo_history = ?, block_trash = ?, public_slug = ?, article_doc_json = ?
                    WHERE id = ?
                    ''',
                    (
                        title,
                        now,
                        serialize_history([]),
                        serialize_history([]),
                        serialize_history([]),
                        public_slug,
                        doc_json_str,
                        article_id,
                    ),
                )
            else:
                CONN.execute(
                    '''
                    UPDATE articles
                    SET title = ?, updated_at = ?, deleted_at = NULL, public_slug = ?, article_doc_json = ?
                    WHERE id = ?
                    ''',
                    (title, now, public_slug, doc_json_str, article_id),
                )
        else:
            CONN.execute(
                '''
                INSERT INTO articles (id, title, created_at, updated_at, history, redo_history, block_trash, author_id, public_slug, article_doc_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    article_id,
                    title,
                    created,
                    now,
                    serialize_history([]),
                    serialize_history([]),
                    serialize_history([]),
                    author_id,
                    public_slug,
                    doc_json_str,
                ),
            )

    upsert_article_search_index(article_id, title)
    # Derived indexes/links/embeddings: best-effort.
    try:
        save_article_doc_json(article_id=article_id, author_id=author_id, doc_json=doc_json)
    except Exception:
        pass


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
    Удаляет пользователя, все его статьи и связанные данные (FTS-индексы, вложения в БД).
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


def _update_article_links_for_block(
    article_id: str,
    block_id: str,
    old_text: str,
    new_text: str,
) -> None:
    """
    Инкрементально обновляет article_links для одного блока:
    - вычитает ссылки, которые были в старом тексте, но исчезли;
    - добавляет ссылки, которые появились в новом тексте.
    """
    old_ids = _extract_article_ids_from_html(old_text)
    new_ids = _extract_article_ids_from_html(new_text)

    if not old_ids and not new_ids:
        return

    to_delete = old_ids - new_ids
    to_add = new_ids - old_ids

    if to_delete:
        placeholders = ','.join('?' for _ in to_delete)
        CONN.execute(
            f'''
            DELETE FROM article_links
            WHERE from_id = ? AND block_id = ? AND to_id IN ({placeholders})
            ''',
            (article_id, block_id, *to_delete),
        )

    if to_add:
        values = [
            (article_id, block_id, tid, 'internal')
            for tid in to_add
            if tid and tid != article_id
        ]
        if values:
            CONN.executemany(
                '''
                INSERT INTO article_links (from_id, block_id, to_id, kind)
                VALUES (?, ?, ?, ?)
                ''',
                values,
            )


def update_block(article_id: str, block_id: str, attrs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    # Оптимизированный вариант, который не перезаписывает всю статью
    # 1) Быстрый путь: меняется только collapsed-флаг — не трогаем текст/историю/FTS.
    if 'collapsed' in attrs and 'text' not in attrs:
        now = iso_now()
        collapsed_val = bool(attrs['collapsed'])
        with CONN:
            updated = CONN.execute(
                'UPDATE blocks SET collapsed = ?, updated_at = ? WHERE id = ? AND article_id = ?',
                (int(collapsed_val), now, block_id, article_id),
            )
            # updated.rowcount может быть недоступен в обёртке, поэтому перепроверяем наличие блока отдельно.
            row = CONN.execute(
                'SELECT 1 FROM blocks WHERE id = ? AND article_id = ?',
                (block_id, article_id),
            ).fetchone()
            if not row:
                raise BlockNotFound(f'Блок с ID {block_id} не найден.')
            CONN.execute(
                'UPDATE articles SET updated_at = ? WHERE id = ?',
                (now, article_id),
            )
        return {'id': block_id, 'collapsed': collapsed_val, 'updatedAt': now}

    if 'text' in attrs or 'collapsed' in attrs:
        now = iso_now()
        history_entry = None
        response: Dict[str, Any] = {'id': block_id}
        semantic_payload: dict[str, Any] | None = None

        with CONN:
            # Получаем данные блока один раз, чтобы проверить его существование
            # и получить необходимые поля (text и rowid)
            block_data = CONN.execute(
                'SELECT text, block_rowid FROM blocks WHERE id = ?',
                (block_id,),
            ).fetchone()
            if not block_data:
                raise BlockNotFound(f'Блок с ID {block_id} не найден.')
            block_rowid = block_data['block_rowid']

            if 'text' in attrs:
                previous_text = block_data['text']
                new_text = sanitize_html(attrs['text'] or '')
                new_text = _maybe_convert_pipe_table_html(new_text)

                # Автоматически разворачиваем wikilinks [[...]] в ссылки на статьи пользователя.
                article_row = CONN.execute(
                    'SELECT history, redo_history, author_id, title FROM articles WHERE id = ?',
                    (article_id,),
                ).fetchone()
                if not article_row:
                    raise ArticleNotFound(f'Статья с ID {article_id} не найдена при обновлении блока')
                author_id = article_row['author_id']
                if author_id:
                    new_text = _expand_wikilinks(new_text, author_id)

                article_history = deserialize_history(article_row['history'])

                history_entry = push_text_history_entry(
                    {'history': article_history, 'redoHistory': []},
                    block_id,
                    previous_text,
                    new_text,
                )

                plain_text = strip_html(new_text)
                lemma = build_lemma(plain_text)
                normalized_text = build_normalized_tokens(plain_text)

                CONN.execute(
                    'UPDATE blocks SET text = ?, normalized_text = ?, updated_at = ? WHERE id = ?',
                    (new_text, normalized_text, now, block_id),
                )
                upsert_block_search_index(block_rowid, article_id, new_text, lemma, normalized_text)
                CONN.execute(
                    'UPDATE articles SET updated_at = ?, history = ?, redo_history = ? WHERE id = ?',
                    (now, serialize_history(article_history), '[]', article_id),
                )
                response['text'] = new_text
                # После изменения текста блока инкрементально обновляем связи.
                _update_article_links_for_block(article_id, block_id, previous_text, new_text)
                semantic_payload = {
                    'authorId': author_id,
                    'articleTitle': article_row.get('title') or '',
                    'text': new_text,
                }

            if 'collapsed' in attrs:
                collapsed_val = bool(attrs['collapsed'])
                CONN.execute(
                    'UPDATE blocks SET collapsed = ?, updated_at = ? WHERE id = ?',
                    (int(collapsed_val), now, block_id),
                )
                CONN.execute(
                    'UPDATE articles SET updated_at = ? WHERE id = ?',
                    (now, article_id),
                )
                response['collapsed'] = collapsed_val

        if history_entry:
            response['historyEntryId'] = history_entry['id']
        # Семантический индекс обновляем после основной транзакции, чтобы не держать блокировки
        # на время вычисления embedding (может быть медленно).
        if semantic_payload and semantic_payload.get('authorId'):
            try:
                upsert_block_embedding(
                    author_id=semantic_payload['authorId'],
                    article_id=article_id,
                    article_title=semantic_payload.get('articleTitle') or '',
                    block_id=block_id,
                    block_html=semantic_payload.get('text') or '',
                    updated_at=now,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning('Failed to update semantic embedding for block %s: %r', block_id, exc)
                try:
                    notify_user(
                        semantic_payload['authorId'],
                        f'Семантический индекс: не удалось обновить embedding блока {block_id}: {exc!r}',
                        key='semantic-embed-update',
                    )
                except Exception:
                    # Не даём уведомлениям ломать основной CRUD.
                    pass
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


def replace_article_blocks_tree(
    *,
    article_id: str,
    author_id: str,
    blocks: list[dict[str, Any]],
    create_version_if_stale_hours: int | None = None,
    doc_json: dict[str, Any] | list[Any] | None = None,
) -> dict[str, Any]:
    """
    Атомарно заменяет дерево блоков статьи (parent/position/text/collapsed) на присланное клиентом.

    Используется для outline-редактора (один документ на статью), который сохраняет всю структуру
    целиком, а не по одному блоку.

    Важные свойства:
    - сохраняет created_at/updated_at для блоков, где текст/коллапс не изменились;
    - обновляет FTS и article_links;
    - добавляет записи истории (articles.history) только для блоков с изменившимся text.
    """
    if not article_id:
        raise ArticleNotFound('Article not found')
    if not author_id:
        raise InvalidOperation('author_id required')
    if not isinstance(blocks, list):
        raise InvalidOperation('blocks must be a list')

    def _validate_and_collect(
        nodes: list[dict[str, Any]],
        *,
        depth: int,
        seen: set[str],
    ) -> None:
        if depth > 64:
            # Технический ограничитель против циклов/аномалий в payload.
            raise InvalidOperation('Too deep block tree')
        for blk in nodes:
            if not isinstance(blk, dict):
                raise InvalidOperation('Invalid block payload')
            bid = blk.get('id')
            if not isinstance(bid, str) or not bid:
                raise InvalidOperation('Block id is required')
            if bid in seen:
                raise InvalidOperation(f'Duplicate block id: {bid}')
            seen.add(bid)
            text = blk.get('text', '')
            if text is None:
                text = ''
            if not isinstance(text, str):
                raise InvalidOperation('Block text must be string')
            collapsed = blk.get('collapsed', False)
            if collapsed is None:
                collapsed = False
            if not isinstance(collapsed, bool):
                raise InvalidOperation('Block collapsed must be boolean')
            children = blk.get('children') or []
            if children and not isinstance(children, list):
                raise InvalidOperation('Block children must be list')
            _validate_and_collect(children, depth=depth + 1, seen=seen)

    seen_ids: set[str] = set()
    _validate_and_collect(blocks, depth=0, seen=seen_ids)

    # Снимок текущих блоков, чтобы:
    # - сохранить created_at/updated_at для неизменённых блоков;
    # - построить историю изменений текста;
    # - решить, какие embeddings нужно обновить.
    existing_rows = CONN.execute(
        '''
        SELECT id, text, collapsed, created_at, updated_at
        FROM blocks
        WHERE article_id = ?
        ''',
        (article_id,),
    ).fetchall()
    existing_map: dict[str, dict[str, Any]] = {}
    for row in existing_rows or []:
        bid = row.get('id')
        if bid:
            existing_map[str(bid)] = {
                'text': row.get('text') or '',
                'collapsed': bool(row.get('collapsed')),
                'createdAt': row.get('created_at') or '',
                'updatedAt': row.get('updated_at') or '',
            }

    article_row = CONN.execute(
        'SELECT history, redo_history, author_id, title, updated_at, article_doc_json FROM articles WHERE id = ?',
        (article_id,),
    ).fetchone()
    if not article_row:
        raise ArticleNotFound('Article not found')
    if str(article_row.get('author_id') or '') != str(author_id):
        raise ArticleNotFound('Article not found')

    history = deserialize_history(article_row.get('history'))
    history_entries_added: list[dict[str, Any]] = []
    now = iso_now()
    now_dt = datetime.utcnow()
    doc_json_str = None
    if doc_json is not None:
        try:
            doc_json_str = json.dumps(doc_json)
        except Exception:
            doc_json_str = None

    def _maybe_create_auto_version() -> None:
        if not create_version_if_stale_hours:
            return
        try:
            hours = int(create_version_if_stale_hours)
        except Exception:
            return
        if hours <= 0:
            return
        updated_at_raw = (article_row.get('updated_at') or '').strip()
        if not updated_at_raw:
            return
        try:
            updated_dt = datetime.fromisoformat(updated_at_raw)
        except Exception:
            return
        age_seconds = (now_dt - updated_dt).total_seconds()
        if age_seconds < hours * 3600:
            return
        # Сохраняем версию "как было" перед первым изменением после долгой паузы.
        try:
            blocks_snapshot = rows_to_tree(article_id)
            CONN.execute(
                '''
                INSERT INTO article_versions (id, article_id, author_id, created_at, reason, label, blocks_json, doc_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    str(uuid.uuid4()),
                    article_id,
                    author_id,
                    now,
                    'auto-12h',
                    None,
                    json.dumps(blocks_snapshot or []),
                    article_row.get('article_doc_json'),
                ),
            )
        except Exception:
            # Не блокируем сохранение статьи из-за версии.
            return

    def _push_history_if_text_changed(block_id: str, before: str, after: str) -> None:
        if before == after:
            return
        entry = {
            'id': str(uuid.uuid4()),
            'blockId': block_id,
            'before': before,
            'after': after,
            'timestamp': now,
        }
        history.append(entry)
        history_entries_added.append(entry)

    # Собираем список блоков, для которых нужно обновить embeddings (новые или изменившие текст).
    changed_for_embeddings: list[dict[str, Any]] = []
    removed_ids = set(existing_map.keys()) - seen_ids

    def _insert_tree(
        nodes: list[dict[str, Any]],
        *,
        parent_id: str | None,
    ) -> None:
        for index, blk in enumerate(nodes):
            bid = str(blk.get('id') or '')
            raw_text = blk.get('text') or ''
            raw_collapsed = bool(blk.get('collapsed', False))

            # Важно: нормализуем HTML так же, как в update_block, чтобы данные были однородными.
            new_text = sanitize_html(raw_text or '')
            new_text = _maybe_convert_pipe_table_html(new_text)
            # Раскрываем wikilinks [[...]] как в update_block.
            if author_id:
                new_text = _expand_wikilinks(new_text, author_id)

            prev = existing_map.get(bid)
            prev_text = (prev.get('text') if prev else '') or ''
            prev_collapsed = bool(prev.get('collapsed')) if prev else False
            created_at = (prev.get('createdAt') if prev else None) or now
            updated_at = (prev.get('updatedAt') if prev else None) or now
            if prev and (prev_text != new_text or prev_collapsed != raw_collapsed):
                updated_at = now
            if not prev:
                updated_at = now

            if prev_text != new_text:
                _push_history_if_text_changed(bid, prev_text, new_text)
                changed_for_embeddings.append({'id': bid, 'text': new_text, 'children': []})

            plain_text = strip_html(new_text)
            lemma = build_lemma(plain_text)
            normalized_text = build_normalized_tokens(plain_text)
            block_rowid = _insert_block_row(
                (
                    bid,
                    article_id,
                    parent_id,
                    index,
                    new_text,
                    normalized_text,
                    int(raw_collapsed),
                    created_at,
                    updated_at,
                ),
            )
            upsert_block_search_index(block_rowid, article_id, new_text, lemma, normalized_text)

            children = blk.get('children') or []
            if children:
                _insert_tree(children, parent_id=bid)

    with CONN:
        _maybe_create_auto_version()
        CONN.execute('DELETE FROM blocks WHERE article_id = ?', (article_id,))
        CONN.execute('DELETE FROM blocks_fts WHERE article_id = ?', (article_id,))
        _insert_tree(blocks, parent_id=None)
        CONN.execute(
            'UPDATE articles SET updated_at = ?, history = ?, redo_history = ?, article_doc_json = COALESCE(?, article_doc_json) WHERE id = ?',
            (now, serialize_history(history), '[]', doc_json_str, article_id),
        )
        # Prefer doc_json for link extraction in outline-first mode.
        if doc_json is not None and not article_row.get('is_encrypted'):
            _rebuild_article_links_for_article_id(article_id, doc_json=doc_json)
        else:
            _rebuild_article_links_for_article_id(article_id)

    # Семантические embeddings обновляем после транзакции.
    try:
        if removed_ids:
            delete_block_embeddings(list(removed_ids))
        if changed_for_embeddings:
            # Обновляем embeddings только для блоков, где поменялся текст (или блок новый).
            # Источник истины: TipTap `doc_json` (outlineSection heading+body, без детей).
            if doc_json is not None and not article_row.get('is_encrypted'):
                section_map = build_outline_section_plain_text_map(doc_json)
                changed_ids = [str(b.get('id') or '') for b in changed_for_embeddings if b.get('id')]
                changed_plain = {bid: section_map.get(bid, '') for bid in changed_ids if bid}
                upsert_embeddings_for_plain_texts(
                    author_id=author_id,
                    article_id=article_id,
                    article_title=article_row.get('title') or '',
                    block_texts=changed_plain,
                    updated_at=now,
                )
            else:
                # Fallback for legacy/unknown content.
                upsert_embeddings_for_block_tree(
                    author_id=author_id,
                    article_id=article_id,
                    article_title=article_row.get('title') or '',
                    blocks=changed_for_embeddings,
                    updated_at=now,
                )
    except Exception as exc:  # noqa: BLE001
        logger.warning('Failed to update semantic embeddings after replace_article_blocks_tree: %r', exc)

    # FTS по секциям outline (doc_json-first).
    try:
        if doc_json is not None and not article_row.get('is_encrypted'):
            # replace-tree заменяет структуру статьи целиком → пересобираем индекс целиком,
            # чтобы не зависеть от эвристик "что поменялось" на уровне legacy HTML.
            CONN.execute('DELETE FROM outline_sections_fts WHERE article_id = ?', (article_id,))
            section_map = build_outline_section_plain_text_map(doc_json)
            for sid, plain in (section_map or {}).items():
                text = (plain or '').strip()
                lemma = build_lemma(text)
                normalized = build_normalized_tokens(text)
                upsert_outline_section_search_index(
                    sid,
                    article_id,
                    text,
                    lemma,
                    normalized,
                    now,
                )
    except Exception as exc:  # noqa: BLE001
        logger.warning('Failed to update outline sections FTS after replace_article_blocks_tree: %r', exc)

    return {
        'status': 'ok',
        'articleId': article_id,
        'updatedAt': now,
        'changedBlockIds': [b.get('id') for b in changed_for_embeddings if b.get('id')],
        'removedBlockIds': list(removed_ids),
        'historyEntriesAdded': history_entries_added,
    }


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
      # Если блок создаётся с готовым содержимым (payload) и в нём уже есть
      # текст или дети, он может содержать ссылки — пересчитываем связи.
      # Пустые/по умолчанию блоки (Ctrl+↑/↓, быстрые заметки и т.п.)
      # не требуют полного пересчёта article_links.
      if payload is not None and (payload.get('text') or payload.get('children')):
          _rebuild_article_links_for_article_id(article_id)
    # Если вставили блок с контентом (например, при split/undo/импорт) — создаём embeddings.
    if payload is not None and (payload.get('text') or payload.get('children')):
        try:
            art = CONN.execute('SELECT author_id, title FROM articles WHERE id = ?', (article_id,)).fetchone()
            if art and art.get('author_id'):
                upsert_embeddings_for_block_tree(
                    author_id=art['author_id'],
                    article_id=article_id,
                    article_title=art.get('title') or '',
                    blocks=[inserted],
                    updated_at=now,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning('Failed to update semantic embeddings after insert_block: %r', exc)
            try:
                art = CONN.execute('SELECT author_id FROM articles WHERE id = ?', (article_id,)).fetchone()
                if art and art.get('author_id'):
                    notify_user(
                        art['author_id'],
                        f'Семантический индекс: ошибка при вставке блока (обновление embeddings): {exc!r}',
                        key='semantic-embed-update',
                    )
            except Exception:
                pass
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
        # Обновляем корзину блоков статьи.
        trash = list(article.get('blockTrash') or [])
        trash.append(
            {
                'id': removed.get('id'),
                'block': removed,
                'parentId': parent_id,
                'index': index,
                'deletedAt': now,
            },
        )
        CONN.execute(
            'UPDATE articles SET block_trash = ? , updated_at = ? WHERE id = ?',
            (serialize_history(trash), now, article_id),
        )
        subtree_rows = CONN.execute(
            '''
            WITH RECURSIVE subtree(id) AS (
                SELECT id FROM blocks WHERE id = ? AND article_id = ?
                UNION ALL
                SELECT b.id FROM blocks b JOIN subtree s ON b.parent_id = s.id
            )
            SELECT id, block_rowid
            FROM blocks
            WHERE article_id = ? AND id IN (SELECT id FROM subtree)
            ''',
            (block_id, article_id, article_id),
        ).fetchall()
        rowids = [row['block_rowid'] for row in subtree_rows or []]
        block_ids = [row['id'] for row in subtree_rows or []]
        if rowids:
            placeholders = ','.join('?' for _ in rowids)
            CONN.execute(f'DELETE FROM blocks_fts WHERE block_rowid IN ({placeholders})', tuple(rowids))
        if block_ids:
            delete_block_embeddings(block_ids)
        CONN.execute('DELETE FROM blocks WHERE id = ? AND article_id = ?', (block_id, article_id))
        CONN.execute(
            f'UPDATE blocks SET position = position - 1 WHERE article_id = ? AND {clause} AND position > ?',
            (article_id, *params, target_row['position']),
        )
        # После удаления блока пересчитываем связи для статьи.
        _rebuild_article_links_for_article_id(article_id)
    return {
        'removedBlockId': block_id,
        'parentId': parent_id,
        'index': index,
        'block': removed,
    }


def delete_block_permanent(article_id: str, block_id: str) -> Optional[Dict[str, Any]]:
  """
  Удаляет блок без помещения в корзину блоков статьи (blockTrash).
  Используется для «мимолётных» пустых блоков, которые никогда не содержали текста.
  """
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
      subtree_rows = CONN.execute(
          '''
          WITH RECURSIVE subtree(id) AS (
              SELECT id FROM blocks WHERE id = ? AND article_id = ?
              UNION ALL
              SELECT b.id FROM blocks b JOIN subtree s ON b.parent_id = s.id
          )
          SELECT id, block_rowid
          FROM blocks
          WHERE article_id = ? AND id IN (SELECT id FROM subtree)
          ''',
          (block_id, article_id, article_id),
      ).fetchall()
      rowids = [row['block_rowid'] for row in subtree_rows or []]
      block_ids = [row['id'] for row in subtree_rows or []]
      if rowids:
          placeholders = ','.join('?' for _ in rowids)
          CONN.execute(f'DELETE FROM blocks_fts WHERE block_rowid IN ({placeholders})', tuple(rowids))
      if block_ids:
          delete_block_embeddings(block_ids)
      CONN.execute('DELETE FROM blocks WHERE id = ? AND article_id = ?', (block_id, article_id))
      CONN.execute(
          f'UPDATE blocks SET position = position - 1 WHERE article_id = ? AND {clause} AND position > ?',
          (article_id, *params, target_row['position']),
      )
      CONN.execute('UPDATE articles SET updated_at = ? WHERE id = ?', (now, article_id))
      _rebuild_article_links_for_article_id(article_id)
  return {
      'removedBlockId': block_id,
      'parentId': parent_id,
      'index': index,
      'block': removed,
  }


def clear_block_trash(article_id: str) -> Dict[str, Any]:
    article = get_article(article_id)
    if not article:
        raise ArticleNotFound(f'Article {article_id} not found')
    now = iso_now()
    with CONN:
        CONN.execute(
            'UPDATE articles SET block_trash = ?, updated_at = ? WHERE id = ?',
            (serialize_history([]), now, article_id),
        )
    article['blockTrash'] = []
    return {'trash': []}


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
        # Восстановленный блок мог содержать ссылки.
        _rebuild_article_links_for_article_id(article_id)
    return {'block': inserted, 'parentId': parent_id or None, 'index': insertion}


def restore_block_from_trash(article_id: str, trashed_block_id: str) -> Optional[Dict[str, Any]]:
  article = get_article(article_id)
  if not article:
      raise ArticleNotFound(f'Article {article_id} not found')
  trash_list = list(article.get('blockTrash') or [])
  entry_index = None
  entry = None
  for idx, item in enumerate(trash_list):
      if not isinstance(item, dict):
          continue
      item_id = item.get('id') or (item.get('block') or {}).get('id')
      if item_id == trashed_block_id:
          entry_index = idx
          entry = item
          break
  if entry_index is None or not entry:
      raise InvalidOperation('Block not found in trash')

  payload = entry.get('block') or {}
  if not payload.get('id'):
      payload['id'] = trashed_block_id

  parent_id = entry.get('parentId')
  index = entry.get('index')

  # Пытаемся восстановить на исходное место; при ошибке — в корень.
  try:
      result = restore_block(article_id, parent_id, index, payload)
  except (BlockNotFound, InvalidOperation):
      result = restore_block(article_id, None, None, payload)

  if not result or not result.get('block'):
      raise InvalidOperation('Failed to restore block from trash')

  # Обновляем корзину статьи.
  new_trash = [item for i, item in enumerate(trash_list) if i != entry_index]
  now = iso_now()
  with CONN:
      CONN.execute(
          'UPDATE articles SET block_trash = ?, updated_at = ? WHERE id = ?',
          (serialize_history(new_trash), now, article_id),
      )

  result['blockId'] = result.get('block', {}).get('id')
  result['trash'] = new_trash
  return result


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
    try:
        author_id = target_article.get('authorId') or ''
        if author_id:
            upsert_embeddings_for_block_tree(
                author_id=author_id,
                article_id=target_article_id,
                article_title=target_article.get('title') or '',
                blocks=[inserted],
                updated_at=iso_now(),
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning('Failed to update semantic embeddings after move_block_to_article: %r', exc)
        try:
            author_id = target_article.get('authorId') or ''
            if author_id:
                notify_user(
                    author_id,
                    f'Семантический индекс: ошибка при переносе блока между статьями (обновление embeddings): {exc!r}',
                    key='semantic-embed-update',
                )
        except Exception:
            pass
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
            # Драйвер корректно сохранит bool в базе.
            params.append(desired)
            article['encrypted'] = desired
            # При включении шифрования очищаем корзину блоков, чтобы
            # в ней не оставались незашифрованные данные.
            if desired and article.get('blockTrash'):
                updates.append('block_trash = ?')
                params.append(serialize_history([]))
                article['blockTrash'] = []
            # Также очищаем plaintext docJson (outline), чтобы не оставалось
            # незашифрованного содержимого на сервере.
            if desired:
                updates.append('article_doc_json = NULL')
                article['docJson'] = None

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
    block_row = CONN.execute(
        'SELECT block_rowid FROM blocks WHERE id = ? AND article_id = ?',
        (block_id, article_id),
    ).fetchone()
    if not block_row:
        # Блок был удалён после записи истории — текстовое undo для него
        # больше невозможно, считаем что "нечего отменять", а не ошибка.
        raise InvalidOperation('Nothing to undo')
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
    block_row = CONN.execute(
        'SELECT block_rowid FROM blocks WHERE id = ? AND article_id = ?',
        (block_id, article_id),
    ).fetchone()
    if not block_row:
        # Соответствующий блок уже удалён — повторять нечего.
        raise InvalidOperation('Nothing to redo')
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

    Для локальных вложений:
      - физически файлы лежат под /uploads/<user_id>/attachments/<article_id>/<filename>;
      - наружу мы показываем storedPath: /uploads/<article_id>/<filename>,
        а url == фактическому пути (stored_path), чтобы не ломать существующих клиентов.

    Для удалённых вложений (например, Яндекс.Диск, пути вида app:/... или disk:/...):
      - storedPath и url совпадают и равны stored_path.
    """
    if not stored_path:
        return f'/uploads/{article_id}/', ''

    # Вложения на Яндекс.Диске или других внешних хранилищах.
    if stored_path.startswith('app:/') or stored_path.startswith('disk:/'):
        return stored_path, stored_path

    # Локальные вложения в /uploads/...
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
    Нужен из‑за различий в формате имён колонок между драйверами/версиями.
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
        base_sql += ' AND articles.author_id = ?'
        params.append(author_id)
    base_sql += ' ORDER BY rank DESC, articles.updated_at DESC LIMIT ?'
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
    ts_query = build_postgres_ts_query(query)
    if not ts_query:
        return []
    base_sql = '''
        SELECT
            outline_sections_fts.section_id AS blockId,
            articles.id AS articleId,
            articles.title AS articleTitle,
            ts_headline('simple', outline_sections_fts.text, to_tsquery('simple', ?)) AS snippet,
            outline_sections_fts.text AS blockText,
            ts_rank_cd(outline_sections_fts.search_vector, to_tsquery('simple', ?)) AS rank
        FROM outline_sections_fts
        JOIN articles ON articles.id = outline_sections_fts.article_id
        WHERE articles.deleted_at IS NULL
          AND outline_sections_fts.search_vector @@ to_tsquery('simple', ?)
    '''
    params: List[Any] = [ts_query, ts_query, ts_query]
    if author_id is not None:
        base_sql += ' AND articles.author_id = ?'
        params.append(author_id)
    base_sql += ' ORDER BY rank DESC, outline_sections_fts.updated_at DESC LIMIT ?'
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
        CONN.execute('DELETE FROM outline_sections_fts')
        CONN.execute('DELETE FROM articles_fts')
    article_rows = CONN.execute('SELECT id, title FROM articles').fetchall()
    with CONN:
        for row in article_rows:
            upsert_article_search_index(row['id'], row['title'] or '', use_transaction=False)

    # Outline sections index (doc_json-first).
    article_rows = CONN.execute(
        '''
        SELECT id, title, updated_at, is_encrypted, encryption_salt, encryption_verifier, article_doc_json
        FROM articles
        WHERE deleted_at IS NULL
        '''
    ).fetchall()
    with CONN:
        for row in article_rows:
            encrypted_flag = bool(row.get('is_encrypted', 0)) or (
                bool(row.get('encryption_salt')) and bool(row.get('encryption_verifier'))
            )
            if encrypted_flag:
                continue
            raw_doc = row.get('article_doc_json') or ''
            if not raw_doc:
                continue
            try:
                doc = json.loads(raw_doc) if isinstance(raw_doc, str) else raw_doc
            except Exception:
                continue
            section_map = build_outline_section_plain_text_map(doc)
            updated_at = str(row.get('updated_at') or '') or iso_now()
            for sid, plain in (section_map or {}).items():
                text = (plain or '').strip()
                lemma = build_lemma(text)
                normalized = build_normalized_tokens(text)
                upsert_outline_section_search_index(sid, row['id'], text, lemma, normalized, updated_at)
    mark_search_index_clean()
