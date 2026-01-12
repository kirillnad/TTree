from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .data_store import get_yandex_tokens
from .db import CONN

logger = logging.getLogger('uvicorn.error')

BASE_DIR = Path(__file__).resolve().parents[3]
UPLOADS_DIR = BASE_DIR / 'uploads'

ATTACHMENTS_GC_TTL_DAYS = int(os.environ.get('SERVPY_ATTACHMENTS_GC_TTL_DAYS') or '180')
ATTACHMENTS_GC_INTERVAL_SECONDS = int(os.environ.get('SERVPY_ATTACHMENTS_GC_INTERVAL_SECONDS') or str(24 * 60 * 60))
ATTACHMENTS_GC_STARTUP_DELAY_SECONDS = int(os.environ.get('SERVPY_ATTACHMENTS_GC_STARTUP_DELAY_SECONDS') or '60')

_LOCK = threading.Lock()
_THREAD: threading.Thread | None = None
_STOP = False


def kick_attachments_gc_worker() -> None:
    """
    Background process:
      - scans all articles.article_doc_json,
      - marks attachments as referenced/unreferenced,
      - deletes attachments unreferenced for TTL days (local + Yandex).
    """
    global _THREAD
    if _STOP:
        return
    with _LOCK:
        if _THREAD and _THREAD.is_alive():
            return

        def _runner() -> None:
            if ATTACHMENTS_GC_STARTUP_DELAY_SECONDS > 0:
                time.sleep(float(ATTACHMENTS_GC_STARTUP_DELAY_SECONDS))
            logger.info('attachments_gc: worker started ttlDays=%s intervalSeconds=%s', ATTACHMENTS_GC_TTL_DAYS, ATTACHMENTS_GC_INTERVAL_SECONDS)
            while not _STOP:
                try:
                    run_attachments_gc_once()
                except Exception as exc:  # noqa: BLE001
                    logger.error('attachments_gc: loop error: %r', exc)
                time.sleep(max(60, int(ATTACHMENTS_GC_INTERVAL_SECONDS)))

        _THREAD = threading.Thread(target=_runner, name='attachments-gc', daemon=True)
        _THREAD.start()


def _safe_iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def _parse_iso(s: str | None) -> datetime | None:
    raw = str(s or '').strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except Exception:
        return None


def _extract_refs_from_doc_json(doc_json_str: str) -> set[str]:
    """
    Extract all URL-like strings from doc_json that can reference attachments:
      - link marks href
      - image node src
      - yandex proxy /api/yandex/disk/file?path=... (decoded to app:/... as well)
    """
    refs: set[str] = set()

    def add_href(href: str) -> None:
        h = str(href or '').strip()
        if not h:
            return
        refs.add(h)
        if h.startswith('/api/yandex/disk/file?'):
            try:
                url = urllib.parse.urlparse(h)
                qs = urllib.parse.parse_qs(url.query or '')
                p = (qs.get('path') or [''])[0]
                if p:
                    refs.add(p)
            except Exception:
                pass

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        # link marks
        marks = node.get('marks')
        if isinstance(marks, list):
            for m in marks:
                if not isinstance(m, dict) or m.get('type') != 'link':
                    continue
                attrs = m.get('attrs')
                if isinstance(attrs, dict):
                    add_href(str(attrs.get('href') or ''))
        # images (outline uses image nodes with attrs.src)
        if node.get('type') == 'image':
            attrs = node.get('attrs')
            if isinstance(attrs, dict):
                add_href(str(attrs.get('src') or ''))
        # generic attrs that can include href
        attrs = node.get('attrs')
        if isinstance(attrs, dict):
            if isinstance(attrs.get('href'), str):
                add_href(str(attrs.get('href') or ''))
            if isinstance(attrs.get('src'), str):
                add_href(str(attrs.get('src') or ''))
        # recurse
        walk(node.get('content'))

    try:
        doc = json.loads(doc_json_str or '')
        walk(doc)
    except Exception:
        return refs
    return refs


