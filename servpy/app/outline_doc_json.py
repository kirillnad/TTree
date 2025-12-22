from __future__ import annotations

import re
from typing import Any


_WS_RE = re.compile(r"[ \t]+")
_BLANK_LINES_RE = re.compile(r"\n{3,}")


def _normalize_plain(text: str) -> str:
    if not text:
        return ""
    out = text.replace("\u00a0", " ")
    out = out.replace("\r\n", "\n").replace("\r", "\n")
    out = _WS_RE.sub(" ", out)
    out = _BLANK_LINES_RE.sub("\n\n", out)
    return out.strip()


def _pm_text(node: Any) -> str:
    """
    Extracts plain text from a ProseMirror/Tiptap JSON node.
    This is a best-effort conversion intended for embeddings/search (not rendering).
    """
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        parts: list[str] = []
        for item in node:
            t = _pm_text(item)
            if t:
                parts.append(t)
        return "".join(parts)
    if not isinstance(node, dict):
        return ""

    t = node.get("type") or ""
    content = node.get("content") or []

    if t == "text":
        return str(node.get("text") or "")
    if t in {"hardBreak"}:
        return "\n"
    if t in {"image"}:
        # Images have no text; keep alt/title if present.
        attrs = node.get("attrs") or {}
        alt = (attrs.get("alt") or "").strip()
        title = (attrs.get("title") or "").strip()
        return alt or title or ""

    # Block-ish boundaries.
    if t in {"paragraph", "blockquote", "codeBlock"}:
        inner = _pm_text(content)
        return (inner + "\n") if inner else "\n"
    if t in {"heading"}:
        inner = _pm_text(content)
        return (inner + "\n") if inner else "\n"
    if t in {"bulletList", "orderedList"}:
        return _pm_text(content) + "\n"
    if t in {"listItem"}:
        inner = _pm_text(content)
        inner = inner.rstrip("\n")
        return (inner + "\n") if inner else "\n"
    if t in {"table"}:
        return _pm_text(content) + "\n"
    if t in {"tableRow"}:
        cells: list[str] = []
        for c in content if isinstance(content, list) else []:
            cell_text = _pm_text(c).strip()
            cells.append(cell_text)
        row = " | ".join(cells).strip()
        return (row + "\n") if row else "\n"
    if t in {"tableCell", "tableHeader"}:
        return _pm_text(content).strip() + " "

    # Default: recurse.
    return _pm_text(content)


def build_outline_section_plain_text_map(doc_json: Any) -> dict[str, str]:
    """
    Returns mapping: outlineSection.attrs.id -> plain text (heading + body, without children).

    The doc schema is expected to follow our outline model:
    - outlineSection: outlineHeading, outlineBody, outlineChildren
    """
    out: dict[str, str] = {}

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return

        if node.get("type") == "outlineSection":
            attrs = node.get("attrs") or {}
            section_id = str(attrs.get("id") or "").strip()
            content = node.get("content") or []

            heading_node = None
            body_node = None
            children_node = None
            for child in content if isinstance(content, list) else []:
                if not isinstance(child, dict):
                    continue
                ctype = child.get("type")
                if ctype == "outlineHeading" and heading_node is None:
                    heading_node = child
                elif ctype == "outlineBody" and body_node is None:
                    body_node = child
                elif ctype == "outlineChildren" and children_node is None:
                    children_node = child

            heading_plain = _normalize_plain(_pm_text(heading_node))
            body_plain = _normalize_plain(_pm_text(body_node))

            combined = "\n".join([p for p in [heading_plain, body_plain] if p]).strip()
            if section_id:
                out[section_id] = combined

            # Still traverse children sections for their own IDs.
            walk(children_node)
            return

        # Generic traversal.
        walk(node.get("content") or [])

    walk(doc_json)
    return out


def build_outline_section_plain_text(doc_json: Any, section_id: str) -> str:
    if not section_id:
        return ""
    return build_outline_section_plain_text_map(doc_json).get(section_id, "")

