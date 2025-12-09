from __future__ import annotations

from html import escape
from html.parser import HTMLParser
import re
from typing import List

ALLOWED_TAGS = {
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'mark',
    'code',
    'pre',
    'blockquote',
    'p',
    'br',
    'div',
    'span',
    'ul',
    'ol',
    'li',
    'a',
    'img',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'colgroup',
    'col',
}

ALLOWED_ATTRS = {
    'a': {'href', 'title', 'target', 'rel'},
    'img': {'src', 'alt', 'title'},
    'div': {'class'},
    'table': {'class'},
    'col': {'width'},
}

ALLOWED_SCHEMES = {'http', 'https', 'mailto', 'data'}
VOID_TAGS = {'br', 'img', 'col'}


def _is_allowed_url(value: str) -> bool:
    if not value:
        return False
    lowered = value.strip().lower()
    if lowered.startswith('data:'):
        return True
    if '://' not in lowered:
        return True
    scheme = lowered.split('://', 1)[0]
    return scheme in ALLOWED_SCHEMES


class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.result: List[str] = []
        self.tag_stack: List[str | None] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag not in ALLOWED_TAGS:
            self.tag_stack.append(None)
            return
        attr_text = self._format_attrs(tag, attrs)
        if tag in VOID_TAGS:
            self.result.append(f'<{tag}{attr_text} />')
            return
        self.result.append(f'<{tag}{attr_text}>')
        self.tag_stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if not self.tag_stack:
            return
        allowed = self.tag_stack.pop()
        if allowed == tag:
            self.result.append(f'</{tag}>')

    def handle_startendtag(self, tag: str, attrs) -> None:
        if tag not in ALLOWED_TAGS:
            return
        attr_text = self._format_attrs(tag, attrs)
        self.result.append(f'<{tag}{attr_text} />')

    def handle_data(self, data: str) -> None:
        if data:
            self.result.append(escape(data))

    def handle_entityref(self, name: str) -> None:
        self.result.append(f'&{name};')

    def handle_charref(self, name: str) -> None:
        self.result.append(f'&#{name};')

    def _format_attrs(self, tag: str, attrs) -> str:
        allowed = ALLOWED_ATTRS.get(tag, set())
        formatted = []
        for key, value in attrs:
            if key not in allowed or value is None:
                continue
            if tag == 'a' and key == 'href' and not _is_allowed_url(value):
                continue
            if tag == 'img' and key == 'src' and not _is_allowed_url(value):
                continue
            sanitized = escape(value, quote=True)
            formatted.append(f'{key}="{sanitized}"')
        return f" {' '.join(formatted)}" if formatted else ''


def sanitize_html(html: str | None) -> str:
    if not html:
        return ''
    parser = _Sanitizer()
    parser.feed(html)
    parser.close()
    sanitized = ''.join(parser.result)
    return _strip_empty_edges(sanitized)


def _strip_empty_edges(html: str) -> str:
    """
    Удаляем хвостовые пустые абзацы / <br>, появляющиеся после редактирования,
    чтобы в конце блока не накапливались «висячие» пустые строки.
    Лидирующие пустые строки теперь сохраняем: первая пустая строка блока
    используется пользователем осознанно (в т.ч. на публичных страницах).
    """
    empty_p = re.compile(r'^<p>(?:\s|&nbsp;|<br\s*/?>)*</p>', re.IGNORECASE)
    empty_br = re.compile(r'^<br\s*/?>', re.IGNORECASE)
    trailing_empty_p = re.compile(r'<p>(?:\s|&nbsp;|<br\s*/?>)*</p>\s*$', re.IGNORECASE)
    trailing_empty_br = re.compile(r'<br\s*/?>\s*$', re.IGNORECASE)

    # Strip trailing empties
    while True:
        new_html = trailing_empty_p.sub('', html)
        new_html = trailing_empty_br.sub('', new_html)
        new_html = new_html.rstrip()
        if new_html == html:
            break
        html = new_html

    return html
