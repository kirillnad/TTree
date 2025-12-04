from __future__ import annotations

import os
import mimetypes
import logging
from datetime import datetime
from pathlib import Path, PurePath
from typing import Any
from uuid import uuid4
from io import BytesIO
import base64
import binascii
import json
import html as html_mod
import re
import zipfile
from pathlib import PurePosixPath
import urllib.parse
import urllib.request

import aiofiles
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    UploadFile,
    Request,
    Response,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .auth import (
    User,
    clear_session_cookie,
    create_session,
    create_user,
    ensure_superuser,
    get_current_user,
    get_user_by_id,
    get_user_by_username,
    set_session_cookie,
    verify_password,
)
from .db import CONN, IS_SQLITE, IS_POSTGRES
from . import db as db_module
from .data_store import (
    ArticleNotFound,
    BlockNotFound,
    InvalidOperation,
    create_article,
    delete_block,
    delete_article,
    ensure_sample_article,
    ensure_inbox_article,
    get_or_create_user_inbox,
    indent_block,
    insert_block,
    move_block,
    move_block_to_parent,
    outdent_block,
    redo_block_text_change,
    restore_article,
    restore_block,
    search_blocks,
    search_everything,
    move_block_to_article,
    undo_block_text_change,
    update_article_meta,
    update_block,
    update_block_collapse,
    get_articles,
    get_deleted_articles,
    get_article,
    create_attachment,
    save_article,
    rebuild_search_indexes,
    build_sqlite_fts_query,
    build_postgres_ts_query,
    delete_user_with_data,
    _expand_wikilinks,
    build_article_from_row,
)

BASE_DIR = Path(__file__).resolve().parents[2]
CLIENT_DIR = BASE_DIR / "client"
UPLOADS_DIR = BASE_DIR / 'uploads'
UPLOADS_DIR.mkdir(exist_ok=True, parents=True)
ALLOWED_ATTACHMENT_TYPES = {
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'application/rtf',
}

logger = logging.getLogger('uvicorn.error')

GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID') or ''
GOOGLE_CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET') or ''
GOOGLE_REDIRECT_URI = os.environ.get('GOOGLE_REDIRECT_URI') or 'https://memus.pro/api/auth/google/callback'
USERS_PANEL_PASSWORD = os.environ.get('USERS_PANEL_PASSWORD') or 'zZ141400'

# Состояние фоновых задач импорта Logseq (в памяти процесса).
LOGSEQ_IMPORT_TASKS: dict[str, dict[str, Any]] = {}

ensure_sample_article()
ensure_inbox_article()
# Полная перестройка поисковых индексов может занимать много времени
# на больших базах и замедлять запуск сервера, поэтому по умолчанию
# она отключена. При необходимости её можно включить через
# переменную окружения SERVPY_REBUILD_INDEXES_ON_STARTUP=1.
if os.environ.get('SERVPY_REBUILD_INDEXES_ON_STARTUP') == '1':
    rebuild_search_indexes()
# Гарантируем наличие суперпользователя kirill.
ensure_superuser('kirill', 'zZ141400', 'kirill')

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


def _decode_data_url(data_url: str) -> tuple[bytes, str]:
  """
  Разбирает data: URL и возвращает (bytes, mime_type).
  Ожидаем формат data:<mime>;base64,<payload>.
  """
  if not data_url.startswith('data:'):
      raise ValueError('Not a data: URL')
  try:
      header, b64data = data_url.split(',', 1)
  except ValueError as exc:
      raise ValueError('Invalid data: URL') from exc
  mime_type = 'application/octet-stream'
  meta = header[5:]  # после "data:"
  if ';' in meta:
      mime_type = meta.split(';', 1)[0] or mime_type
  elif meta:
      mime_type = meta
  try:
      raw = base64.b64decode(b64data, validate=True)
  except (ValueError, binascii.Error) as exc:
      raise ValueError('Invalid base64 payload in data: URL') from exc
  return raw, mime_type


