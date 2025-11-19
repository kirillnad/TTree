from __future__ import annotations

from html import escape
from html.parser import HTMLParser
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
}

ALLOWED_ATTRS = {
    'a': {'href', 'title', 'target', 'rel'},
    'img': {'src', 'alt', 'title'},
    'div': {'class'},
}

ALLOWED_SCHEMES = {'http', 'https', 'mailto', 'data'}
VOID_TAGS = {'br', 'img'}


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
            self.tag_stack.append(None)
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
    return ''.join(parser.result)

