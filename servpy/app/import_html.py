from __future__ import annotations

import json
from pathlib import PurePosixPath
from typing import Any

from .auth import User
from .import_assets import (
    UPLOADS_DIR,
    _import_attachment_from_data_url,
    _import_image_from_data_url,
)

# Вынесено из app/main.py → app/import_html.py


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