_INTERNAL_ARTICLE_LINK_RE = re.compile(
    r'<a\s+([^>]*?)href="/article/([0-9a-fA-F-]+)"([^>]*)>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)

EXPORT_DESCRIPTION_LIMIT = 160


def _rewrite_internal_links_for_public(html_text: str) -> str:
    """
    В публичной статье внутренние ссылки на /article/<id> переписываем:
    - если у статьи есть public_slug, ведём на /p/<slug>;
    - иначе оставляем ссылку, но без перехода (href="#", data-unpublished="1").
    """
    if '/article/' not in (html_text or ''):
        return html_text

    cache: dict[str, str] = {}

    def _replace(match: re.Match[str]) -> str:
        before_attrs = match.group(1) or ''
        article_id = match.group(2)
        after_attrs = match.group(3) or ''
        inner_html = match.group(4) or ''
        if not article_id:
            return match.group(0)
        if article_id in cache:
            slug = cache[article_id]
        else:
            row = CONN.execute(
                'SELECT public_slug FROM articles WHERE id = ? AND deleted_at IS NULL',
                (article_id,),
            ).fetchone()
            slug = (row['public_slug'] or '') if row and row['public_slug'] else ''
            cache[article_id] = slug
        if not slug:
            # Целевая статья не опубликована — оставляем "пустую" ссылку с пометкой.
            return f'<a {before_attrs}href="#" data-unpublished="1"{after_attrs}>{inner_html}</a>'
        href = f'/p/{slug}'
        return f'<a {before_attrs}href="{href}"{after_attrs}>{inner_html}</a>'

    return _INTERNAL_ARTICLE_LINK_RE.sub(_replace, html_text or '')


def _collect_plain_text_from_blocks(blocks: list[dict[str, Any]] | None) -> list[str]:
    """
    Собирает простой текст из дерева блоков статьи:
    - вычищает HTML-теги;
    - схлопывает повторяющиеся пробелы.
    Используется для описания и wordCount в экспортируемых HTML.
    """
    result: list[str] = []

    def _walk(nodes: list[dict[str, Any]] | None) -> None:
        if not nodes:
            return
        for blk in nodes:
            if not isinstance(blk, dict):
                continue
            raw = blk.get('text') or ''
            if raw:
                # Грубое удаление тегов + unescape, этого достаточно для описания.
                plain = re.sub(r'<[^>]+>', ' ', raw)
                plain = html_mod.unescape(plain)
                plain = ' '.join(plain.split())
                if plain:
                    result.append(plain)
            children = blk.get('children') or []
            if children:
                _walk(children)

    _walk(blocks or [])
    return result


def _build_export_description(plain_text: str | None) -> str:
    """
    Строит короткое описание статьи (meta description) по первым символам текста.
    """
    if not plain_text:
        return ''
    snippet = ' '.join(plain_text.split())
    if len(snippet) <= EXPORT_DESCRIPTION_LIMIT:
        return snippet
    return f'{snippet[:EXPORT_DESCRIPTION_LIMIT].rstrip()}…'


def _serialize_blocks_for_export(blocks: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """
    Приводит дерево блоков к тому же формату, который использует клиентский exporter.js
    в buildExportPayload: id/text/collapsed/children.
    """
    if not blocks:
        return []
    result: list[dict[str, Any]] = []
    for blk in blocks:
        if not isinstance(blk, dict):
            continue
        children = blk.get('children') or []
        result.append(
            {
                'id': blk.get('id'),
                'text': blk.get('text') or '',
                'collapsed': bool(blk.get('collapsed')),
                'children': _serialize_blocks_for_export(children),
            },
        )
    return result


def _build_export_payload_for_article(article: dict[str, Any] | None) -> dict[str, Any]:
    """
    Формирует JSON-снапшот memus-export в формате, совместимом с client/exporter.js.
    Этот блок попадает в <script type="application/json" id="memus-export">...</script>.
    """
    if not article:
        return {
            'version': 1,
            'source': 'memus',
            'article': None,
            'blocks': [],
        }

    article_id = article.get('id') or ''
    author_id = article.get('authorId') or ''
    # inbox в базе имеет вид inbox-<userId>, в экспорте достаточно флажка.
    is_inbox = article_id == 'inbox' or (
        isinstance(article_id, str)
        and isinstance(author_id, str)
        and article_id == f'inbox-{author_id}'
    )

    meta = {
        'id': article_id,
        'title': article.get('title') or '',
        'createdAt': article.get('createdAt') or None,
        'updatedAt': article.get('updatedAt') or None,
        'deletedAt': article.get('deletedAt') or None,
        'isInbox': bool(is_inbox),
        'encrypted': bool(article.get('encrypted')),
        'encryptionHint': article.get('encryptionHint') or None,
    }

    return {
        'version': 1,
        'source': 'memus',
        'article': meta,
        'blocks': _serialize_blocks_for_export(article.get('blocks') or []),
    }


def _import_image_from_data_url(data_url: str, current_user: User) -> str:
    """
    Сохраняет картинку из data: URL в uploads так же, как upload_file:
    конвертирует её в WebP с качеством 75. Возвращает относительный URL /uploads/...
    """
    raw, mime_type = _decode_data_url(data_url)
    now = datetime.utcnow()
    user_root = UPLOADS_DIR / current_user.id / 'images'
    target_dir = user_root / str(now.year) / f"{now.month:02}"
    target_dir.mkdir(parents=True, exist_ok=True)
    # По умолчанию сохраняем в WebP.
    filename = f"{int(now.timestamp()*1000)}-{os.urandom(4).hex()}.webp"
    dest = target_dir / filename

    buffer = BytesIO(raw)
    try:
        img = Image.open(buffer)
        max_width = 1920
        if img.width > max_width:
            new_height = int(img.height * max_width / img.width)
            img = img.resize((max_width, max(new_height, 1)), Image.Resampling.LANCZOS)

        if img.mode in ('RGBA', 'LA', 'P'):
            img = img.convert('RGBA')
        else:
            img = img.convert('RGB')

        out_buf = BytesIO()
        img.save(out_buf, 'WEBP', quality=75, method=6)
        out_bytes = out_buf.getvalue()
        dest.write_bytes(out_bytes)
    except Exception:
        # Если Pillow не смог прочитать — сохраняем как есть с исходным расширением.
        ext = mimetypes.guess_extension(mime_type) or ''
        fallback_name = f"{int(now.timestamp()*1000)}-{os.urandom(4).hex()}{ext}"
        dest = target_dir / fallback_name
        dest.write_bytes(raw)
    rel = dest.relative_to(UPLOADS_DIR).as_posix()
    return f"/uploads/{rel}"


def _import_attachment_from_bytes(
    raw: bytes,
    mime_type: str,
    current_user: User,
    article_id: str,
    display_name: str | None = None,
) -> str:
    """
    Сохраняет бинарные данные вложения в uploads/attachments и создаёт запись в БД.
    Возвращает относительный URL /uploads/...
    """
    target_dir = UPLOADS_DIR / current_user.id / 'attachments' / article_id
    target_dir.mkdir(parents=True, exist_ok=True)
    base_name = (display_name or 'attachment').strip() or 'attachment'
    safe_base = ''.join(ch if ch.isalnum() or ch in '._- ' else '_' for ch in base_name)[:80] or 'attachment'
    ext = mimetypes.guess_extension(mime_type) or ''
    filename = f"{safe_base}{ext}"
    # избегаем коллизий
    counter = 1
    dest = target_dir / filename
    while dest.exists():
        filename = f"{safe_base}-{counter}{ext}"
        dest = target_dir / filename
        counter += 1
    dest.write_bytes(raw)
    stored_path = f'/uploads/{current_user.id}/attachments/{article_id}/{filename}'
    create_attachment(article_id, stored_path, filename, mime_type or '', len(raw))
    return stored_path


def _import_attachment_from_data_url(data_url: str, current_user: User, article_id: str, display_name: str | None = None) -> str:
    """
    Сохраняет вложение из data: URL в uploads/attachments и создаёт запись в БД.
    Возвращает относительный URL /uploads/...
    """
    raw, mime_type = _decode_data_url(data_url)
    return _import_attachment_from_bytes(raw, mime_type, current_user, article_id, display_name)


def _parse_memus_export_payload(html_text: str) -> dict[str, Any]:
    """
    Извлекает JSON-снапшот из <script id=\"memus-export\">...</script>.
    """
    start_marker = 'id="memus-export"'
    alt_marker = "id='memus-export'"
    idx = html_text.find(start_marker)
    if idx == -1:
        idx = html_text.find(alt_marker)
    if idx == -1:
        raise ValueError('Не найден блок memus-export')
    # Находим начало содержимого тега <script ...>
    script_open = html_text.rfind('<script', 0, idx)
    if script_open == -1:
        raise ValueError('Некорректная разметка memus-export (нет <script>)')
    script_close = html_text.find('</script>', idx)
    if script_close == -1:
        raise ValueError('Некорректная разметка memus-export (нет </script>)')
    content_start = html_text.find('>', script_open) + 1
    raw_json = html_text[content_start:script_close].strip()
    if not raw_json:
        raise ValueError('Пустой блок memus-export')
    try:
        payload = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ValueError('Не удалось разобрать JSON memus-export') from exc
    if not isinstance(payload, dict):
        raise ValueError('Некорректный формат memus-export')
    if payload.get('source') != 'memus' or int(payload.get('version', 0)) != 1:
        raise ValueError('Этот HTML не похож на экспорт Memus поддерживаемой версии')
    return payload


def _extract_block_body_html(full_html: str, block_id: str) -> str | None:
    """
    Находит HTML содержимого блока (заголовок + тело) по его data-block-id
    в документе экспорта. Используется как best-effort парсер на основе поиска по строке.
    """
    marker = f'data-block-id="{block_id}"'
    idx = full_html.find(marker)
    if idx == -1:
        return None
    # Ищем ближайший div.block-body после блока
    body_marker = '<div class="block-text block-body'
    body_idx = full_html.find(body_marker, idx)
    if body_idx == -1:
        # более общий случай
        body_marker = 'class="block-text block-body'
        body_idx = full_html.find(body_marker, idx)
        if body_idx == -1:
            return None
    start_tag_end = full_html.find('>', body_idx)
    if start_tag_end == -1:
        return None
    # Находим соответствующий закрывающий </div> для этого блока body с учётом вложенных div.
    pos = start_tag_end + 1
    depth = 1
    while depth > 0 and pos < len(full_html):
        next_open = full_html.find('<div', pos)
        next_close = full_html.find('</div>', pos)
        if next_close == -1:
            break
        if next_open != -1 and next_open < next_close:
            depth += 1
            pos = next_open + 4
        else:
            depth -= 1
            pos = next_close + len('</div>')
    if depth != 0:
        return None
    body_inner = full_html[start_tag_end + 1 : pos - len('</div>')]

    # Пытаемся дополнительно захватить заголовок блока (div.block-title), если он есть.
    title_inner = ''
    title_marker = '<div class="block-title">'
    if body_idx != -1:
        title_idx = full_html.find(title_marker, idx, body_idx)
        if title_idx != -1:
            title_start_tag_end = full_html.find('>', title_idx)
            if title_start_tag_end != -1:
                t_pos = title_start_tag_end + 1
                t_depth = 1
                while t_depth > 0 and t_pos < len(full_html):
                    t_next_open = full_html.find('<div', t_pos)
                    t_next_close = full_html.find('</div>', t_pos)
                    if t_next_close == -1:
                        break
                    if t_next_open != -1 and t_next_open < t_next_close:
                        t_depth += 1
                        t_pos = t_next_open + 4
                    else:
                        t_depth -= 1
                        t_pos = t_next_close + len('</div>')
                if t_depth == 0:
                    title_inner = full_html[title_start_tag_end + 1 : t_pos - len('</div>')]

    return f'{title_inner}{body_inner}'


def _process_block_html_for_import(
    html_text: str,
    block_id: str,
    current_user: User,
    article_id: str,
) -> str:
    """
    Возвращает HTML блока с обновлёнными src/href для data: URL,
    сохраняя остальное содержимое как есть.
    """
    body_html = _extract_block_body_html(html_text, block_id) or ''
    # Обрабатываем data: URL "в лоб": заменяем их по мере нахождения.
    result = body_html
    search_pos = 0
    while True:
        # Ищем src="data:..." или href="data:..."
        src_idx = result.find('src="data:', search_pos)
        href_idx = result.find('href="data:', search_pos)
        if src_idx == -1 and href_idx == -1:
            break
        if src_idx != -1 and (href_idx == -1 or src_idx < href_idx):
            attr = 'src'
            idx = src_idx
        else:
            attr = 'href'
            idx = href_idx
        url_start = result.find('"', idx) + 1
        url_end = result.find('"', url_start)
        if url_start == 0 or url_end == -1:
            break
        data_url = result[url_start:url_end]

        # Пытаемся сначала использовать исходный путь до uploads, если он есть и доступен текущему пользователю.
        # Для этого ищем data-original-src / data-original-href в пределах текущего тега.
        tag_end = result.find('>', idx)
        if tag_end == -1:
            break
        tag_chunk = result[idx:tag_end]

        original_attr = 'data-original-src' if attr == 'src' else 'data-original-href'
        original_url: str | None = None
        marker = f'{original_attr}="'
        m_idx = tag_chunk.find(marker)
        if m_idx != -1:
            val_start = m_idx + len(marker)
            val_end = tag_chunk.find('"', val_start)
            if val_end != -1:
                original_url = tag_chunk[val_start:val_end]

        new_url = ''
        if original_url and original_url.startswith('/uploads/'):
            # Проверяем, что путь принадлежит текущему пользователю и файл существует.
            rel = original_url[len('/uploads/') :].lstrip('/')
            parts = PurePosixPath(rel).parts
            if parts and parts[0] == current_user.id:
                candidate_path = UPLOADS_DIR / PurePosixPath(rel)
                if candidate_path.is_file():
                    new_url = original_url

        # Если не удалось переиспользовать исходный файл, распаковываем data: URL как раньше.
        if not new_url:
            try:
                if attr == 'src':
                    new_url = _import_image_from_data_url(data_url, current_user)
                else:
                    # Для href пытаемся угадать имя по ближайшему тексту не будем — оставим generic.
                    new_url = _import_attachment_from_data_url(data_url, current_user, article_id)
            except Exception:
                new_url = ''
        if new_url:
            result = result[:url_start] + new_url + result[url_end:]
            search_pos = url_start + len(new_url)
        else:
            search_pos = url_end + 1
    return result


def _md_bold_to_html(text: str) -> str:
    """Обработка **жирного** текста внутри обычной строки."""
    if not text:
        return ''
    result: list[str] = []
    last = 0
    pattern = re.compile(r'\*\*(.+?)\*\*')
    for match in pattern.finditer(text):
        before = text[last : match.start()]
        if before:
            result.append(html_mod.escape(before, quote=False))
        inner = match.group(1) or ''
        result.append(f'<strong>{html_mod.escape(inner, quote=False)}</strong>')
        last = match.end()
    tail = text[last:]
    if tail:
        result.append(html_mod.escape(tail, quote=False))
    return ''.join(result)


def _md_inline_to_html(text: str) -> str:
    """
    Простой Markdown-инлайн:
    - **жирный** -> <strong>жирный</strong>
    - ![alt](url):
      - если url начинается с http/https — обычная ссылка;
      - иначе считаем вложением и оформляем как .attachment-link.
    """
    if not text:
        return ''

    result: list[str] = []
    last = 0
    img_pattern = re.compile(r'!\[([^\]]*)]\(([^)]+)\)')

    for match in img_pattern.finditer(text):
        before = text[last : match.start()]
        if before:
            result.append(_md_bold_to_html(before))

        alt_raw = match.group(1) or ''
        url_raw = (match.group(2) or '').strip()
        if not url_raw:
            last = match.end()
            continue

        url_escaped = html_mod.escape(url_raw, quote=True)
        alt_escaped = html_mod.escape(alt_raw, quote=False) if alt_raw else ''

        if url_raw.startswith(('http://', 'https://')):
            label = alt_escaped or url_escaped
            result.append(
                f'<a href="{url_escaped}" target="_blank" rel="noopener noreferrer">{label}</a>'
            )
        else:
            # Относительный путь: считаем вложением, отображаем как ссылку.
            filename = url_raw.rsplit('/', 1)[-1] or url_raw
            label = alt_escaped or html_mod.escape(filename, quote=False)
            result.append(
                f'<a href="{url_escaped}" class="attachment-link" target="_blank" '
                f'rel="noopener noreferrer">{label}</a>'
            )

        last = match.end()

    tail = text[last:]
    if tail:
        result.append(_md_bold_to_html(tail))
    return ''.join(result)


def _build_block_html_from_md_lines(lines: list[str]) -> str:
    """
    Собирает HTML блока из списка строк Markdown с учётом правил:
    - строки с **...** -> <strong>...</strong>
    - первая строка, начинающаяся с #..####, становится заголовком блока;
      после неё вставляется пустая строка (разделитель заголовка и тела).
    """
    if not lines:
        return ''

    # Обрезаем хвостовые пустые строки
    while lines and not (lines[-1] or '').strip():
        lines.pop()
    if not lines:
        return ''

    paragraphs: list[str] = []
    first = lines[0].strip()
    heading_match = re.match(r'^(#{1,4})\s*(.+)$', first)

    if heading_match:
        title_text = heading_match.group(2).strip()
        paragraphs.append(f'<p>{_md_inline_to_html(title_text)}</p>')
        # Пустая строка-разделитель, чтобы заголовок стал titleHtml
        paragraphs.append('<p><br /></p>')
        rest_lines = lines[1:]
    else:
        paragraphs.append(f'<p>{_md_inline_to_html(first)}</p>')
        rest_lines = lines[1:]

    # Пробуем распознать Markdown-таблицу вида:
    # |col1|col2|
    # |---|---|
    # |v1|v2|
    table_mode = False
    table_rows: list[list[str]] = []

    def flush_table() -> None:
        nonlocal table_mode, table_rows
        if not table_mode or not table_rows:
            table_mode = False
            table_rows = []
            return
        # Первая строка — заголовки, остальные — строки тела.
        header = table_rows[0]
        body = table_rows[1:] or []
        col_count = max(len(header), *(len(r) for r in body)) if body else len(header)
        # Усреднённые ширины колонок в процентах.
        width = 100.0 / max(col_count, 1)
        colgroup_parts = [f'<col width="{width:.4f}%"/>' for _ in range(col_count)]

        parts: list[str] = []
        parts.append('<table class="memus-table"><colgroup>')
        parts.extend(colgroup_parts)
        parts.append('</colgroup><thead><tr>')
        for cell in header:
            parts.append(f'<th>{_md_inline_to_html(cell.strip())}</th>')
        parts.append('</tr></thead><tbody>')
        for row in body:
            parts.append('<tr>')
            # Дополняем недостающие ячейки пустыми.
            cells = list(row) + [''] * (col_count - len(row))
            for cell in cells:
                parts.append(f'<td>{_md_inline_to_html((cell or "").strip())}</td>')
            parts.append('</tr>')
        parts.append('</tbody></table>')
        paragraphs.append(''.join(parts))
        table_mode = False
        table_rows = []

    def is_table_row(line: str) -> bool:
        stripped = line.strip()
        return stripped.startswith('|') and '|' in stripped[1:]

    for raw in rest_lines:
        if not raw.strip():
            # Пустая строка завершает таблицу, если она идёт.
            if table_mode:
                flush_table()
            paragraphs.append('<p><br /></p>')
            continue

        if is_table_row(raw):
            # Продолжаем или начинаем таблицу.
            table_mode = True
            # Разбиваем по |, отбрасывая крайние пустые элементы, если строка начинается/заканчивается "|".
            stripped = raw.strip()
            inner = stripped[1:-1] if stripped.endswith('|') else stripped[1:]
            cells = [cell.strip() for cell in inner.split('|')]
            table_rows.append(cells)
            continue

        # Обычная строка — перед ней нужно, если было, завершить таблицу.
        if table_mode:
            flush_table()
        paragraphs.append(f'<p>{_md_inline_to_html(raw.strip())}</p>')

    # Завершаем возможную таблицу в конце.
    if table_mode:
        flush_table()

    return ''.join(paragraphs)


def _parse_markdown_blocks(md_text: str) -> list[dict[str, Any]]:
    """
    Парсер простого Markdown-списка в дерево блоков.

    Правила:
    - каждый блок начинается с новой строки и символа "-" (после табов);
      ИЛИ с новой строки без табов, которая не начинается с "-";
    - уровень вложенности определяется количеством табов перед "-";
    - строки, начинающиеся (после табов) с "collapsed::" игнорируются;
    - остальные строки без "-" считаются продолжением предыдущего блока.
    """
    lines = md_text.splitlines()
    # Предобработка служебных маркеров collapsed::/logseq.
    # Шаблон Logseq:
    #   - collapsed:: true
    #     1. Текст
    # Нужно превратить в:
    #   - 1. Текст
    processed_lines: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # Отделяем табы (уровень вложенности), остальное анализируем.
        indent_tabs = 0
        for ch in line:
            if ch == '\t':
                indent_tabs += 1
            else:
                break
        content = line[indent_tabs:]
        stripped = content.lstrip()

        # Полностью пропускаем строки-конфиги Logseq.
        if stripped.startswith('logseq.'):
            i += 1
            continue

        # Случай "- collapsed:: true/false" или похожий.
        if stripped.startswith('-') and 'collapsed::' in stripped:
            # Если есть следующая строка — сливаем её в текст пункта.
            if i + 1 < len(lines):
                next_line = lines[i + 1]
                # Текст следующей строки без табов/пробелов в начале.
                next_content = next_line.lstrip('\t')
                next_content = next_content.lstrip(' ')
                indent_prefix = '\t' * indent_tabs
                merged = f"{indent_prefix}- {next_content}"
                processed_lines.append(merged)
                i += 2
                continue
            # Иначе просто пропускаем маркер.
            i += 1
            continue

        # Любые одиночные строки с collapsed:: (без "-") просто выкидываем.
        if 'collapsed::' in stripped:
            i += 1
            continue

        processed_lines.append(line)
        i += 1

    lines = processed_lines
    root_blocks: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []  # элементы: {'level', 'block', 'lines'}

    def finish_block(node: dict[str, Any] | None) -> None:
        if not node:
            return
        html_text = _build_block_html_from_md_lines(node.get('lines') or [])
        node['block']['text'] = html_text

    current: dict[str, Any] | None = None

    for raw_line in lines:
        if not raw_line.strip():
            # Пустая строка — продолжение текущего блока
            if current is not None:
                current.setdefault('lines', []).append('')
            continue

        # Уровень = количество табов перед первым нетабовым символом
        indent_tabs = 0
        for ch in raw_line:
            if ch == '\t':
                indent_tabs += 1
            else:
                break
        content = raw_line[indent_tabs:]

        stripped_for_ctrl = content.lstrip()

        # Новая строка без табов и без начального "-" — отдельный корневой блок.
        # Это позволяет импортировать заголовки / нумерованные пункты вида "1. Текст"
        # как отдельные блоки верхнего уровня.
        if indent_tabs == 0 and stripped_for_ctrl and not stripped_for_ctrl.startswith('-'):
            finish_block(current)
            new_block: dict[str, Any] = {
                'id': str(uuid4()),
                'text': '',
                'collapsed': False,
                'children': [],
            }
            node = {
                'level': 0,
                'block': new_block,
                'lines': [stripped_for_ctrl],
            }
            root_blocks.append(new_block)
            stack = [node]
            current = node
            continue

        # Новая строка-блок?
        if stripped_for_ctrl.startswith('-'):
            # Закончили предыдущий блок
            finish_block(current)

            # Текст после "-".
            after_dash = stripped_for_ctrl[1:].lstrip()
            new_block: dict[str, Any] = {
                'id': str(uuid4()),
                'text': '',
                'collapsed': False,
                'children': [],
            }
            node = {
                'level': indent_tabs,
                'block': new_block,
                'lines': [after_dash],
            }

            # Ищем родителя по уровню
            while stack and stack[-1]['level'] >= indent_tabs:
                stack.pop()
            if stack:
                stack[-1]['block'].setdefault('children', []).append(new_block)
            else:
                root_blocks.append(new_block)
            stack.append(node)
            current = node
        else:
            # Обычная строка — продолжение текущего блока
            if current is not None:
                current.setdefault('lines', []).append(content.strip())

    # Последний блок
    finish_block(current)

    return root_blocks


def _walk_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Плоский обход дерева блоков для постобработки."""
    result: list[dict[str, Any]] = []
    stack = list(blocks or [])
    while stack:
        block = stack.pop()
        result.append(block)
        children = block.get('children') or []
        stack.extend(children)
    return result


def _strip_html_tags(html_text: str) -> str:
    """Грубое удаление HTML-тегов для извлечения текстового заголовка."""
    if not html_text:
        return ''
    # Удаляем теги и декодируем сущности.
    text = re.sub(r'<[^>]+>', '', html_text)
    return html_mod.unescape(text).strip()


def _resolve_article_id_for_user(article_id: str, current_user: User) -> str:
    """
    Преобразует «публичный» идентификатор статьи из URL в фактический ID в БД.
    Для inbox клиент всегда использует article_id == "inbox", а в базе хранится
    отдельная статья на пользователя с ID вида "inbox-<user_id>".
    """
    if article_id == 'inbox':
        inbox_article = get_or_create_user_inbox(current_user.id)
        return inbox_article['id']
    return article_id


def _generate_public_slug() -> str:
    """
    Генерирует уникальный короткий slug для публичной ссылки на статью.
    Используем urlsafe base64 от случайных байт и обрезаем до 10 символов.
    """
    while True:
        raw = os.urandom(8)
        candidate = base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=\n')[:10]
        row = CONN.execute(
            'SELECT 1 FROM articles WHERE public_slug = ?',
            (candidate,),
        ).fetchone()
        if not row:
            return candidate


def _render_public_block(block: dict[str, Any]) -> str:
    """
    Простая HTML-версия блока для публичной страницы.
    Используем ту же разметку .block / .block-surface / .block-content / .block-text,
    но без интерактивных кнопок и drag-элементов.
    """
    raw_html = block.get('text') or ''
    children = block.get('children') or []
    has_children = bool(children)
    collapsed = bool(block.get('collapsed'))
    block_id = html_mod.escape(str(block.get('id') or ''))

    # Грубое разбиение stored HTML на заголовок и тело по первому <p><br /></p>,
    # как это делает buildStoredBlockHtml/extractBlockSections в клиенте.
    title_html = ''
    body_html = raw_html
    for sep in ('<p><br /></p>', '<p><br/></p>', '<p><br></p>'):
        idx = raw_html.find(sep)
        if idx != -1:
            title_html = raw_html[:idx]
            body_html = raw_html[idx + len(sep) :]
            break
    has_title = bool(title_html.strip())

    # Кнопка сворачивания как в экспорте: с data-block-id и aria-expanded.
    if has_children or raw_html:
        collapse_btn = (
            f'<button class="collapse-btn" type="button" '
            f'data-block-id="{block_id}" aria-expanded="{ "false" if collapsed else "true" }"></button>'
        )
    else:
        collapse_btn = (
            '<button class="collapse-btn collapse-btn--placeholder" type="button" '
            'aria-hidden="true"></button>'
        )

    # Заголовок блока (если есть).
    header_html = ''
    if has_title:
        header_html = (
            '<div class="block-header">'
            '<div class="block-header__left">'
            '<div class="block-title" style="flex: 1 1 0%; min-width: 0px;">'
            f'{title_html}'
            '</div>'
            '</div>'
            '</div>'
        )

    body_classes = ['block-text', 'block-body']
    if not has_title:
        body_classes.append('block-body--no-title')
    # Для блоков с заголовком в свёрнутом состоянии скрываем тело (как в экспорте):
    if has_title and collapsed:
        body_classes.append('collapsed')
    body = f'<div class="{" ".join(body_classes)}" data-block-body>{body_html}</div>'
    content = f'<div class="block-content">{header_html}{body}</div>'
    surface = f'<div class="block-surface">{collapse_btn}{content}</div>'

    children_html = ''.join(_render_public_block(child) for child in children)
    if children_html:
        children_classes = ['block-children']
        if collapsed:
            children_classes.append('collapsed')
        children_container = f'<div class="{" ".join(children_classes)}" data-children>{children_html}</div>'
    else:
        children_container = ''

    block_classes = ['block']
    if not has_title:
        block_classes.append('block--no-title')

    return (
        f'<div class="{" ".join(block_classes)}" data-block-id="{block_id}" '
        f'data-collapsed="{"true" if collapsed else "false"}" tabindex="0">'
        f'{surface}{children_container}</div>'
    )


def _build_public_article_html(article: dict[str, Any]) -> str:
    """
    Собирает минимальную HTML-страницу для публичного просмотра статьи.
    Использует базовые стили /style.css и ту же структуру блоков, что и экспорт.
    """
    title = html_mod.escape(article.get('title') or 'Без названия')
    updated_raw = article.get('updatedAt') or article.get('updated_at')
    try:
        updated_label = (
            datetime.fromisoformat(updated_raw).strftime('%Y-%m-%d %H:%M:%S')
            if updated_raw
            else ''
        )
    except Exception:  # noqa: BLE001
        updated_label = updated_raw or ''

    # Перед рендерингом переписываем внутренние ссылки /article/<id> в тексте блоков.
    def _walk_and_rewrite(blocks: list[dict[str, Any]] | None) -> None:
        if not blocks:
            return
        for b in blocks:
            if not isinstance(b, dict):
                continue
            text_html = b.get('text') or ''
            if text_html:
                b['text'] = _rewrite_internal_links_for_public(text_html)
            _walk_and_rewrite(b.get('children'))

    blocks = article.get('blocks') or []
    _walk_and_rewrite(blocks)
    blocks_html = ''.join(_render_public_block(b) for b in blocks)
    header = f"""
    <div class="panel-header article-header">
      <div class="title-block">
        <div class="title-row">
          <h1 class="export-title">{title}</h1>
        </div>
        {f'<p class="meta">Обновлено: {html_mod.escape(updated_label)}</p>' if updated_label else ''}
        <p class="meta">Публичная страница Memus (только для чтения)</p>
      </div>
    </div>
    """
    body_inner = f"""
    <div class="export-shell" aria-label="Публичная статья">
      <main class="content export-content">
        <section class="panel export-panel" aria-label="Статья">
          {header}
          <div id="exportBlocksRoot" class="blocks" role="tree">
            {blocks_html}
          </div>
        </section>
      </main>
    </div>
    """

    # Берём тот же extraCss, что и экспорт HTML в exporter.js
    extra_css = """
    body.export-page {
      margin: 0;
      background: #eef2f8;
      overflow: auto;
      height: auto;
    }
    .export-shell {
      min-height: 100vh;
      display: flex;
      justify-content: center;
      background: #eef2f8;
    }
    .export-content {
      padding: 1.5rem 1rem 2rem;
      width: 100%;
      max-width: 960px;
    }
    .export-panel {
      min-height: auto;
      height: auto;
    }
    .block-children.collapsed {
      display: none;
    }
    .block {
      cursor: default;
    }
    .export-title {
      margin: 0;
    }
    """

    # Загружаем тот же style.css, что и SPA.
    try:
        css_text = (CLIENT_DIR / 'style.css').read_text(encoding='utf-8')
    except OSError:
        css_text = ''

    interactions_script = """
    <script>
(function() {
  var root = document.getElementById('exportBlocksRoot');
  if (!root) return;
  var collapseIcon = { open: '▾', closed: '▸' };
  var firstBlock = root.querySelector('.block');
  var currentId = firstBlock ? firstBlock.getAttribute('data-block-id') : null;

  function getParentBlock(block) {
    if (!block || !block.parentElement) return null;
    return block.parentElement.closest('.block');
  }

  function updateBlockView(block, collapsed) {
    block.dataset.collapsed = collapsed ? 'true' : 'false';
    var body = block.querySelector('.block-body');
    var noTitle = block.classList.contains('block--no-title');
    if (body && !noTitle) {
      body.classList.toggle('collapsed', collapsed);
    }
    var children = block.querySelector('.block-children');
    if (children) children.classList.toggle('collapsed', collapsed);
    var btn = block.querySelector('.collapse-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.textContent = collapsed ? collapseIcon.closed : collapseIcon.open;
    }
  }

  function collectVisible() {
    var result = [];
    function walk(container) {
      var children = container.children;
      for (var i = 0; i < children.length; i += 1) {
        var node = children[i];
        if (!node.classList || !node.classList.contains('block')) continue;
        result.push(node);
        var isCollapsed = node.dataset.collapsed === 'true';
        var kids = node.querySelector('.block-children');
        if (!isCollapsed && kids) walk(kids);
      }
    }
    walk(root);
    return result;
  }

  function setCurrent(block) {
    if (!block) return;
    currentId = block.getAttribute('data-block-id') || null;
    Array.prototype.forEach.call(
      root.querySelectorAll('.block.selected'),
      function(el) { el.classList.remove('selected'); }
    );
    block.classList.add('selected');
    block.focus({ preventScroll: false });
  }

  function toggleBlock(block, desired) {
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    var next = typeof desired === 'boolean' ? desired : !collapsed;
    updateBlockView(block, next);
  }

  function moveSelection(offset) {
    if (!currentId) {
      var first = root.querySelector('.block');
      if (first) setCurrent(first);
      return;
    }
    var ordered = collectVisible();
    var index = -1;
    for (var i = 0; i < ordered.length; i += 1) {
      if (ordered[i].getAttribute('data-block-id') === currentId) {
        index = i;
        break;
      }
    }
    if (index === -1) return;
    var next = ordered[index + offset];
    if (next) setCurrent(next);
  }

  function handleArrowLeft() {
    if (!currentId) return;
    var block = root.querySelector('.block[data-block-id=\"' + currentId + '\"]');
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    if (!collapsed) {
      toggleBlock(block, true);
      return;
    }
    var parent = getParentBlock(block);
    if (parent) setCurrent(parent);
  }

  function handleArrowRight() {
    if (!currentId) return;
    var block = root.querySelector('.block[data-block-id=\"' + currentId + '\"]');
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    var firstChild = block.querySelector('.block-children .block');
    if (collapsed) {
      toggleBlock(block, false);
      if (firstChild) setCurrent(firstChild);
      return;
    }
    if (firstChild) {
      setCurrent(firstChild);
    }
  }

  root.addEventListener('click', function(event) {
    var unpublished = event.target.closest('a[data-unpublished="1"]');
    if (unpublished) {
      event.preventDefault();
      alert('Эта страница пока не опубликована');
      return;
    }
    var btn = event.target.closest('.collapse-btn');
    if (btn) {
      var targetId = btn.getAttribute('data-block-id');
      var block = root.querySelector('.block[data-block-id=\"' + targetId + '\"]');
      toggleBlock(block);
      setCurrent(block);
      return;
    }
    var block = event.target.closest('.block');
    if (block) {
      setCurrent(block);
    }
  });

  document.addEventListener('keydown', function(event) {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', ' '].indexOf(event.code) !== -1) {
      event.preventDefault();
    } else {
      return;
    }
    if (event.code === 'ArrowDown') {
      moveSelection(1);
      return;
    }
    if (event.code === 'ArrowUp') {
      moveSelection(-1);
      return;
    }
    if (event.code === 'ArrowLeft') {
      handleArrowLeft();
      return;
    }
    if (event.code === 'ArrowRight') {
      handleArrowRight();
      return;
    }
    if (event.code === 'Enter' || event.code === 'Space' || event.code === ' ') {
      if (!currentId) return;
      var block = root.querySelector('.block[data-block-id=\"' + currentId + '\"]');
      toggleBlock(block);
    }
  });

  if (firstBlock) setCurrent(firstBlock);
})();
    </script>
    """

    html = f"""<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
{css_text}
{extra_css}
    </style>
  </head>
  <body class="export-page">
    {body_inner}
    {interactions_script}
  </body>
</html>
"""
    return html


def _build_backup_article_html(article: dict[str, Any], css_text: str, lang: str = 'ru') -> str:
    """
    Собирает полноценный HTML-документ для резервной копии одной статьи:
    - структура блоков и стили такие же, как у клиентского экспорта;
    - внутрь помещается JSON-снапшот memus-export, совместимый с импортом /api/import/html;
    - внутренние ссылки остаются как есть (без переписывания под /p/<slug>).
    """
    title_raw = article.get('title') or 'Без названия'
    title = html_mod.escape(title_raw)
    updated_raw = article.get('updatedAt') or ''
    created_raw = article.get('createdAt') or updated_raw or ''

    # Текст и статистика для description/JSON-LD.
    plain_parts = _collect_plain_text_from_blocks(article.get('blocks') or [])
    plain_text = ' '.join(plain_parts).strip()
    word_count = len(plain_text.split()) if plain_text else 0
    description = _build_export_description(plain_text) or title_raw

    # Человеко-читаемая дата обновления для заголовка.
    try:
        updated_label = (
            datetime.fromisoformat(updated_raw).strftime('%Y-%m-%d %H:%M:%S')
            if updated_raw
            else ''
        )
    except Exception:  # noqa: BLE001
        updated_label = updated_raw or ''

    blocks = article.get('blocks') or []
    blocks_html = ''.join(_render_public_block(b) for b in blocks)
    header = f"""
    <div class="panel-header article-header">
      <div class="title-block">
        <div class="title-row">
          <h1 class="export-title">{title}</h1>
        </div>
        {f'<p class="meta">Обновлено: {html_mod.escape(updated_label)}</p>' if updated_label else ''}
      </div>
    </div>
    """
    body_inner = f"""
    <div class="export-shell" aria-label="Экспорт статьи">
      <main class="content export-content">
        <section class="panel export-panel" aria-label="Статья">
          {header}
          <div id="exportBlocksRoot" class="blocks" role="tree">
            {blocks_html}
          </div>
        </section>
      </main>
    </div>
    """

    # Те же базовые стили, что и в публичной версии / клиентском экспорте.
    extra_css = """
    body.export-page {
      margin: 0;
      background: #eef2f8;
      overflow: auto;
      height: auto;
    }
    .export-shell {
      min-height: 100vh;
      display: flex;
      justify-content: center;
      background: #eef2f8;
    }
    .export-content {
      padding: 1.5rem 1rem 2rem;
      width: 100%;
      max-width: 960px;
    }
    .export-panel {
      min-height: auto;
      height: auto;
    }
    .block-children.collapsed {
      display: none;
    }
    .block {
      cursor: default;
    }
    .export-title {
      margin: 0;
    }
    """

    # JSON-LD, как в client/exporter.js.
    json_ld = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        'headline': title_raw,
        'description': description,
        'dateModified': updated_raw or '',
        'datePublished': created_raw or '',
        'wordCount': word_count,
        'inLanguage': lang or 'ru',
    }

    export_payload = _build_export_payload_for_article(article)

    interactions_script = """
    <script>
(function() {
  var root = document.getElementById('exportBlocksRoot');
  if (!root) return;
  var collapseIcon = { open: '▾', closed: '▸' };
  var firstBlock = root.querySelector('.block');
  var currentId = firstBlock ? firstBlock.getAttribute('data-block-id') : null;

  function getParentBlock(block) {
    if (!block || !block.parentElement) return null;
    return block.parentElement.closest('.block');
  }

  function updateBlockView(block, collapsed) {
    block.dataset.collapsed = collapsed ? 'true' : 'false';
    var body = block.querySelector('.block-body');
    var noTitle = block.classList.contains('block--no-title');
    if (body && !noTitle) {
      body.classList.toggle('collapsed', collapsed);
    }
    var children = block.querySelector('.block-children');
    if (children) children.classList.toggle('collapsed', collapsed);
    var btn = block.querySelector('.collapse-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.textContent = collapsed ? collapseIcon.closed : collapseIcon.open;
    }
  }

  function collectVisible() {
    var result = [];
    function walk(container) {
      var children = container.children;
      for (var i = 0; i < children.length; i += 1) {
        var node = children[i];
        if (!node.classList || !node.classList.contains('block')) continue;
        result.push(node);
        var isCollapsed = node.dataset.collapsed === 'true';
        var kids = node.querySelector('.block-children');
        if (!isCollapsed && kids) walk(kids);
      }
    }
    walk(root);
    return result;
  }

  function setCurrent(block) {
    if (!block) return;
    currentId = block.getAttribute('data-block-id') || null;
    Array.prototype.forEach.call(
      root.querySelectorAll('.block.selected'),
      function(el) { el.classList.remove('selected'); }
    );
    block.classList.add('selected');
    block.focus({ preventScroll: false });
  }

  function toggleBlock(block, desired) {
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    var next = typeof desired === 'boolean' ? desired : !collapsed;
    updateBlockView(block, next);
  }

  function moveSelection(offset) {
    if (!currentId) {
      var first = root.querySelector('.block');
      if (first) setCurrent(first);
      return;
    }
    var ordered = collectVisible();
    var index = -1;
    for (var i = 0; i < ordered.length; i += 1) {
      if (ordered[i].getAttribute('data-block-id') === currentId) {
        index = i;
        break;
      }
    }
    if (index === -1) return;
    var next = ordered[index + offset];
    if (next) setCurrent(next);
  }

  function handleArrowLeft() {
    if (!currentId) return;
    var block = root.querySelector('.block[data-block-id="' + currentId + '"]');
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    if (!collapsed) {
      toggleBlock(block, true);
      return;
    }
    var parent = getParentBlock(block);
    if (parent) setCurrent(parent);
  }

  function handleArrowRight() {
    if (!currentId) return;
    var block = root.querySelector('.block[data-block-id="' + currentId + '"]');
    if (!block) return;
    var collapsed = block.dataset.collapsed === 'true';
    var firstChild = block.querySelector('.block-children .block');
    if (collapsed) {
      toggleBlock(block, false);
      if (firstChild) setCurrent(firstChild);
      return;
    }
    if (firstChild) {
      setCurrent(firstChild);
    }
  }

  root.addEventListener('click', function(event) {
    var btn = event.target.closest('.collapse-btn');
    if (btn) {
      var targetId = btn.getAttribute('data-block-id');
      var block = root.querySelector('.block[data-block-id="' + targetId + '"]');
      toggleBlock(block);
      setCurrent(block);
      return;
    }
    var block = event.target.closest('.block');
    if (block) {
      setCurrent(block);
    }
  });

  document.addEventListener('keydown', function(event) {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', ' '].indexOf(event.code) !== -1) {
      event.preventDefault();
    } else {
      return;
    }
    if (event.code === 'ArrowDown') {
      moveSelection(1);
      return;
    }
    if (event.code === 'ArrowUp') {
      moveSelection(-1);
      return;
    }
    if (event.code === 'ArrowLeft') {
      handleArrowLeft();
      return;
    }
    if (event.code === 'ArrowRight') {
      handleArrowRight();
      return;
    }
    if (event.code === 'Enter' || event.code === 'Space' || event.code === ' ') {
      if (!currentId) return;
      var block = root.querySelector('.block[data-block-id="' + currentId + '"]');
      toggleBlock(block);
    }
  });

  if (firstBlock) setCurrent(firstBlock);
})();
    </script>
    """

    lang_safe = html_mod.escape(lang or 'ru')
    description_safe = html_mod.escape(description or title_raw)

    return f"""<!doctype html>
