from __future__ import annotations

import html as html_mod
import json
import logging
import subprocess
from pathlib import Path
from typing import Any


logger = logging.getLogger('uvicorn.error')


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _node_script_path() -> Path:
    return _repo_root() / "scripts" / "outline_doc_json_to_html.mjs"


def render_outline_doc_json_html(doc_json: Any) -> str:
    """
    Server-side renderer for outline TipTap doc_json → HTML (for export/public pages).

    Note: This uses Node + local TipTap deps. This is intentionally not used for
    the authenticated in-app editor UI (which renders client-side).
    """
    if not doc_json:
        return ""

    # Prefer Node renderer (matches client HTML closely), but always have a Python fallback
    # so public/export pages work even when Node isn't installed on the server.
    try:
        script = _node_script_path()
        if not script.exists():
            raise RuntimeError(f"Node renderer not found: {script}")
        payload = {"docJson": doc_json}
        proc = subprocess.run(
            ["node", str(script)],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"node render failed: {(proc.stderr or '').strip()}")
        return (proc.stdout or "").strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("doc_json_render: Node renderer failed, falling back to Python: %r", exc)
        try:
            return _render_outline_doc_json_html_py(doc_json)
        except Exception as exc2:  # noqa: BLE001
            logger.warning("doc_json_render: Python fallback failed: %r", exc2)
            return ""


def render_outline_doc_json_outline_view_html(doc_json: Any) -> str:
    """
    Server-side renderer for outline TipTap doc_json → HTML that matches our in-app
    outline "view-mode" DOM structure (`.outline-section/.outline-heading/.outline-body`).

    Used for public pages, where we want identical rendering but no edit mode.
    """
    if not doc_json:
        return ""
    # For "view-mode" markup we intentionally use the Python renderer to keep output stable
    # even when Node isn't installed on the server.
    try:
        return _render_outline_view_doc_json_html_py(doc_json)
    except Exception as exc:  # noqa: BLE001
        logger.warning("doc_json_render: outline-view render failed: %r", exc)
        return ""


def _escape_attr(value: Any) -> str:
    return html_mod.escape(str(value or ""), quote=True)


def _render_inline(node: Any) -> str:
    if node is None:
        return ""
    if isinstance(node, list):
        return "".join(_render_inline(x) for x in node)
    if not isinstance(node, dict):
        return ""
    t = str(node.get("type") or "")
    if t == "text":
        txt = html_mod.escape(str(node.get("text") or ""))
        marks = node.get("marks") or []
        # Wrap in marks (simple nesting; order as provided).
        if isinstance(marks, list):
            for m in marks:
                if not isinstance(m, dict):
                    continue
                mt = str(m.get("type") or "")
                attrs = m.get("attrs") or {}
                if mt == "bold":
                    txt = f"<strong>{txt}</strong>"
                elif mt == "italic":
                    txt = f"<em>{txt}</em>"
                elif mt == "strike":
                    txt = f"<s>{txt}</s>"
                elif mt == "code":
                    txt = f"<code>{txt}</code>"
                elif mt == "link":
                    href = ""
                    if isinstance(attrs, dict):
                        href = str(attrs.get("href") or "")
                    safe_href = _escape_attr(href)
                    txt = f'<a href="{safe_href}">{txt}</a>'
        return txt
    if t == "hardBreak":
        return "<br />"
    if t == "image":
        attrs = node.get("attrs") or {}
        if not isinstance(attrs, dict):
            attrs = {}
        src = str(attrs.get("src") or "")
        if not src:
            return ""
        alt = str(attrs.get("alt") or "")
        title = str(attrs.get("title") or "")
        width = attrs.get("width") or 320
        try:
            w = int(float(width))
        except Exception:
            w = 320
        w = max(1, w)
        safe_src = _escape_attr(src)
        safe_alt = _escape_attr(alt)
        safe_title = _escape_attr(title)
        return (
            f'<span class="resizable-image" style="width:{w}px;max-width:100%;">'
            f'<span class="resizable-image__inner"><img src="{safe_src}" alt="{safe_alt}" title="{safe_title}" draggable="false"></span>'
            f'<span class="resizable-image__handle" data-direction="e" aria-hidden="true"></span>'
            f"</span>"
        )

    # Default: recurse into inline-ish content.
    return _render_inline(node.get("content") or [])


def _render_block(node: Any) -> str:
    if node is None:
        return ""
    if isinstance(node, list):
        return "".join(_render_block(x) for x in node)
    if not isinstance(node, dict):
        return ""
    t = str(node.get("type") or "")
    content = node.get("content") or []

    if t == "paragraph":
        inner = _render_inline(content)
        return f"<p>{inner}</p>"
    if t == "heading":
        attrs = node.get("attrs") or {}
        lvl = 1
        if isinstance(attrs, dict):
            try:
                lvl = int(attrs.get("level") or 1)
            except Exception:
                lvl = 1
        lvl = max(1, min(6, lvl))
        inner = _render_inline(content)
        return f"<h{lvl}>{inner}</h{lvl}>"
    if t == "blockquote":
        inner = _render_block(content)
        return f"<blockquote>{inner}</blockquote>"
    if t == "codeBlock":
        txt = html_mod.escape(str(node.get("text") or "")) if "text" in node else html_mod.escape(_render_inline(content))
        return f"<pre><code>{txt}</code></pre>"
    if t == "bulletList":
        items = "".join(_render_block(x) for x in content)
        return f"<ul>{items}</ul>"
    if t == "orderedList":
        items = "".join(_render_block(x) for x in content)
        return f"<ol>{items}</ol>"
    if t == "listItem":
        inner = _render_block(content)
        return f"<li>{inner}</li>"
    if t == "table":
        inner = "".join(_render_block(x) for x in content)
        return f"<div class=\"tableWrapper\"><table><tbody>{inner}</tbody></table></div>"
    if t == "tableRow":
        inner = "".join(_render_block(x) for x in content)
        return f"<tr>{inner}</tr>"
    if t == "tableHeader":
        inner = _render_block(content)
        return f"<th>{inner}</th>"
    if t == "tableCell":
        inner = _render_block(content)
        return f"<td>{inner}</td>"

    # Fallback: treat as container.
    return _render_block(content)