def build_outline_section_fragments_map(doc_json: Any) -> dict[str, dict[str, Any]]:
    """
    Returns mapping: outlineSection.attrs.id -> {heading: <node|None>, body: <node|None>}

    This is used for block history restore in outline mode: we restore only heading/body
    and keep current children intact.
    """
    out: dict[str, dict[str, Any]] = {}

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return

        if node.get("type") == "outlineSection":
            attrs = node.get("attrs") or {}
            section_id = str(attrs.get("id") or "").strip()
            content = node.get("content") or []

            heading_node: dict[str, Any] | None = None
            body_node: dict[str, Any] | None = None
            children_node: dict[str, Any] | None = None
            for child in content if isinstance(content, list) else []:
                if not isinstance(child, dict):
                    continue
                ctype = child.get("type")
                if ctype == "outlineHeading" and heading_node is None:
                    heading_node = child
                elif ctype == "outlineBody" and body_node is None:
                    body_node = child
                elif ctype == "outlineChildren" and children_node is None:
                    children_node = child

            if section_id:
                out[section_id] = {"heading": heading_node, "body": body_node}

            walk(children_node)
            return

        walk(node.get("content") or [])

    walk(doc_json)
    return out


_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _extract_internal_article_id_from_href(href: str) -> str | None:
    raw = (href or "").strip()
    if not raw:
        return None
    # Support both relative and absolute URLs.
    candidates: list[str] = []
    for prefix in ("/article/", "article/"):
        if raw.startswith(prefix):
            candidates.append(raw[len(prefix) :])
    if "://memus.pro/article/" in raw:
        candidates.append(raw.split("://memus.pro/article/", 1)[1])
    if "://www.memus.pro/article/" in raw:
        candidates.append(raw.split("://www.memus.pro/article/", 1)[1])

    for c in candidates:
        c = c.split("?", 1)[0].split("#", 1)[0].strip()
        if _UUID_RE.match(c):
            return c
    return None


def build_outline_section_internal_links_map(doc_json: Any) -> dict[str, set[str]]:
    """
    Returns mapping: outlineSection.attrs.id -> set(article_id) for internal links.
    Internal link = href to `/article/<uuid>` (or absolute memus.pro URL to that route).
    Links in children sections belong to those children (we don't attribute them to parent).
    """
    out: dict[str, set[str]] = {}

    def collect_links(node: Any, acc: set[str]) -> None:
        if node is None:
            return
        if isinstance(node, list):
            for item in node:
                collect_links(item, acc)
            return
        if not isinstance(node, dict):
            return

        marks = node.get("marks") or []
        if isinstance(marks, list):
            for m in marks:
                if not isinstance(m, dict):
                    continue
                if m.get("type") != "link":
                    continue
                attrs = m.get("attrs") or {}
                href = (attrs.get("href") or "") if isinstance(attrs, dict) else ""
                target = _extract_internal_article_id_from_href(str(href or ""))
                if target:
                    acc.add(target)

        collect_links(node.get("content") or [], acc)

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return

        if node.get("type") == "outlineSection":
            attrs = node.get("attrs") or {}
            section_id = str(attrs.get("id") or "").strip()
            content = node.get("content") or []
            heading_node = None
            body_node = None
            children_node = None
            for child in content if isinstance(content, list) else []:
                if not isinstance(child, dict):
                    continue
                ctype = child.get("type")
                if ctype == "outlineHeading" and heading_node is None:
                    heading_node = child
                elif ctype == "outlineBody" and body_node is None:
                    body_node = child
                elif ctype == "outlineChildren" and children_node is None:
                    children_node = child

            link_ids: set[str] = set()
            collect_links(heading_node, link_ids)
            collect_links(body_node, link_ids)
            if section_id:
                out[section_id] = link_ids

            walk(children_node)
            return

        walk(node.get("content") or [])

    walk(doc_json)
    return out
