from __future__ import annotations

import os
import re
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from ..auth import User, get_current_user
from ..data_store import get_articles
from ..export_utils import _build_backup_article_html, _inline_uploads_for_backup

router = APIRouter()

# Вынесено из app/main.py → app/routers/export.py
BASE_DIR = Path(__file__).resolve().parents[3]
CLIENT_DIR = BASE_DIR / "client"


# Вынесено из app/main.py → app/routers/export.py
@router.get('/api/export/html-zip')
def export_all_articles_html_zip(current_user: User = Depends(get_current_user)):
    """
    Формирует ZIP-архив со всеми статьями пользователя в виде HTML-файлов.
    Каждый HTML:
    - содержит структуру блоков и стили, похожие на основной интерфейс;
    - включает JSON-снапшот memus-export, совместимый с /api/import/html.
    """
    articles = [article for article in get_articles(current_user.id) if article]
    try:
        css_text = (CLIENT_DIR / 'style.css').read_text(encoding='utf-8')
    except OSError:
        css_text = ''

    buf = BytesIO()
    used_names: dict[str, int] = {}
    with zipfile.ZipFile(buf, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
        for article in articles:
            raw_title = (article.get('title') or '').strip() or 'article'
            # Мягкая санитаризация: убираем только заведомо «опасные» символы файловой системы.
            base = re.sub(r'[\\\\/:*?"<>|]+', '', raw_title).strip() or 'article'
            base = base[:80]
            filename = f'{base}.html'
            # Гарантируем уникальность имён в ZIP.
            if filename in used_names:
                used_names[filename] += 1
                stem, ext = os.path.splitext(filename)
                suffix = used_names[filename]
                filename = f'{stem} ({suffix}){ext}'
            else:
                used_names[filename] = 1
            html = _build_backup_article_html(article, css_text, lang='ru')
            # Делаем HTML самодостаточным: инлайн всех /uploads/ текущего пользователя.
            html = _inline_uploads_for_backup(html, current_user)
            zf.writestr(filename, html.encode('utf-8'))

    buf.seek(0)
    ts = datetime.utcnow().strftime('%Y%m%d-%H%M%S')
    zip_name = f'memus-backup-{ts}.zip'
    headers = {
        'Content-Disposition': f'attachment; filename=\"{zip_name}\"',
    }
    return Response(content=buf.getvalue(), media_type='application/zip', headers=headers)