<html lang="{lang_safe}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content="{description_safe}" />
    <meta name="x-memus-export" content="memus;v=1" />
    <meta name="robots" content="index,follow" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="{title}" />
    <meta property="og:description" content="{description_safe}" />
    <meta name="twitter:card" content="summary_large_image" />
    <style>
{css_text}
{extra_css}
    </style>
    <script type="application/ld+json">
{json.dumps(json_ld, ensure_ascii=False, indent=2)}
    </script>
  </head>
  <body class="export-page">
    <script type="application/json" id="memus-export">
{json.dumps(export_payload, ensure_ascii=False, indent=2)}
    </script>
    {body_inner}
    {interactions_script}
  </body>
</html>
"""


def _inline_uploads_for_backup(html_text: str, current_user: User | None) -> str:
    """
    Делает резервную HTML-страницу самодостаточной:
    - все ссылки src=\"/uploads/...\" и href=\"/uploads/...\" для текущего пользователя
      конвертирует в data: URL;
    - при этом добавляет data-original-src/href с исходным путём, чтобы импорт
      мог при желании переиспользовать существующие файлы и не плодить дубликаты.
    """
    if not current_user or '/uploads/' not in (html_text or ''):
        return html_text

    def _replace(match: re.Match[str]) -> str:
        attr = match.group(1)  # src | href
        original_url = match.group(2) or ''
        if not original_url.startswith('/uploads/'):
            return match.group(0)
        # Путь внутри uploads
        rel = original_url[len('/uploads/') :].lstrip('/')
        rel_path = PurePosixPath(rel)
        parts = rel_path.parts
        # Гарантируем, что путь принадлежит текущему пользователю.
        if not parts or parts[0] != current_user.id:
            return match.group(0)
        file_path = UPLOADS_DIR / rel_path
        if not file_path.is_file():
            return match.group(0)
        try:
            raw = file_path.read_bytes()
        except OSError:
            return match.group(0)
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if not mime_type:
            mime_type = 'application/octet-stream'
        b64 = base64.b64encode(raw).decode('ascii')
        data_url = f'data:{mime_type};base64,{b64}'
        # src=\"...\" -> src=\"data:...\" data-original-src=\"...\"
        return f'{attr}=\"{data_url}\" data-original-{attr}=\"{original_url}\"'

    pattern = re.compile(r'(src|href)=\"(/uploads/[^\"]+)\"')
    return pattern.sub(_replace, html_text or '')


def _present_article(article: dict[str, Any] | None, requested_id: str) -> dict[str, Any]:
    """
    Нормализует JSON статьи перед отдачей клиенту.
    Для inbox скрываем внутренний ID и всегда возвращаем id == "inbox",
    чтобы вся клиентская логика могла опираться на это стабильное значение.
    """
    if not article:
        return {}
    if requested_id == 'inbox':
        article = dict(article)
        article['id'] = 'inbox'
    return article


@app.get('/api/auth/google/login')
def google_login(request: Request):
    """
    Запускает OAuth-авторизацию через Google:
    редиректит пользователя на accounts.google.com.
    """
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail='Google OAuth не настроен')

    state = os.urandom(16).hex()
    response = RedirectResponse(
        url='https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(
            {
                'client_id': GOOGLE_CLIENT_ID,
                'redirect_uri': GOOGLE_REDIRECT_URI,
                'response_type': 'code',
                'scope': 'openid email profile',
                'state': state,
                'access_type': 'online',
                'prompt': 'select_account',
            },
        ),
    )
    # Простой CSRF-guard через cookie.
    response.set_cookie(
        key='google_oauth_state',
        value=state,
        httponly=True,
        secure=False,
        samesite='lax',
        path='/',
    )
    return response


@app.get('/api/auth/google/callback')
def google_callback(request: Request):
    """
    Обрабатывает колбек от Google:
    - проверяет state;
    - обменивает code на токены;
    - получает email/имя пользователя;
    - находит/создаёт пользователя и создаёт сессию;
    - редиректит на SPA.
    """
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail='Google OAuth не настроен')

    params = dict(request.query_params)
    error = params.get('error')
    if error:
        logger.warning('Google OAuth error: %s', error)
        raise HTTPException(status_code=400, detail=f'Ошибка Google OAuth: {error}')

    code = params.get('code')
    state = params.get('state') or ''
    if not code:
        raise HTTPException(status_code=400, detail='Не передан code от Google')

    cookie_state = request.cookies.get('google_oauth_state') or ''
    if not cookie_state or cookie_state != state:
        raise HTTPException(status_code=400, detail='Некорректный state для Google OAuth')

    # Обмениваем code на access_token и id_token.
    token_data = urllib.parse.urlencode(
        {
            'code': code,
            'client_id': GOOGLE_CLIENT_ID,
            'client_secret': GOOGLE_CLIENT_SECRET,
            'redirect_uri': GOOGLE_REDIRECT_URI,
            'grant_type': 'authorization_code',
        },
    ).encode('utf-8')
    try:
        token_req = urllib.request.Request(
            'https://oauth2.googleapis.com/token',
            data=token_data,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
        )
        with urllib.request.urlopen(token_req, timeout=10) as resp:
            token_info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to exchange code for token: %s', exc)
        raise HTTPException(status_code=502, detail='Не удалось связаться с Google (token)')

    access_token = token_info.get('access_token')
    if not access_token:
        raise HTTPException(status_code=400, detail='Google не вернул access_token')

    # Запрашиваем данные пользователя.
    try:
        user_req = urllib.request.Request(
            'https://openidconnect.googleapis.com/v1/userinfo',
            headers={'Authorization': f'Bearer {access_token}'},
        )
        with urllib.request.urlopen(user_req, timeout=10) as resp:
            user_info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to fetch Google userinfo: %s', exc)
        raise HTTPException(status_code=502, detail='Не удалось получить профиль Google')

    email = (user_info.get('email') or '').strip().lower()
    name = (user_info.get('name') or '').strip() or None
    if not email:
        raise HTTPException(status_code=400, detail='Google не вернул email')

    # Для администратора: логиним существующего пользователя "kirill"
    # по Google-аккаунту с email kirillnad@gmail.com.
    admin_user: User | None = None
    if email == 'kirillnad@gmail.com':
        try:
            admin_user = get_user_by_username('kirill')
        except Exception:  # noqa: BLE001
            admin_user = None

    if admin_user:
        user = admin_user
    else:
        # Для остальных всегда создаём отдельного локального пользователя для Google-логина.
        # Если username с таким email уже существует, подберём новый (email+gN),
        # чтобы не "склеивать" учётки, созданные через пароль и через Google.
        base_username = email
        username = base_username
        existing = get_user_by_username(username)
        if existing:
            suffix = 1
            while True:
                candidate = f'{base_username}+g{suffix}'
                if not get_user_by_username(candidate):
                    username = candidate
                    break
                suffix += 1

        random_pwd = os.urandom(16).hex()
        user = create_user(username, random_pwd, name or username, is_superuser=False)

    # Создаём сессию и редиректим в SPA.
    sid = create_session(user.id)
    redirect = RedirectResponse(url='/', status_code=302)
    set_session_cookie(redirect, sid)
    # Удаляем одноразовый state.
    redirect.delete_cookie('google_oauth_state', path='/')
    return redirect


@app.middleware('http')
async def spa_fallback_middleware(request: Request, call_next):
    """
    SPA-фолбек: для любых не-API и не-upload маршрутов без расширения
    возвращаем index.html, чтобы клиентский роутинг работал (например, /article/123).
    """
    response = await call_next(request)
    if response.status_code != 404:
        return response
    path = PurePath(request.url.path)
    if request.url.path.startswith('/api') or request.url.path.startswith('/uploads'):
        return response
    if path.suffix:
        return response
    index_path = CLIENT_DIR / 'index.html'
    if not index_path.is_file():
        return response
    return FileResponse(index_path)


# Password-based auth endpoints временно выключены: оставляем код ниже без роутинга,
# чтобы при необходимости можно было быстро вернуть функциональность.

def legacy_register(payload: dict[str, Any], response: Response):  # pragma: no cover - legacy
    username = (payload.get('username') or '').strip()
    password = payload.get('password') or ''
    display_name = (payload.get('displayName') or '').strip() or None
    if not username or not password:
        raise HTTPException(status_code=400, detail='Username and password are required')
    existing = get_user_by_username(username)
    if existing:
        raise HTTPException(status_code=400, detail='Username already taken')
    user = create_user(username, password, display_name)
    sid = create_session(user.id)
    set_session_cookie(response, sid)
    return {
        'id': user.id,
        'username': user.username,
        'displayName': user.display_name,
        'isSuperuser': bool(getattr(user, 'is_superuser', False)),
    }


def legacy_login(payload: dict[str, Any], response: Response):  # pragma: no cover - legacy
    username = (payload.get('username') or '').strip()
    password = payload.get('password') or ''
    if not username or not password:
        raise HTTPException(status_code=400, detail='Username and password are required')
    row = get_user_by_username(username)
    if not row:
        raise HTTPException(status_code=401, detail='Invalid credentials')
    stored = CONN.execute(
        'SELECT password_hash FROM users WHERE id = ?',
        (row.id,),
    ).fetchone()
    if not stored or not verify_password(password, stored['password_hash']):
        raise HTTPException(status_code=401, detail='Invalid credentials')
    sid = create_session(row.id)
    set_session_cookie(response, sid)
    return {
        'id': row.id,
        'username': row.username,
        'displayName': row.display_name,
        'isSuperuser': bool(getattr(row, 'is_superuser', False)),
    }


@app.post('/api/auth/logout')
def logout(response: Response, current_user: User = Depends(get_current_user)):
    clear_session_cookie(response)
    return {'status': 'ok'}


@app.get('/api/auth/me')
def me(current_user: User = Depends(get_current_user)):
    return {
        'id': current_user.id,
        'username': current_user.username,
        'displayName': current_user.display_name,
        'isSuperuser': bool(getattr(current_user, 'is_superuser', False)),
    }


@app.get('/api/articles')
def list_articles(current_user: User = Depends(get_current_user)):
    inbox_id = f'inbox-{current_user.id}'
    return [
        {
            'id': article['id'],
            'title': article['title'],
            'updatedAt': article['updatedAt'],
            'publicSlug': article.get('publicSlug'),
            'encrypted': bool(article.get('encrypted', False)),
        }
        for article in get_articles(current_user.id)
        if article['id'] != inbox_id
    ]


@app.get('/api/graph')
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


USERS_PANEL_PASSWORD = os.environ.get('USERS_PANEL_PASSWORD') or 'zZ141400'


@app.get('/api/users')
def list_users(request: Request, current_user: User = Depends(get_current_user)):
    if not getattr(current_user, 'is_superuser', False):
        raise HTTPException(status_code=403, detail='Forbidden')
    supplied = request.headers.get('X-Users-Password') or ''
    if USERS_PANEL_PASSWORD and supplied != USERS_PANEL_PASSWORD:
        raise HTTPException(status_code=403, detail='Forbidden')
    rows = CONN.execute(
        '''
        SELECT id, username, display_name, created_at,
               is_superuser
        FROM users
        ORDER BY username
        ''',
    ).fetchall()
    return [
        {
            'id': row['id'],
            'username': row['username'],
            'displayName': row.get('display_name'),
            'createdAt': row['created_at'],
            'isSuperuser': bool(row.get('is_superuser', 0)),
        }
        for row in rows
    ]


@app.post('/api/import/logseq/upload')
async def upload_logseq_archive(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Быстрая загрузка ZIP-архива Logseq на сервер без длительной обработки.
    Возвращает идентификатор архива, который затем можно передать в /api/import/logseq/start.
    """
    filename = file.filename or ''
    if not filename.lower().endswith('.zip'):
        raise HTTPException(status_code=400, detail='Ожидается ZIP-архив Logseq (.zip)')

    user_root = UPLOADS_DIR / current_user.id / 'logseq_archives'
    user_root.mkdir(parents=True, exist_ok=True)
    archive_id = uuid4().hex
    dest_path = user_root / f'{archive_id}.zip'

    # Потоковая запись файла на диск, чтобы не держать всё в памяти.
    async with aiofiles.open(dest_path, 'wb') as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            await out.write(chunk)

    return {
        'archiveId': archive_id,
        'originalName': filename,
    }