def _attachment_ref_keys(*, article_id: str, stored_path: str) -> set[str]:
    """
    Build possible hrefs that can reference a given attachment row.
    """
    keys: set[str] = set()
    p = str(stored_path or '').strip()
    if not p:
        return keys
    keys.add(p)
    # Yandex proxy variant
    if p.startswith('app:/') or p.startswith('disk:/'):
        encoded = urllib.parse.quote(p, safe='')
        keys.add(f'/api/yandex/disk/file?path={encoded}')
        return keys
    # Local upload: physical path -> public path
    if p.startswith('/uploads/') and '/attachments/' in p:
        filename = p.rsplit('/', 1)[-1]
        if filename:
            keys.add(f'/uploads/{article_id}/{filename}')
    return keys


def _delete_local_upload(*, user_id: str, article_id: str, stored_path: str) -> bool:
    path = str(stored_path or '').strip()
    if not path.startswith('/uploads/'):
        return False
    rel = path[len('/uploads/') :]
    rel_parts = [p for p in rel.split('/') if p and p not in ('.', '..')]
    if not rel_parts:
        return False
    # direct physical
    if rel_parts[0] == str(user_id):
        full_path = UPLOADS_DIR.joinpath(*rel_parts)
        if full_path.is_file():
            try:
                full_path.unlink()
                return True
            except Exception:
                return False
    # legacy public /uploads/<article_id>/<filename>
    filename = rel_parts[-1]
    full_path = UPLOADS_DIR / str(user_id) / 'attachments' / str(article_id) / filename
    if full_path.is_file():
        try:
            full_path.unlink()
            return True
        except Exception:
            return False
    return False


def _delete_yandex_resource(*, user_id: str, disk_path: str) -> bool:
    tokens = get_yandex_tokens(user_id) or {}
    access_token = tokens.get('accessToken') if tokens else None
    if not access_token:
        return False
    encoded = urllib.parse.quote(str(disk_path or '').strip(), safe='')
    url = f'https://cloud-api.yandex.net/v1/disk/resources?path={encoded}&permanently=true'
    req = urllib.request.Request(url, method='DELETE', headers={'Authorization': f'OAuth {access_token}'})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            # 204 or 202
            _ = resp.read()
        return True
    except Exception:
        return False


