from __future__ import annotations

import re
from collections import defaultdict
from html import unescape
from typing import Any, Dict, List

from servpy.app.db import CONN
from servpy.app.data_store import get_article, save_article


BROKEN_LINK_RE = re.compile(
    r'<a([^>]*?)href="/article/([0-9a-fA-F-]+)"([^>]*)>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)


def build_article_indexes() -> tuple[set[str], Dict[str, Dict[str, str]]]:
    """
    Читает все не удалённые статьи и строит:
    - множество существующих ID;
    - индекс title -> id по author_id (регистронезависимо).
    """
    rows = CONN.execute(
        'SELECT id, author_id, LOWER(title) AS lc_title '
        'FROM articles WHERE deleted_at IS NULL'
    ).fetchall()
    existing_ids: set[str] = set()
    titles_by_author: Dict[str, Dict[str, str]] = defaultdict(dict)
    for row in rows or []:
        art_id = row['id']
        author_id = row['author_id']
        lc_title = (row['lc_title'] or '').strip()
        if not art_id or not author_id or not lc_title:
            continue
        existing_ids.add(art_id)
        # Если есть дубликаты по названию, оставляем первый попавшийся.
        titles_by_author.setdefault(author_id, {}).setdefault(lc_title, art_id)
    return existing_ids, titles_by_author


def fix_links_in_html(
    html_text: str,
    author_id: str,
    existing_ids: set[str],
    titles_by_author: Dict[str, Dict[str, str]],
) -> str:
    """
    Внутри HTML‑текста блока находит ссылки вида
    <a href="/article/<uuid>">Название</a>.

    Если uuid не существует, пытается найти статью текущего автора
    с таким же названием (регистронезависимо) и переписывает href
    на корректный ID.
    """
    if not html_text or '/article/' not in html_text:
        return html_text

    author_titles = titles_by_author.get(author_id) or {}

    def _replace(match: re.Match[str]) -> str:
        before = match.group(1) or ''
        old_id = (match.group(2) or '').strip()
        after = match.group(3) or ''
        label_html = match.group(4) or ''

        # Ссылка на существующую статью — не трогаем.
        if old_id in existing_ids:
            return match.group(0)

        # Пытаемся взять «имя» из содержимого ссылки.
        label_text = unescape(label_html).strip()
        # На случай, если внутри есть теги, выбрасываем их.
        label_plain = re.sub(r'<[^>]+>', '', label_text).strip() or label_text
        if not label_plain:
            return match.group(0)

        new_id = author_titles.get(label_plain.lower())
        if not new_id or new_id == old_id:
            return match.group(0)

        return f'<a{before}href="/article/{new_id}"{after}>{label_html}</a>'

    return BROKEN_LINK_RE.sub(_replace, html_text)


def fix_links_in_blocks(
    blocks: List[Dict[str, Any]],
    author_id: str,
    existing_ids: set[str],
    titles_by_author: Dict[str, Dict[str, str]],
) -> bool:
    """
    Проходит по всем блокам статьи (рекурсивно) и переписывает
    битые ссылки. Возвращает True, если были изменения.
    """
    changed = False

    for block in blocks or []:
        text = block.get('text') or ''
        new_text = fix_links_in_html(text, author_id, existing_ids, titles_by_author)
        if new_text != text:
            block['text'] = new_text
            changed = True
        children = block.get('children') or []
        if children:
            if fix_links_in_blocks(children, author_id, existing_ids, titles_by_author):
                changed = True
    return changed


def main() -> None:
    existing_ids, titles_by_author = build_article_indexes()

    rows = CONN.execute(
        'SELECT id, author_id FROM articles WHERE deleted_at IS NULL'
    ).fetchall()
    total = 0
    fixed = 0

    for row in rows or []:
        article_id = row['id']
        author_id = row['author_id']
        if not article_id or not author_id:
            continue
        article = get_article(article_id, author_id=author_id)
        if not article:
            continue
        blocks = article.get('blocks') or []
        if not blocks:
            continue
        total += 1
        if fix_links_in_blocks(blocks, author_id, existing_ids, titles_by_author):
            save_article(article)
            fixed += 1
            print(f'Updated links in article {article_id} ({article.get("title")!r})')

    print(f'Processed articles: {total}, fixed: {fixed}')


if __name__ == '__main__':
    main()