def _run_logseq_import_task(task_id: str, user_id: str, archive_path_str: str, assets_base_url: str | None) -> None:
    """
    Фоновая задача: читает сохранённый ZIP-архив Logseq и запускает импорт.
    """
    task = LOGSEQ_IMPORT_TASKS.get(task_id)
    if not task:
        return
    task['status'] = 'running'
    task['updatedAt'] = datetime.utcnow().isoformat()

    archive_path = Path(archive_path_str)
    try:
        user = get_user_by_id(user_id)
        if not user:
            raise RuntimeError('Пользователь не найден для задачи импорта Logseq')
        raw = archive_path.read_bytes()
        articles = _import_logseq_from_bytes(raw, archive_path.name, assets_base_url, user)
        task['status'] = 'completed'
        task['updatedAt'] = datetime.utcnow().isoformat()
        task['articles'] = [
            {
                'id': a.get('id'),
                'title': a.get('title'),
                'updatedAt': a.get('updatedAt'),
            }
            for a in (articles or [])
            if isinstance(a, dict) and a.get('id')
        ]
        task['error'] = None
    except Exception as exc:  # noqa: BLE001
        logger.error('Logseq import task %s failed: %r', task_id, exc)
        task['status'] = 'failed'
        task['updatedAt'] = datetime.utcnow().isoformat()
        task['error'] = str(exc)
        task['articles'] = []
    finally:
        # Пытаемся удалить архив, чтобы не засорять диск.
        try:
            archive_path.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass


@app.post('/api/import/logseq/start')
def start_logseq_import(
    payload: dict[str, Any],
    background: BackgroundTasks,
    current_user: User = Depends(get_current_user),
):
    """
    Запускает фоновую задачу импорта Logseq из ранее загруженного архива.
    """
    archive_id = (payload.get('archiveId') or '').strip()
    assets_base_url = (payload.get('assetsBaseUrl') or '').strip() or None
    if not archive_id:
        raise HTTPException(status_code=400, detail='archiveId обязателен')

    archive_path = UPLOADS_DIR / current_user.id / 'logseq_archives' / f'{archive_id}.zip'
    if not archive_path.is_file():
        raise HTTPException(status_code=404, detail='Архив не найден')

    task_id = uuid4().hex
    now = datetime.utcnow().isoformat()
    LOGSEQ_IMPORT_TASKS[task_id] = {
        'id': task_id,
        'userId': current_user.id,
        'archiveId': archive_id,
        'status': 'pending',
        'createdAt': now,
        'updatedAt': now,
        'error': None,
        'articles': [],
    }

    background.add_task(_run_logseq_import_task, task_id, current_user.id, str(archive_path), assets_base_url)

    return {'taskId': task_id}


@app.get('/api/import/logseq/status/{task_id}')
def get_logseq_import_status(task_id: str, current_user: User = Depends(get_current_user)):
    """
    Возвращает состояние фоновой задачи импорта Logseq.
    """
    task = LOGSEQ_IMPORT_TASKS.get(task_id)
    if not task or task.get('userId') != current_user.id:
        raise HTTPException(status_code=404, detail='Задача не найдена')
    result: dict[str, Any] = {
        'id': task['id'],
        'status': task['status'],
        'createdAt': task['createdAt'],
        'updatedAt': task['updatedAt'],
        'error': task.get('error'),
    }
    if task['status'] == 'completed':
        result['articles'] = task.get('articles') or []
    return result