def run_attachments_gc_once() -> None:
    """
    One GC pass.
    """
    now = datetime.utcnow()
    cutoff = now - timedelta(days=max(1, int(ATTACHMENTS_GC_TTL_DAYS)))
    now_iso = _safe_iso(now)
    cutoff_iso = _safe_iso(cutoff)

    # 1) Collect refs from all articles doc_json.
    referenced_hrefs: set[str] = set()
    rows = CONN.execute(
        """
        SELECT id, article_doc_json
        FROM articles
        WHERE deleted_at IS NULL AND article_doc_json IS NOT NULL
        """,
    ).fetchall()
    for row in rows:
        s = row.get('article_doc_json') or ''
        if not isinstance(s, str) or not s:
            continue
        referenced_hrefs |= _extract_refs_from_doc_json(s)

    # 2) Load attachments with article author_id for deletion.
    att_rows = CONN.execute(
        """
        SELECT a.id, a.article_id, a.stored_path, a.original_name, a.content_type, a.created_at,
               a.last_referenced_at, a.unreferenced_since, ar.author_id
        FROM attachments a
        JOIN articles ar ON ar.id = a.article_id
        WHERE ar.deleted_at IS NULL
        """,
    ).fetchall()

    referenced_by_attachment_id: dict[str, bool] = {}
    for a in att_rows:
        aid = str(a.get('article_id') or '')
        stored_path = str(a.get('stored_path') or '')
        keys = _attachment_ref_keys(article_id=aid, stored_path=stored_path)
        referenced = any((k in referenced_hrefs) for k in keys)
        referenced_by_attachment_id[str(a.get('id') or '')] = referenced

    # 3) Update reference metadata + compute deletion candidates.
    to_set_referenced: list[str] = []
    to_set_unreferenced: list[str] = []
    to_delete: list[dict[str, Any]] = []

    for a in att_rows:
        att_id = str(a.get('id') or '')
        if not att_id:
            continue
        referenced = referenced_by_attachment_id.get(att_id, False)
        unref_since = _parse_iso(a.get('unreferenced_since'))
        if referenced:
            to_set_referenced.append(att_id)
            continue
        # mark unreferenced_since if missing
        if unref_since is None:
            to_set_unreferenced.append(att_id)
            continue
        if unref_since <= cutoff:
            to_delete.append(dict(a))

    if to_set_referenced:
        with CONN:
            for att_id in to_set_referenced:
                CONN.execute(
                    """
                    UPDATE attachments
                    SET last_referenced_at = ?, unreferenced_since = NULL
                    WHERE id = ?
                    """,
                    (now_iso, att_id),
                )

    if to_set_unreferenced:
        with CONN:
            for att_id in to_set_unreferenced:
                CONN.execute(
                    """
                    UPDATE attachments
                    SET unreferenced_since = COALESCE(unreferenced_since, ?)
                    WHERE id = ?
                    """,
                    (now_iso, att_id),
                )

    if not to_delete:
        logger.info(
            'attachments_gc: scan done articles=%s attachments=%s refs=%s cutoff=%s deleteCandidates=0',
            len(rows),
            len(att_rows),
            len(referenced_hrefs),
            cutoff_iso,
        )
        return

    # 4) Delete candidates, but never delete a stored_path that is still referenced elsewhere.
    # Group by stored_path to avoid deleting shared remote files.
    stored_paths_to_delete: dict[str, list[dict[str, Any]]] = {}
    for a in to_delete:
        stored_paths_to_delete.setdefault(str(a.get('stored_path') or ''), []).append(a)

    deleted_count = 0
    skipped_shared = 0
    for stored_path, items in stored_paths_to_delete.items():
        if not stored_path:
            continue
        # If stored_path is still referenced by any attachment, skip.
        any_ref = False
        for a in att_rows:
            if str(a.get('stored_path') or '') != stored_path:
                continue
            if referenced_by_attachment_id.get(str(a.get('id') or ''), False):
                any_ref = True
                break
        if any_ref:
            skipped_shared += len(items)
            continue

        # Choose an owner user_id for Yandex deletion (author of the article).
        owner_user_id = str(items[0].get('author_id') or '')
        article_id = str(items[0].get('article_id') or '')
        deleted_remote = False

        try:
            if stored_path.startswith('app:/') or stored_path.startswith('disk:/'):
                deleted_remote = _delete_yandex_resource(user_id=owner_user_id, disk_path=stored_path)
            elif stored_path.startswith('/uploads/'):
                deleted_remote = _delete_local_upload(user_id=owner_user_id, article_id=article_id, stored_path=stored_path)
        except Exception:
            deleted_remote = False

        # Always delete DB rows; if remote deletion failed, it may be cleaned by external policy later.
        with CONN:
            for a in items:
                CONN.execute('DELETE FROM attachments WHERE id = ?', (str(a.get('id') or ''),))
                deleted_count += 1

        logger.info(
            'attachments_gc: deleted stored_path=%s rows=%s remoteDeleted=%s',
            stored_path,
            len(items),
            bool(deleted_remote),
        )

    logger.info(
        'attachments_gc: scan done articles=%s attachments=%s refs=%s cutoff=%s deleted=%s skippedShared=%s',
        len(rows),
        len(att_rows),
        len(referenced_hrefs),
        cutoff_iso,
        deleted_count,
        skipped_shared,
    )