def _render_outline_doc_section(section_node: dict[str, Any], depth: int) -> str:
    sid = ""
    attrs = section_node.get("attrs") or {}
    if isinstance(attrs, dict):
        sid = str(attrs.get("id") or "")
    content = section_node.get("content") or []
    if not isinstance(content, list):
        content = []
    heading_node = next((c for c in content if isinstance(c, dict) and c.get("type") == "outlineHeading"), None)
    body_node = next((c for c in content if isinstance(c, dict) and c.get("type") == "outlineBody"), None)
    children_node = next((c for c in content if isinstance(c, dict) and c.get("type") == "outlineChildren"), None)

    level = max(1, min(6, int(depth or 1)))
    heading_html = _render_block(
        {"type": "heading", "attrs": {"level": level}, "content": (heading_node or {}).get("content") or []}
    )
    body_html = _render_block((body_node or {}).get("content") or [])
    children = (children_node or {}).get("content") or []
    if not isinstance(children, list):
        children = []
    children_html = "".join(
        _render_outline_doc_section(c, depth + 1)
        for c in children
        if isinstance(c, dict) and c.get("type") == "outlineSection"
    )
    return f'<section class="doc-section" data-section-id="{_escape_attr(sid)}">{heading_html}{body_html}{children_html}</section>'


def _render_outline_doc_json_html_py(doc_json: Any) -> str:
    if not isinstance(doc_json, dict):
        return ""
    content = doc_json.get("content") or []
    if not isinstance(content, list):
        return ""
    sections = [n for n in content if isinstance(n, dict) and n.get("type") == "outlineSection"]
    return "\n".join(_render_outline_doc_section(s, 1) for s in sections)


def _render_outline_view_section(section_node: dict[str, Any], depth: int) -> str:
    attrs = section_node.get("attrs") or {}
    if not isinstance(attrs, dict):
        attrs = {}
    sid = str(attrs.get("id") or "")
    collapsed = bool(attrs.get("collapsed", False))
    content = section_node.get("content") or []
    if not isinstance(content, list):
        content = []

    heading_node = next((c for c in content if isinstance(c, dict) and c.get("type") == "outlineHeading"), None)
    body_node = next((c for c in content if isinstance(c, dict) and c.get("type") == "outlineBody"), None)
    children_node = next((c for c in content if isinstance(c, dict) and c.get("type") == "outlineChildren"), None)

    heading_content = (heading_node or {}).get("content") or []
    body_content = (body_node or {}).get("content") or []

    heading_html = _render_inline(heading_content).strip()
    is_empty_heading = not bool(html_mod.unescape(re.sub(r"<[^>]+>", "", heading_html)).strip())
    if is_empty_heading:
        heading_html = '<br class="ProseMirror-trailingBreak">'

    body_html = _render_block(body_content).strip()
    if not body_html:
        body_html = '<p><br class="ProseMirror-trailingBreak"></p>'

    children = (children_node or {}).get("content") or []
    if not isinstance(children, list):
        children = []
    child_html = "".join(
        _render_outline_view_section(c, depth + 1)
        for c in children
        if isinstance(c, dict) and c.get("type") == "outlineSection"
    )

    d = max(1, min(6, int(depth or 1)))
    collapsed_attr = "true" if collapsed else "false"
    empty_attr = "true" if is_empty_heading else "false"
    safe_sid = _escape_attr(sid)
    return (
        f'<div class="outline-section" data-outline-section="true" data-section-id="{safe_sid}" '
        f'data-collapsed="{collapsed_attr}" collapsed="{collapsed_attr}">'
        f'<div class="outline-heading" data-outline-heading="true" data-empty="{empty_attr}" data-depth="{d}">'
        '<button type="button" class="outline-heading__toggle" aria-label="Свернуть/развернуть"></button>'
        f'<div class="outline-heading__content">{heading_html}</div>'
        "</div>"
        f'<div class="outline-body" data-outline-body="true">{body_html}</div>'
        f'<div class="outline-children" data-outline-children="true">{child_html}</div>'
        "</div>"
    )


def _render_outline_view_doc_json_html_py(doc_json: Any) -> str:
    if not isinstance(doc_json, dict):
        return ""
    content = doc_json.get("content") or []
    if not isinstance(content, list):
        return ""
    sections = [n for n in content if isinstance(n, dict) and n.get("type") == "outlineSection"]
    return "\n".join(_render_outline_view_section(s, 1) for s in sections)
