from __future__ import annotations

import html as html_mod
import re
from typing import Any
from uuid import uuid4


# Вынесено из app/main.py → app/import_utils.py


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

