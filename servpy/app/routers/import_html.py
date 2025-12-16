from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from ..auth import User, get_current_user
from ..db import CONN
from ..data_store import get_article, save_article
from ..import_html import _parse_memus_export_payload, _process_block_html_for_import

router = APIRouter()


# Вынесено из app/main.py → app/routers/import_html.py
@router.post('/api/import/html')
async def import_article_from_html(
    file: UploadFile = File(...),
    mode: str | None = Form(None),
    versionPrefix: str | None = Form(None),
    current_user: User = Depends(get_current_user),
):
    """
    Импортирует статью из HTML-файла, созданного опцией «Сохранить в HTML».
    Поддерживаются только файлы текущего формата Memus (memus;v=1).
    """
    if not file.filename.lower().endswith('.html'):
        raise HTTPException(status_code=400, detail='Ожидается файл HTML, сохранённый из Memus')
    raw = await file.read()
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        text = raw.decode('utf-8', errors='ignore')

    try:
        payload = _parse_memus_export_payload(text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    article_meta = payload.get('article') or {}
    blocks_meta = payload.get('blocks') or []

    base_title = (article_meta.get('title') or file.filename or 'Импортированная статья').strip() or 'Импортированная статья'
    import_mode = (mode or '').strip().lower()
    if import_mode not in {'overwrite', 'copy'}:
        import_mode = 'new'

    source_article_id = (article_meta.get('id') or '').strip()

    # Определяем целевой ID и заголовок в зависимости от режима.
    target_article_id: str
    title: str

    if import_mode == 'overwrite' and source_article_id:
        # Перезапись существующей статьи (или восстановление по исходному UUID).
        row = CONN.execute(
            'SELECT author_id FROM articles WHERE id = ?',
            (source_article_id,),
        ).fetchone()
        if row and row.get('author_id') not in (None, current_user.id):
            raise HTTPException(status_code=403, detail='Нельзя перезаписать чужую статью')
        target_article_id = source_article_id
        title = base_title
    elif import_mode == 'copy':
        # Создаём копию с новым UUID и префиксом версии в заголовке.
        target_article_id = str(uuid4())
        prefix = (versionPrefix or '').strip()
        if not prefix:
            # На всякий случай строим префикс из текущего времени.
            now_dt = datetime.utcnow()
            prefix = now_dt.strftime('ver_%Y%m%d_%H%M%S')
        title = f'{prefix} {base_title}'
    else:
        # Стандартный импорт: новая статья с новым UUID.
        target_article_id = str(uuid4())
        title = base_title
    now = datetime.utcnow().isoformat()

    def build_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for meta in blocks or []:
            original_id = str(meta.get('id') or '')
            new_id = str(uuid4())
            try:
                # Привязываем обработку вложений и ссылок к целевой статье,
                # которую мы фактически создаём при импорте.
                text_html = _process_block_html_for_import(text, original_id, current_user, target_article_id)
            except Exception:
                text_html = meta.get('text') or ''
            if not text_html:
                text_html = meta.get('text') or ''
            children_meta = meta.get('children') or []
            children = build_blocks(children_meta)
            result.append(
                {
                    'id': new_id,
                    'text': text_html,
                    'collapsed': bool(meta.get('collapsed')),
                    'children': children,
                }
            )
        return result

    blocks_tree = build_blocks(blocks_meta)

    article = {
        'id': target_article_id,
        'title': title,
        'createdAt': article_meta.get('createdAt') or now,
        'updatedAt': article_meta.get('updatedAt') or now,
        'deletedAt': None,
        'blocks': blocks_tree,
        'history': [],
        'redoHistory': [],
        'authorId': current_user.id,
    }

    save_article(article)
    created = get_article(target_article_id, current_user.id)
    if not created:
        raise HTTPException(status_code=500, detail='Не удалось создать статью при импорте')
    return created

