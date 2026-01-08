from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .db import CONN
from .blocks_to_outline_doc_json import convert_blocks_to_outline_doc_json
from .data_store import upsert_article_doc_json_snapshot
from .import_html import _parse_memus_export_payload

# Вынесено из app/main.py → app/onboarding.py

logger = logging.getLogger('uvicorn.error')

BASE_DIR = Path(__file__).resolve().parents[2]
CLIENT_DIR = BASE_DIR / "client"

# Шаблонный файл справки, который можно использовать
# как исходник для первой статьи нового пользователя.
HELP_TEMPLATE_PATH = CLIENT_DIR / 'help.html'


def ensure_help_article_for_user(author_id: str) -> None:
    """
    Гарантирует, что у пользователя есть хотя бы одна статья.
    Если статей ещё нет, создаёт «Memus - Руководство пользователя»
    на основе client/help.html (экспорт Memus с блоком memus-export).
    """
    if not author_id:
        return
    try:
        row = CONN.execute(
            'SELECT 1 FROM articles WHERE deleted_at IS NULL AND author_id = ? LIMIT 1',
            (author_id,),
        ).fetchone()
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to check articles for user %s: %r', author_id, exc)
        return
    if row:
        # У пользователя уже есть хотя бы одна статья — ничего не делаем.
        return

    try:
        html_text = HELP_TEMPLATE_PATH.read_text(encoding='utf-8')
    except OSError as exc:  # noqa: BLE001
        logger.error('Failed to read help template %s: %r', HELP_TEMPLATE_PATH, exc)
        return

    try:
        payload = _parse_memus_export_payload(html_text)
    except ValueError as exc:  # noqa: BLE001
        logger.error('Failed to parse memus-export from help.html: %r', exc)
        return

    article_meta = payload.get('article') or {}
    blocks_meta = payload.get('blocks') or []

    def build_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for meta in blocks or []:
            children_meta = meta.get('children') or []
            children = build_blocks(children_meta)
            result.append(
                {
                    'id': str(uuid4()),
                    'text': meta.get('text') or '',
                    'collapsed': bool(meta.get('collapsed')),
                    'children': children,
                }
            )
        return result

    now = datetime.utcnow().isoformat()
    new_article_id = str(uuid4())
    title_raw = (article_meta.get('title') or 'Memus - Руководство пользователя').strip()
    title = title_raw or 'Memus - Руководство пользователя'

    article = {
        'id': new_article_id,
        'title': title,
        'createdAt': article_meta.get('createdAt') or now,
        'updatedAt': article_meta.get('updatedAt') or now,
        'deletedAt': None,
        'blocks': build_blocks(blocks_meta),
        'history': [],
        'redoHistory': [],
        'authorId': author_id,
    }
    try:
        doc_json = convert_blocks_to_outline_doc_json(article.get('blocks') or [], fallback_id=new_article_id)
        upsert_article_doc_json_snapshot(
            article_id=new_article_id,
            author_id=author_id,
            title=title,
            doc_json=doc_json,
            created_at=str(article_meta.get('createdAt') or now),
            updated_at=str(article_meta.get('updatedAt') or now),
            reset_history=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to create default help article for user %s: %r', author_id, exc)
        return