@app.delete('/api/users/{user_id}')
def delete_user(user_id: str, current_user: User = Depends(get_current_user)):
    if not getattr(current_user, 'is_superuser', False):
        raise HTTPException(status_code=403, detail='Forbidden')
    row = CONN.execute(
        'SELECT id, username, is_superuser FROM users WHERE id = ?',
        (user_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='User not found')
    if bool(row.get('is_superuser', 0)):
        raise HTTPException(status_code=400, detail='Cannot delete a superuser')
    # Удаляем данные пользователя в БД.
    delete_user_with_data(user_id)
    # Чистим его uploads на диске.
    user_root = UPLOADS_DIR / user_id
    if user_root.exists():
        import shutil
        shutil.rmtree(user_root, ignore_errors=True)
    return {'status': 'deleted'}


@app.get('/api/articles/deleted')
def list_deleted_articles(current_user: User = Depends(get_current_user)):
    return [
        {
            'id': article['id'],
            'title': article['title'],
            'updatedAt': article['updatedAt'],
            'deletedAt': article['deletedAt'],
        }
        for article in get_deleted_articles(current_user.id)
    ]


@app.post('/api/articles')
def post_article(payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    article = create_article(payload.get('title'), current_user.id)
    return article


@app.get('/api/articles/{article_id}')
def read_article(article_id: str, current_user: User = Depends(get_current_user)):
    if article_id == 'inbox':
        article = get_or_create_user_inbox(current_user.id)
        if not article:
            raise HTTPException(status_code=404, detail='Article not found')
        return _present_article(article, article_id)
    article = get_article(article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    return article


@app.post('/api/articles/{article_id}/public')
def set_article_public(
    article_id: str,
    payload: dict[str, Any],
    current_user: User = Depends(get_current_user),
):
    """
    Включает или выключает публичный доступ к статье.
    payload: {"public": true|false}
    """
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    article = get_article(real_article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    make_public = bool(payload.get('public', True))
    new_slug: str | None
    if make_public:
        new_slug = article.get('publicSlug') or _generate_public_slug()
    else:
        new_slug = None
    with CONN:
        CONN.execute(
            'UPDATE articles SET public_slug = ?, updated_at = ? WHERE id = ?',
            (new_slug, datetime.utcnow().isoformat(), real_article_id),
        )
    updated = get_article(real_article_id, current_user.id)
    if not updated:
        raise HTTPException(status_code=404, detail='Article not found')
    return _present_article(updated, article_id)


@app.get('/api/public/articles/{slug}')
def read_public_article(slug: str):
    """
    Публичное чтение статьи по её slug без авторизации.
    Возвращает только данные статьи и блоков; редактирование на клиенте отключается.
    """
    row = CONN.execute(
        'SELECT * FROM articles WHERE public_slug = ? AND deleted_at IS NULL',
        (slug,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Article not found')
    article = build_article_from_row(row)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    return _present_article(article, article.get('id', ''))


@app.get('/p/{slug}')
def read_public_article_page(slug: str):
    """
    HTML-страница для публичного просмотра статьи по её slug.
    Не требует авторизации.
    """
    row = CONN.execute(
        'SELECT * FROM articles WHERE public_slug = ? AND deleted_at IS NULL',
        (slug,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Article not found')
    article = build_article_from_row(row)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    html = _build_public_article_html(article)
    return Response(content=html, media_type='text/html')


@app.delete('/api/articles/{article_id}')
def remove_article(article_id: str, force: bool = False, current_user: User = Depends(get_current_user)):
    article = get_article(article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    deleted = delete_article(article_id, force=force)
    if not deleted:
        raise HTTPException(status_code=404, detail='Article not found')
    return {'status': 'deleted' if not force else 'purged'}


@app.patch('/api/articles/{article_id}')
def patch_article(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    article = get_article(real_article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        article = update_article_meta(real_article_id, payload)
        if not article:
            # Если функция вернула None, значит, не было изменений
            article = get_article(real_article_id, current_user.id)
        return _present_article(article, article_id)
    except ArticleNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.patch('/api/articles/{article_id}/blocks/{block_id}')
def patch_block(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    try:
        if not get_article(real_article_id, current_user.id):
            raise ArticleNotFound('Article not found')
        block = update_block(real_article_id, block_id, payload)
        return block
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.patch('/api/articles/{article_id}/collapse')
def patch_collapse(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    block_id = payload.get('blockId')
    collapsed = payload.get('collapsed')
    if block_id is None or not isinstance(collapsed, bool):
        raise HTTPException(status_code=400, detail='Missing blockId or collapsed flag')
    try:
        block = update_block_collapse(real_article_id, block_id, collapsed)
        return block
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/siblings')
def post_sibling(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    direction = payload.get('direction', 'after') if payload else 'after'
    try:
        result = insert_block(real_article_id, block_id, direction, payload.get('payload') if payload else None)
        return result
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.delete('/api/articles/{article_id}/blocks/{block_id}')
def remove_block(article_id: str, block_id: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        result = delete_block(real_article_id, block_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not result:
        raise HTTPException(status_code=404, detail='Статья или блок не найдены')
    return result # result может быть None, если декоратор не нашел статью


@app.post('/api/articles/{article_id}/blocks/{block_id}/move')
def post_move(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    direction = payload.get('direction')
    if direction not in {'up', 'down'}:
        raise HTTPException(status_code=400, detail='Unknown move direction')
    try:
        if not get_article(real_article_id, current_user.id):
            raise ArticleNotFound('Article not found')
        result = move_block(real_article_id, block_id, direction)
        return result
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/indent')
def post_indent(article_id: str, block_id: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        return indent_block(real_article_id, block_id)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/outdent')
def post_outdent(article_id: str, block_id: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    try:
        return outdent_block(real_article_id, block_id)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/relocate')
def post_relocate(article_id: str, block_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    target_parent_id = payload.get('parentId')
    target_index = payload.get('index')
    anchor_id = payload.get('anchorId')
    placement = payload.get('placement')
    try:
        return move_block_to_parent(real_article_id, block_id, target_parent_id, target_index, anchor_id, placement)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/undo-text')
def post_undo(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    entry_id = payload.get('entryId')
    return _handle_undo_redo(undo_block_text_change, real_article_id, entry_id)


@app.post('/api/articles/{article_id}/blocks/redo-text')
def post_redo(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    if not get_article(real_article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    entry_id = payload.get('entryId')
    return _handle_undo_redo(redo_block_text_change, real_article_id, entry_id)


@app.post('/api/articles/{article_id}/restore')
def post_restore_article(article_id: str, current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    article = restore_article(real_article_id, author_id=current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found or not deleted')
    return _present_article(article, article_id)



@app.post('/api/uploads')
async def upload_file(file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    if not file.content_type or not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail='Ошибка формата: нужен image/*')
    now = datetime.utcnow()
    user_root = UPLOADS_DIR / current_user.id / 'images'
    target_dir = user_root / str(now.year) / f"{now.month:02}"
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{int(now.timestamp()*1000)}-{os.urandom(4).hex()}.webp"
    dest = target_dir / filename

    buffer = BytesIO()
    size = 0
    while chunk := await file.read(1024 * 256):
        size += len(chunk)
        if size > 20 * 1024 * 1024:
            raise HTTPException(status_code=400, detail='Размер файла превышает лимит')
        buffer.write(chunk)
    buffer.seek(0)

    try:
        img = Image.open(buffer)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail='Не удалось прочитать изображение') from exc

    max_width = 1920
    if img.width > max_width:
        new_height = int(img.height * max_width / img.width)
        img = img.resize((max_width, max(new_height, 1)), Image.Resampling.LANCZOS)

    if img.mode in ('RGBA', 'LA', 'P'):
        img = img.convert('RGBA')
    else:
        img = img.convert('RGB')

    out_buf = BytesIO()
    # Все загружаемые изображения конвертируем в WebP с качеством 75.
    img.save(out_buf, 'WEBP', quality=75, method=6)
    out_bytes = out_buf.getvalue()

    async with aiofiles.open(dest, 'wb') as out_file:
        await out_file.write(out_bytes)

    rel = dest.relative_to(UPLOADS_DIR).as_posix()
    return {'url': f"/uploads/{rel}"}



@app.post('/api/articles/{article_id}/attachments')
async def upload_attachment(article_id: str, file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    real_article_id = _resolve_article_id_for_user(article_id, current_user)
    article = get_article(real_article_id, current_user.id)
    if not article:
        raise HTTPException(status_code=404, detail='Article not found')
    content_type = file.content_type or ''
    if not content_type:
        content_type = mimetypes.guess_type(file.filename or '')[0] or ''
    if not content_type or content_type not in ALLOWED_ATTACHMENT_TYPES:
        raise HTTPException(status_code=400, detail='Недопустимый тип файла')

    target_dir = UPLOADS_DIR / current_user.id / 'attachments' / real_article_id
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f'{uuid4().hex}{Path(file.filename).suffix or ""}'
    dest = target_dir / filename

    size = 0
    try:
        async with aiofiles.open(dest, 'wb') as out_file:
            while chunk := await file.read(1024 * 256):
                size += len(chunk)
                if size > 20 * 1024 * 1024:
                    dest.unlink(missing_ok=True)
                    raise HTTPException(status_code=400, detail='Файл слишком большой (макс 20 МБ)')
                await out_file.write(chunk)
    except Exception:
        dest.unlink(missing_ok=True)
        raise

    stored_path = f'/uploads/{current_user.id}/attachments/{real_article_id}/{filename}'
    attachment = create_attachment(real_article_id, stored_path, file.filename or filename, content_type or '', size)
    return attachment


@app.get('/api/export/html-zip')
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
        'Content-Disposition': f'attachment; filename="{zip_name}"',
    }
    return Response(content=buf.getvalue(), media_type='application/zip', headers=headers)


@app.post('/api/import/html')
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
                text_html = _process_block_html_for_import(text, original_id, current_user, new_article_id)
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
    created = get_article(new_article_id, current_user.id)
    if not created:
        raise HTTPException(status_code=500, detail='Не удалось создать статью при импорте')
    return created


@app.post('/api/import/markdown')
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
        from urllib.parse import urljoin, urlsplit, urlunsplit, quote
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


def _import_logseq_from_bytes(
    raw: bytes,
    filename: str,
    assets_base_url: str | None,
    current_user: User,
) -> list[dict[str, Any]]:
    """
    Общая реализация импорта Logseq из ZIP-архива.

    Используется как синхронным API-эндпоинтом, так и фоновыми задачами.
    """
    filename_lc = (filename or '').lower()
    if not filename_lc.endswith('.zip'):
        raise HTTPException(status_code=400, detail='Ожидается ZIP-архив Logseq (pages/ и assets/)')

    # Защита от слишком больших архивов (например, > 1 ГБ).
    max_size = 1024 * 1024 * 1024  # 1 GiB
    if len(raw) > max_size:
        raise HTTPException(
            status_code=400,
            detail='Архив Logseq слишком большой (максимум 1 ГБ)',
        )
    try:
        zf = zipfile.ZipFile(BytesIO(raw))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail='Не удалось прочитать ZIP-архив') from exc

    page_entries: list[zipfile.ZipInfo] = []
    asset_entries: dict[str, zipfile.ZipInfo] = {}
    has_non_utf8_names = False

    for info in zf.infolist():
        name = info.filename or ''
        if not name or info.is_dir():
            continue
        # Если в имени есть не-ASCII символы и не установлен UTF-8-флаг,
        # считаем, что архив собран без поддержки UTF-8.
        if any(ord(ch) > 127 for ch in name) and not (info.flag_bits & 0x800):
            has_non_utf8_names = True
        path = PurePosixPath(name)
        parts = path.parts
        if not parts:
            continue
        top = parts[0].lower()
        if top == 'pages' and path.suffix.lower() in {'.md', '.markdown', '.txt'}:
            page_entries.append(info)
        elif top == 'assets':
            # Ключ: путь внутри assets/
            rel = PurePosixPath(*parts[1:]).as_posix()
            asset_entries[rel] = info

    if has_non_utf8_names:
        raise HTTPException(
            status_code=400,
            detail=(
                'Собери ZIP через PeaZip (https://peazip.github.io/)'
                'с кодировкой имён файлов в UTF-8.'
            ),
        )

    if not page_entries:
        raise HTTPException(status_code=400, detail='В архиве не найдено ни одной страницы в папке pages/')

    imported_articles: list[dict[str, Any]] = []

    base_url = (assets_base_url or '').strip().rstrip('/') or None

    # Если базовый URL задан, но в архиве нет assets/,
    # явно логируем, что будем использовать только внешний источник.
    if base_url and not asset_entries:
        print(
            '[logseq_import] assetsBaseUrl задан, но папка assets/ в архиве не найдена; '
            'вложения будут подтягиваться только по внешнему URL:',
            base_url,
        )

    def _resolve_assets_in_html(html_text: str, article_id: str) -> str:
        """
        Ищет ссылки вида href="...assets/..." и, если файл есть в архиве,
        сохраняет его в uploads/attachments и переписывает href на внутренний путь.
        """

        def _replace_href(match: re.Match[str]) -> str:
            href = match.group(1) or ''
            href_stripped = href.strip()
            if not href_stripped:
                return match.group(0)
            # Уже внутренние uploads не трогаем.
            if href_stripped.startswith('/uploads/'):
                return match.group(0)

            # Пытаемся найти сегмент "assets" в относительном пути.
            parts = list(PurePosixPath(href_stripped).parts)
            if 'assets' not in parts:
                return match.group(0)
            idx = parts.index('assets')
            rel = PurePosixPath(*parts[idx + 1 :]).as_posix()
            if not rel:
                return match.group(0)

            # 1) Пробуем взять файл из assets внутри ZIP (если есть).
            info = asset_entries.get(rel)
            if info:
                try:
                    data = zf.read(info)
                except KeyError:
                    info = None
                else:
                    mime_type = mimetypes.guess_type(info.filename or '')[0] or 'application/octet-stream'
                    stored_path = _import_attachment_from_bytes(
                        data,
                        mime_type,
                        current_user,
                        article_id,
                        display_name=PurePosixPath(info.filename).name,
                    )
                    new_href = html_mod.escape(stored_path, quote=True)
                    return f'href="{new_href}"'

            # 2) Если указан внешний базовый URL, пробуем скачать оттуда.
            if base_url:
                import urllib.request
                from urllib.parse import urljoin, urlsplit, urlunsplit, quote

                # Пробуем варианты: файл лежит в корне base_url или в подпапке /assets.
                candidates = [rel, f'assets/{rel}']
                for remote_path in candidates:
                    full_url = urljoin(base_url + '/', remote_path)
                    try:
                        # Логируем URL, который пробуем подтянуть.
                        logger.info(
                            '[logseq_import] trying to fetch asset from %s for article %s',
                            full_url,
                            article_id,
                        )
                        # Корректно кодируем путь (кириллица и др.) в URL.
                        parts = urlsplit(full_url)
                        safe_path = quote(parts.path)
                        safe_url = urlunsplit((parts.scheme, parts.netloc, safe_path, parts.query, parts.fragment))
                        req = urllib.request.Request(safe_url, headers={'User-Agent': 'memus-logseq-import/1.0'})
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
                            '[logseq_import] failed to fetch asset from %s for article %s: %r',
                            full_url,
                            article_id,
                            exc,
                        )
                        continue

                    stored_path = _import_attachment_from_bytes(
                        data,
                        mime_type,
                        current_user,
                        article_id,
                        display_name=PurePosixPath(remote_path).name,
                    )
                    new_href = html_mod.escape(stored_path, quote=True)
                    return f'href="{new_href}"'

            return match.group(0)

        return re.sub(r'href="([^"]+)"', _replace_href, html_text)

    now = datetime.utcnow().isoformat()

    for info in page_entries:
        try:
            content_bytes = zf.read(info)
        except KeyError:
            continue
        try:
            md_text = content_bytes.decode('utf-8')
        except UnicodeDecodeError:
            md_text = content_bytes.decode('utf-8', errors='ignore')

        blocks_tree = _parse_markdown_blocks(md_text)
        if not blocks_tree:
            continue

        # Имя статьи = имя файла без расширения (после корректного UTF-8-декодирования в zipfile).
        title_stem = PurePosixPath(info.filename or '').stem or 'Импортированная страница'
        base_title = title_stem.strip() or 'Импортированная страница'

        # Перед созданием новой статьи удаляем все существующие статьи
        # этого пользователя с таким же заголовком (полная замена).
        try:
            existing_rows = CONN.execute(
                'SELECT id FROM articles WHERE author_id = ? AND title = ? AND deleted_at IS NULL',
                (current_user.id, base_title),
            ).fetchall()
            for row in existing_rows or []:
                try:
                    delete_article(row['id'], force=True)
                except Exception as exc:  # noqa: BLE001
                    logger.error('Failed to delete old article %s before Logseq import: %r', row['id'], exc)
        except Exception as exc:  # noqa: BLE001
            logger.error('Failed to query existing articles before Logseq import: %r', exc)

        new_article_id = str(uuid4())

        # Сначала создаём «пустую» статью, чтобы запись в articles уже существовала,
        # а затем подтягиваем вложения и только после этого сохраняем финальное дерево блоков.
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

        # Применяем переписывание ссылок на вложения для каждого блока.
        for block in _walk_blocks(blocks_tree):
            text_html = block.get('text') or ''
            if text_html:
                block['text'] = _resolve_assets_in_html(text_html, new_article_id)

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
        if created:
            imported_articles.append(created)

    if not imported_articles:
        raise HTTPException(status_code=400, detail='Не удалось импортировать ни одной страницы из архива Logseq')
    return imported_articles


@app.post('/api/import/logseq')
async def import_from_logseq(
    file: UploadFile = File(...),
    assets_base_url: str | None = Form(None, alias='assetsBaseUrl'),
    current_user: User = Depends(get_current_user),
):
    """
    Синхронный импорт Logseq (оставлен для совместимости).
    Для крупных архивов лучше использовать upload/start/status API.
    """
    raw = await file.read()
    filename = file.filename or ''
    return _import_logseq_from_bytes(raw, filename, assets_base_url, current_user)


@app.get('/api/search')
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


@app.post('/api/articles/{article_id}/blocks/restore')
def post_restore(article_id: str, payload: dict[str, Any], current_user: User = Depends(get_current_user)):
    if not get_article(article_id, current_user.id):
        raise HTTPException(status_code=404, detail='Article not found')
    block = payload.get('block')
    if not block:
        raise HTTPException(status_code=400, detail='Missing block payload')
    parent_id = payload.get('parentId')
    index = payload.get('index')
    try:
        return restore_block(article_id, parent_id, index, block)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post('/api/articles/{article_id}/blocks/{block_id}/move-to/{target_article_id}')
def post_move_to(article_id: str, block_id: str, target_article_id: str, current_user: User = Depends(get_current_user)):
    try:
        src = get_article(article_id, current_user.id)
        dst = get_article(target_article_id, current_user.id)
        if not src or not dst:
            raise ArticleNotFound('Article not found')
        return move_block_to_article(article_id, block_id, target_article_id)
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _handle_undo_redo(func, article_id, entry_id):
    try:
        result = func(article_id, entry_id)
        if not result:
            raise InvalidOperation('Nothing to undo')
        block_id = result.get('blockId') or result.get('id')
        block_payload = result.get('block') or {'id': block_id, **{k: v for k, v in result.items() if k != 'blockId'}}
        return {'blockId': block_id, 'block': block_payload}
    except (ArticleNotFound, BlockNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except InvalidOperation as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get('/api/changelog')
def get_changelog():
    changelog = BASE_DIR / 'changelog.txt'
    if not changelog.exists():
        raise HTTPException(status_code=404, detail='Changelog not found')
    return PlainTextResponse(changelog.read_text(encoding='utf-8'))


@app.get('/api/health')
def health():
    return {'status': 'ok'}

@app.get('/favicon.ico')
def favicon():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="#0d6efd"/>
<path d="M18 18h8v20h-8zM30 18h8l8 12-8 12h-8l8-12z" fill="#fff"/>
</svg>"""
    return Response(content=svg, media_type='image/svg+xml')


@app.get('/uploads/{user_id}/{rest_of_path:path}')
async def get_upload(user_id: str, rest_of_path: str, current_user: User = Depends(get_current_user)):
    if user_id != current_user.id:
        raise HTTPException(status_code=404, detail='Not found')
    full_path = UPLOADS_DIR / user_id / rest_of_path
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail='Not found')
    return FileResponse(full_path)


# Mount client SPA after API routes so /api/* keeps working.
app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")
