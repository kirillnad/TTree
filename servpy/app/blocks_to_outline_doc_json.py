from __future__ import annotations

import html as html_mod
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _node_script_path() -> Path:
    return _repo_root() / "scripts" / "blocks_to_outline_doc_json.mjs"


_TAG_RE = re.compile(r"<[^>]+>")
_BR_RE = re.compile(r"(?i)<br\s*/?>")
_BLOCK_END_RE = re.compile(r"(?i)</(p|div|li|tr|h[1-6])\s*>")


def _html_to_plain_lines(html: str) -> list[str]:
    raw = str(html or "")
    raw = _BR_RE.sub("\n", raw)
    raw = _BLOCK_END_RE.sub("\n", raw)
    raw = raw.replace("&nbsp;", " ")
    raw = _TAG_RE.sub("", raw)
    raw = html_mod.unescape(raw)
    lines = [ln.rstrip() for ln in raw.split("\n")]
    # normalize multiple empty lines
    out: list[str] = []
    empty_run = 0
    for ln in lines:
        if ln.strip():
            empty_run = 0
            out.append(ln)
        else:
            empty_run += 1
            if empty_run <= 1:
                out.append("")
    while out and out[-1] == "":
        out.pop()
    return out


def _fallback_blocks_to_doc_json(blocks: list[dict]) -> dict[str, Any]:
    """
    Minimal best-effort converter (lossy) used only when node script isn't available.
    Produces a valid outline doc_json with sections and plain paragraphs.
    """

    def make_paragraph(text: str) -> dict[str, Any]:
        if text == "":
            return {"type": "paragraph"}
        return {"type": "paragraph", "content": [{"type": "text", "text": text}]}

    def convert_block(node: dict) -> dict[str, Any]:
        block_id = str(node.get("id") or "") or None
        collapsed = bool(node.get("collapsed"))
        html = node.get("text") or ""
        lines = _html_to_plain_lines(html)
        # Very simple heuristic: heading is first non-empty line.
        heading_text = ""
        body_lines = lines
        for i, ln in enumerate(lines):
            if ln.strip():
                heading_text = ln.strip()
                body_lines = lines[i + 1 :]
                break
        heading_content = [{"type": "text", "text": heading_text}] if heading_text else []
        body_nodes = [make_paragraph(ln) for ln in body_lines if ln != "" or True]
        section: dict[str, Any] = {
            "type": "outlineSection",
            "attrs": {"collapsed": collapsed},
            "content": [
                {"type": "outlineHeading", "content": heading_content},
                {"type": "outlineBody", "content": body_nodes or [{"type": "paragraph"}]},
                {"type": "outlineChildren", "content": []},
            ],
        }
        if block_id:
            section["attrs"]["id"] = block_id

        children = node.get("children") or []
        if isinstance(children, list) and children:
            section["content"][2]["content"] = [convert_block(c) for c in children if isinstance(c, dict)]
        return section

    content = [convert_block(b) for b in (blocks or []) if isinstance(b, dict)]
    if not content:
        # Always return a valid doc with a single empty section.
        content = [
            {
                "type": "outlineSection",
                "attrs": {"collapsed": False},
                "content": [
                    {"type": "outlineHeading", "content": []},
                    {"type": "outlineBody", "content": [{"type": "paragraph"}]},
                    {"type": "outlineChildren", "content": []},
                ],
            }
        ]
    return {"type": "doc", "content": content}


def convert_blocks_to_outline_doc_json(blocks: list[dict], *, fallback_id: str = "migration-root") -> dict[str, Any]:
    """
    Convert legacy blocks tree (rows_to_tree format) to outline TipTap doc_json.

    Prefer the Node converter script (preserves formatting much better),
    but fall back to a minimal lossy Python conversion if Node isn't available.
    """
    script = _node_script_path()
    if script.exists() and shutil.which("node") is not None:
        payload = {"blocks": blocks or [], "fallbackId": fallback_id}
        proc = subprocess.run(
            ["node", str(script)],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            check=False,
        )
        if proc.returncode == 0:
            out = (proc.stdout or "").strip()
            if out:
                try:
                    doc_json = json.loads(out)
                    if isinstance(doc_json, dict):
                        return doc_json
                except Exception:
                    pass
        # If Node failed, fall through to Python fallback.
    return _fallback_blocks_to_doc_json(blocks or [])

