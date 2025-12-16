from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from .. import db as db_module
from ..auth import User, get_current_user
from ..db import CONN, IS_SQLITE
from ..data_store import search_everything

router = APIRouter()


# Вынесено из app/main.py → app/routers/search.py
@router.get('/api/search')
def get_search(q: str = '', current_user: User = Depends(get_current_user)):
    query = q.strip()
    if not query:
        return []
    if IS_SQLITE:
        # Если индексы помечены как «грязные» (например, после явного DELETE в тестах),
        # временно отключаем поиск, пока не будет вызван rebuild_search_indexes().
        if db_module.SEARCH_INDEX_DIRTY:
            return []

        pattern = f'%{query}%'
        # Простой поиск по названиям статей
        article_rows = CONN.execute(
            '''
            SELECT id AS articleId, title, updated_at
            FROM articles
            WHERE deleted_at IS NULL
              AND author_id = ?
              AND title LIKE ?
            ORDER BY updated_at DESC
            LIMIT 15
            ''',
            (current_user.id, pattern),
        ).fetchall()
        article_results = [
            {
                'type': 'article',
                'articleId': row['articleId'],
                'articleTitle': row['title'] or '',
                'snippet': row['title'] or '',
            }
            for row in article_rows
        ]

        # Простой поиск по содержимому блоков
        block_rows = CONN.execute(
            '''
            SELECT
                blocks.id AS blockId,
                articles.id AS articleId,
                articles.title AS articleTitle,
                blocks.text AS blockText
            FROM blocks
            JOIN articles ON articles.id = blocks.article_id
            WHERE articles.deleted_at IS NULL
              AND articles.author_id = ?
              AND blocks.text LIKE ?
            ORDER BY blocks.block_rowid DESC
            LIMIT 30
            ''',
            (current_user.id, pattern),
        ).fetchall()
        block_results = [
            {
                'type': 'block',
                'articleId': row['articleId'],
                'articleTitle': row['articleTitle'] or '',
                'blockId': row['blockId'],
                'snippet': row['blockText'] or '',
                'blockText': row['blockText'] or '',
            }
            for row in block_rows
        ]
        return article_results + block_results

    # Для PostgreSQL используем специализированный поиск из слоя данных.
    return search_everything(query, block_limit=30, article_limit=15, author_id=current_user.id)

