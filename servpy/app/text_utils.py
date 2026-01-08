from __future__ import annotations

import html
import inspect
import re

if not hasattr(inspect, 'getargspec'):
    def _getargspec(func):
        spec = inspect.getfullargspec(func)
        return spec.args, spec.varargs, spec.varkw, spec.defaults

    inspect.getargspec = _getargspec

import pymorphy2

WORD_REGEX = re.compile(r'[A-Za-zА-Яа-яЁё]+')
MORPH = pymorphy2.MorphAnalyzer()


def strip_html(text: str = '') -> str:
    cleaned = re.sub(r'<[^>]+>', ' ', text or '')
    unescaped = html.unescape(cleaned)
    return ' '.join(unescaped.split())


def tokenize(text: str = '') -> list[str]:
    lowered = (text or '').lower()
    return [match.group(0) for match in WORD_REGEX.finditer(lowered)]


def build_normalized_tokens(text: str = '') -> str:
    tokens = tokenize(text)
    return ' '.join(tokens)


def build_lemma(text: str = '') -> str:
    tokens = tokenize(text)
    out: list[str] = []
    for token in tokens:
        try:
            out.append(MORPH.parse(token)[0].normal_form)
        except Exception:
            # Be resilient: never fail the whole save/indexing due to a single bad token/parser edge case.
            out.append(token)
    return ' '.join(out)


def build_lemma_tokens(text: str = '') -> list[str]:
    tokens = tokenize(text)
    out: list[str] = []
    for token in tokens:
        try:
            out.append(MORPH.parse(token)[0].normal_form)
        except Exception:
            out.append(token)
    return out
