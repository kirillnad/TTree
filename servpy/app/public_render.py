from __future__ import annotations

import base64
import html as html_mod
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from .db import CONN

# Вынесено из app/main.py → app/public_render.py

BASE_DIR = Path(__file__).resolve().parents[2]
CLIENT_DIR = BASE_DIR / "client"

_INTERNAL_ARTICLE_LINK_RE = re.compile(
    r'<a\s+([^>]*?)href="/article/([0-9a-fA-F-]+)"([^>]*)>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)


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


def _rewrite_internal_links_in_doc_json_for_public(doc_json: Any) -> Any:
    """
    Для публичной страницы переписываем ссылки внутри doc_json:
    - href="/article/<uuid>" -> "/p/<public_slug>" если статья опубликована;
    - иначе href="#" и rel+="unpublished" (клик в public-view покажет алерт).
    """
    if not isinstance(doc_json, dict):
        return doc_json

    # Deep copy to avoid mutating DB-loaded dicts.
    try:
        out: Any = json.loads(json.dumps(doc_json))
    except Exception:  # noqa: BLE001
        out = doc_json

    cache: dict[str, str] = {}
    href_re = re.compile(r'^/article/([0-9a-fA-F-]+)$')

    def resolve_slug(article_id: str) -> str:
        if article_id in cache:
            return cache[article_id]
        row = CONN.execute(
            'SELECT public_slug FROM articles WHERE id = ? AND deleted_at IS NULL',
            (article_id,),
        ).fetchone()
        slug = (row['public_slug'] or '') if row and row['public_slug'] else ''
        cache[article_id] = slug
        return slug

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            marks = node.get('marks')
            if isinstance(marks, list):
                for mark in marks:
                    if not isinstance(mark, dict):
                        continue
                    if mark.get('type') != 'link':
                        continue
                    attrs = mark.get('attrs')
                    if not isinstance(attrs, dict):
                        continue
                    href = attrs.get('href')
                    if not isinstance(href, str):
                        continue
                    m = href_re.match(href.strip())
                    if not m:
                        continue
                    article_id = m.group(1)
                    slug = resolve_slug(article_id)
                    new_attrs = dict(attrs)
                    if slug:
                        new_attrs['href'] = f'/p/{slug}'
                    else:
                        new_attrs['href'] = '#'
                        rel = str(new_attrs.get('rel') or '').strip()
                        parts = [p for p in rel.split() if p]
                        if 'unpublished' not in parts:
                            parts.append('unpublished')
                        new_attrs['rel'] = ' '.join(parts).strip()
                    mark['attrs'] = new_attrs
            content = node.get('content')
            if isinstance(content, list):
                for child in content:
                    walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(out)
    return out


def _split_public_block_sections(raw_html: str) -> tuple[str, str]:
    """
    Приближённый вариант client-side extractBlockSections для публичной страницы.

    Логика:
    - ищем первый по-настоящему «пустой» <p> (содержит только <br>, &nbsp;,
      пробелы и обёртки без текста/картинок);
    - всё ДО него считаем заголовком, всё ПОСЛЕ — телом;
    - если пустой абзац идёт первым, заголовка нет вообще.
    """
    if not raw_html:
        return '', ''

    first_empty: re.Match[str] | None = None
    for m in re.finditer(r'<p\b[^>]*>(.*?)</p\s*>', raw_html, flags=re.IGNORECASE | re.DOTALL):
        inner = m.group(1) or ''
        # Абзац с картинкой никогда не считаем «пустым».
        if re.search(r'<img\b', inner, flags=re.IGNORECASE):
            continue
        # Убираем явные переносы и неразрывные пробелы.
        tmp = re.sub(r'<br\s*/?>', '', inner, flags=re.IGNORECASE)
        tmp = re.sub(r'(&nbsp;|&#160;|\u00A0)', '', tmp, flags=re.IGNORECASE)
        # Удаляем оставшиеся теги, оставляя только текст.
        text_only = re.sub(r'<[^>]+>', '', tmp)
        if text_only.strip():
            # В абзаце есть настоящий текст — не разделитель.
            continue
        first_empty = m
        break

    if not first_empty:
        # Пустых абзацев нет — весь блок считается телом, без заголовка.
        return '', raw_html

    if first_empty.start() <= 0:
        # Первый абзац уже пустой — считаем, что заголовка нет.
        return '', raw_html[first_empty.end() :]

    # Есть содержимое до первого пустого абзаца — это и есть заголовок.
    return raw_html[: first_empty.start()], raw_html[first_empty.end() :]


def _title_starts_with_empty_paragraph(title_html: str) -> bool:
    """
    Проверяет, начинается ли HTML заголовка с «пустого» абзаца
    (<p> с только <br>, &nbsp; и т.п.). В таком случае считаем,
    что заголовка по сути нет (как в клиентском extractBlockSections).
    """
    if not title_html:
        return False
    m = re.match(
        r'\s*<p\b[^>]*>(.*?)</p\s*>',
        title_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not m:
        return False
    inner = m.group(1) or ''
    # Абзац с картинкой считаем содержательным.
    if re.search(r'<img\b', inner, flags=re.IGNORECASE):
        return False
    tmp = re.sub(r'<br\s*/?>', '', inner, flags=re.IGNORECASE)
    tmp = re.sub(r'(&nbsp;|&#160;|\u00A0)', '', tmp, flags=re.IGNORECASE)
    text_only = re.sub(r'<[^>]+>', '', tmp)
    return not text_only.strip()


def _generate_public_slug() -> str:
    """
    Генерирует уникальный короткий slug для публичной ссылки на статью.
    Используем urlsafe base64 от случайных байт и обрезаем до 10 символов.
    """
    while True:
        raw = os.urandom(8)
        candidate = base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=\n')[:10]
        # Некоторые мессенджеры/клиенты (особенно на мобильных) могут "съедать"
        # завершающие символы '-'/'_' при авто-распознавании ссылок.
        # Поэтому гарантируем, что slug начинается и заканчивается буквенно-цифровым символом.
        if not re.match(r'^[A-Za-z0-9][A-Za-z0-9_-]*[A-Za-z0-9]$', candidate):
            continue
        row = CONN.execute(
            'SELECT 1 FROM articles WHERE public_slug = ?',
            (candidate,),
        ).fetchone()
        if not row:
            return candidate


def _get_public_article_row(slug: str):
    """
    Находит статью по public_slug.
    Фолбэк: если exact slug не найден, пробуем добавить суффикс '-' или '_'
    (мобильные клиенты иногда обрезают завершающий символ в URL).
    Возвращает строку из БД или None.
    """
    row = CONN.execute(
        'SELECT * FROM articles WHERE public_slug = ? AND deleted_at IS NULL',
        (slug,),
    ).fetchone()
    if row:
        return row
    if not slug:
        return None
    # Фолбэк только если exact отсутствует: избегаем подмены, если точное совпадение есть.
    candidates = []
    for suffix in ('-', '_'):
        probe = f'{slug}{suffix}'
        r = CONN.execute(
            'SELECT * FROM articles WHERE public_slug = ? AND deleted_at IS NULL',
            (probe,),
        ).fetchone()
        if r:
            candidates.append(r)
    if len(candidates) == 1:
        return candidates[0]
    return None


def _render_public_block(block: dict[str, Any], heading_depth: int = 1) -> str:
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

    # Разбиваем stored HTML на заголовок и тело по первому по-настоящему
    # «пустому» <p>, максимально повторяя client-side extractBlockSections.
    title_html, body_html = _split_public_block_sections(raw_html)
    has_title = bool(title_html.strip())

    # Если у блока нет явного заголовка, но есть дети и внутри всего одна
    # «осмысленная» строка (<p>...</p>), считаем её заголовком. Это повторяет
    # хак из client/article.js и client/exporter.js.
    if not has_title and has_children:
        candidate = body_html or raw_html
        candidate = candidate.strip()
        m = re.fullmatch(r'\s*<p\b[^>]*>(.*?)</p>\s*', candidate, flags=re.IGNORECASE | re.DOTALL)
        if m:
            inner = m.group(1) or ''
            inner_clean = re.sub(r'(&nbsp;|<br\s*/?>)', '', inner, flags=re.IGNORECASE).strip()
            if inner_clean:
                title_html = candidate
                body_html = ''
                has_title = True

    # Если «заголовок» сам по себе начинается с пустой строки — считаем,
    # что это не настоящий заголовок, а просто контент блока.
    if has_title and _title_starts_with_empty_paragraph(title_html):
        body_html = f'{title_html}{body_html}'
        title_html = ''
        has_title = False

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
        level = max(1, min(int(heading_depth or 1), 6))
        heading_tag = f'h{level}'
        header_html = (
            '<div class="block-header">'
            '<div class="block-header__left">'
            f'<{heading_tag} class="block-title" style="flex: 1 1 0%; min-width: 0px;">'
            f'{title_html}'
            f'</{heading_tag}>'
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

    next_heading_depth = heading_depth + 1 if has_title else heading_depth
    children_html = ''.join(_render_public_block(child, next_heading_depth) for child in children)
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

    # Public view: mount the same outliner scripts in strict read-only mode.
    doc_json = _rewrite_internal_links_in_doc_json_for_public(article.get('docJson'))
    doc_json_text = json.dumps(doc_json or {}, ensure_ascii=False)
    # Avoid breaking out of script tag.
    doc_json_text = doc_json_text.replace('</', '<\\/')

    try:
        editor_v = int((CLIENT_DIR / 'outline' / 'editor.js').stat().st_mtime)
    except OSError:
        editor_v = 1
    header = f"""
    <div class="panel-header article-header">
      <div class="title-block">
        <div class="title-row">
          <h1>{title}</h1>
        </div>
        {f'<p class="meta">Обновлено: {html_mod.escape(updated_label)}</p>' if updated_label else ''}
        <p class="meta">Публичная страница Memus (только для чтения)</p>
      </div>
    </div>
    """
    body_inner = f"""
    <section aria-label="Публичная статья">
      {header}
      <div id="outlineEditor" class="outline-editor"></div>
    </section>
    <div id="toast" class="toast hidden" aria-live="polite"></div>
    <script type="application/json" id="publicDocJson">{doc_json_text}</script>
    <script type="module">
      import {{ openPublicOutlineViewer }} from "/outline/editor.js?v={editor_v}";
      const el = document.getElementById('publicDocJson');
      const docJson = el ? JSON.parse(el.textContent || '{{}}') : {{}};
      openPublicOutlineViewer({{ docJson }});
    </script>
    """

    # Берём тот же extraCss, что и экспорт HTML в exporter.js
    extra_css = """
    body.export-page {
      margin: 0.1rem;
      background: #eef2f8;
      overflow: auto;
      height: auto;
    }
    body.export-page .title-row h1 {
      margin: 0;
    }
	    @media (max-width: 800px) {
	      body.export-page .page {
	        margin: 0;
	        padding: 0;
	        max-width: 100%;
	        border-radius: 0;
	        box-shadow: none;
	      }
	    }
	    """

    # Загружаем тот же style.css, что и SPA.
    try:
        css_text = (CLIENT_DIR / 'style.css').read_text(encoding='utf-8')
    except OSError:
        css_text = ''

    interactions_script = ""

    html = f"""<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="/icons/favicon.ico" type="image/x-icon" />
    <style>
{css_text}
{extra_css}
    </style>
  </head>
  <body class="export-page">
    <div class="page">
      {body_inner}
    </div>
    {interactions_script}
  </body>
</html>
"""
    return html
