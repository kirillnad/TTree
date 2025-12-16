from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends

from ..auth import User, get_current_user
from ..db import CONN
from ..data_store import get_articles

router = APIRouter()
logger = logging.getLogger('uvicorn.error')


# Вынесено из app/main.py → app/routers/graph.py
@router.get('/api/graph')
def get_articles_graph(current_user: User = Depends(get_current_user)):
    """
    Возвращает граф связей статей текущего пользователя.

    Формат:
    {
      "nodes": [
        { "id": "...", "title": "...", "updatedAt": "...", "public": true/false, "encrypted": true/false }
      ],
      "edges": [
        { "source": "<from_id>", "target": "<to_id>" }
      ]
    }
    """
    inbox_id = f'inbox-{current_user.id}'
    articles = [a for a in get_articles(current_user.id) if a['id'] != inbox_id]
    nodes_by_id: dict[str, dict[str, Any]] = {}
    for a in articles:
        aid = a.get('id')
        if not aid:
            continue
        nodes_by_id[aid] = {
            'id': aid,
            'title': a.get('title') or 'Без названия',
            'updatedAt': a.get('updatedAt'),
            'public': bool(a.get('publicSlug')),
            'publicSlug': a.get('publicSlug') or None,
            'encrypted': bool(a.get('encrypted', False)),
        }
    if not nodes_by_id:
        return {'nodes': [], 'edges': []}

    # Собираем рёбра из article_links, но только между статьями текущего пользователя.
    node_ids = set(nodes_by_id.keys())
    try:
        link_rows = CONN.execute('SELECT from_id, to_id FROM article_links').fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to read article_links for graph: %r', exc)
        return {'nodes': list(nodes_by_id.values()), 'edges': []}

    edges: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for row in link_rows or []:
        from_id = row.get('from_id')
        to_id = row.get('to_id')
        if not from_id or not to_id:
            continue
        if from_id not in node_ids or to_id not in node_ids:
            continue
        key = (from_id, to_id)
        if key in seen:
            continue
        seen.add(key)
        edges.append({'source': from_id, 'target': to_id})

    return {'nodes': list(nodes_by_id.values()), 'edges': edges}

