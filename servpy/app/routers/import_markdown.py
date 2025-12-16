from __future__ import annotations

import html as html_mod
import logging
import mimetypes
import re
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from ..auth import User, get_current_user
from ..data_store import _expand_wikilinks, get_article, save_article
from ..import_assets import _import_attachment_from_bytes
from ..import_utils import _parse_markdown_blocks, _walk_blocks

router = APIRouter()
logger = logging.getLogger('uvicorn.error')


# Вынесено из app/main.py → app/routers/import_markdown.py
@router.post('/api/import/markdown')
async def import_article_from_markdown(
    file: UploadFile = File(...),
    assets_base_url: str | None = Form(None, alias='assetsBaseUrl'),
    current_user: User = Depends(get_current_user),
):
    """
    Импортирует статью из простого Markdown-списка.

    Формат:
    - каждый блок начинается с новой строки и символа "-" (после табов);
    - уровень вложенности определяется количеством табов перед "-";
    - строки, начинающиеся (после табов) с "collapsed::" игнорируются;
    - фрагменты **текста** становятся жирными (<strong>...</strong>);
    - если первая строка блока начинается с #/##/###/####,
      она становится заголовком блока (перед телом вставляется пустая строка).
    """
    filename = (file.filename or '').lower()
    if not (filename.endswith('.md') or filename.endswith('.txt')):
        raise HTTPException(status_code=400, detail='Ожидается файл в формате Markdown (.md)')
    raw = await file.read()
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        text = raw.decode('utf-8', errors='ignore')

    blocks_tree = _parse_markdown_blocks(text)
    if not blocks_tree:
        raise HTTPException(status_code=400, detail='Не удалось выделить блоки из Markdown')

    now = datetime.utcnow().isoformat()
    new_article_id = str(uuid4())
    # Имя статьи = имя файла без расширения (без эвристик).
    base_title = (file.filename or 'Импортированная статья').rsplit('.', 1)[0].strip() or 'Импортированная статья'

    # Сохраняем «пустую» статью, чтобы запись в articles уже существовала
    # перед тем, как создавать записи во вложениях (attachments).
    skeleton_article = {
        'id': new_article_id,
        'title': base_title,
        'createdAt': now,
        'updatedAt': now,
        'deletedAt': None,
        'blocks': [],
        'history': [],
        'redoHistory': [],
        'authorId': current_user.id,
    }
    save_article(skeleton_article)

    base_url = (assets_base_url or '').strip().rstrip('/') or None

    if base_url:
        from urllib.parse import quote, urljoin, urlsplit, urlunsplit
        import urllib.request

        def _resolve_md_assets(html_text: str) -> str:
            """
            Ищет ссылки href="...assets/..." и, если возможно, подтягивает файлы
            из внешнего assetsBaseUrl в uploads/attachments.
            """

            def _replace_href(match: re.Match[str]) -> str:
                href = match.group(1) or ''
                href_stripped = href.strip()
                if not href_stripped or href_stripped.startswith('/uploads/'):
                    return match.group(0)
                parts = list(PurePosixPath(href_stripped).parts)
                if 'assets' not in parts:
                    return match.group(0)
                idx = parts.index('assets')
                rel = PurePosixPath(*parts[idx + 1 :]).as_posix()
                if not rel:
                    return match.group(0)

                # Пробуем варианты: файл лежит в корне base_url или в подпапке /assets.
                candidates = [rel, f'assets/{rel}']
                for remote_path in candidates:
                    full_url = urljoin(base_url + '/', remote_path)
                    try:
                        # Логируем URL, который пробуем подтянуть.
                        logger.info(
                            '[md_import] trying to fetch asset from %s for article %s',
                            full_url,
                            new_article_id,
                        )
                        # Корректно кодируем путь (кириллица и др.) в URL.
                        parts = urlsplit(full_url)
                        safe_path = quote(parts.path)
                        safe_url = urlunsplit((parts.scheme, parts.netloc, safe_path, parts.query, parts.fragment))
                        req = urllib.request.Request(safe_url, headers={'User-Agent': 'memus-md-import/1.0'})
                        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
                            data = resp.read()
                            mime_type = (
                                resp.headers.get_content_type()
                                or mimetypes.guess_type(full_url)[0]
                                or 'application/octet-stream'
                            )
                    except Exception as exc:  # noqa: BLE001
                        # Логируем неудачные попытки подтянуть вложение из внешнего assetsBaseUrl.
                        logger.warning(
                            '[md_import] failed to fetch asset from %s for article %s: %r',
                            full_url,
                            new_article_id,
                            exc,
                        )
                        continue

                    stored_path = _import_attachment_from_bytes(
                        data,
                        mime_type,
                        current_user,
                        new_article_id,
                        display_name=PurePosixPath(remote_path).name,
                    )
                    new_href = html_mod.escape(stored_path, quote=True)
                    return f'href="{new_href}"'

                return match.group(0)

            return re.sub(r'href="([^"]+)"', _replace_href, html_text)

        for block in _walk_blocks(blocks_tree):
            text_html = block.get('text') or ''
            if text_html:
                block['text'] = _resolve_md_assets(text_html)

    # После загрузки вложений разворачиваем wikilinks [[...]] в ссылки на статьи.
    for block in _walk_blocks(blocks_tree):
        text_html = block.get('text') or ''
        if text_html:
            block['text'] = _expand_wikilinks(text_html, current_user.id)

    article = {
        'id': new_article_id,
        'title': base_title,
        'createdAt': now,
        'updatedAt': now,
        'deletedAt': None,
        'blocks': blocks_tree,
        'history': [],
        'redoHistory': [],
        'authorId': current_user.id,
    }

    save_article(article)
    created = get_article(new_article_id, current_user.id)
    if not created:
        raise HTTPException(status_code=500, detail='Не удалось создать статью при импорте')
    return created

