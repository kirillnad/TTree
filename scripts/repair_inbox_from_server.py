#!/usr/bin/env python3
"""
Repair inbox article on the server by rebuilding `articles.article_doc_json`
from server-side sources only:
  - current articles.article_doc_json
  - articles.history (outline-first entries)
  - article_versions.doc_json snapshots

This is intended for incident recovery when inbox docJson was accidentally rebuilt
from incomplete legacy sources and lost/emptied sections.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from servpy.app.data_store import get_article, save_article_doc_json
from servpy.app.db import CONN


def _iso_to_ms(iso: str | None) -> int:
    if not iso:
        return 0
    try:
        return int(datetime.fromisoformat(iso).timestamp() * 1000)
    except Exception:
        return 0


def _walk_outline_sections(doc_json: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for it in node:
                walk(it)
            return
        if not isinstance(node, dict):
            return
        if node.get("type") == "outlineSection":
            out.append(node)
            for child in node.get("content") or []:
                if isinstance(child, dict) and child.get("type") == "outlineChildren":
                    walk(child.get("content") or [])
                    break
            return
        walk(node.get("content") or [])

    walk(doc_json)
    return out


def _pick_child(section: dict[str, Any], node_type: str) -> dict[str, Any] | None:
    content = section.get("content") or []
    if not isinstance(content, list):
        return None
    for n in content:
        if isinstance(n, dict) and n.get("type") == node_type:
            return n
    return None


def _text_from_text_nodes(node: Any) -> str:
    if not node:
        return ""
    if isinstance(node, dict):
        if node.get("type") == "text":
            return str(node.get("text") or "")
        return "".join(_text_from_text_nodes(v) for v in node.values())
    if isinstance(node, list):
        return "".join(_text_from_text_nodes(v) for v in node)
    return ""


def _is_empty_heading(node: Any) -> bool:
    if not isinstance(node, dict) or node.get("type") != "outlineHeading":
        return True
    content = node.get("content") or []
    if not isinstance(content, list) or not content:
        return True
    return _text_from_text_nodes(content).strip() == ""


def _is_empty_body(node: Any) -> bool:
    if not isinstance(node, dict) or node.get("type") != "outlineBody":
        return True
    content = node.get("content") or []
    if not isinstance(content, list) or not content:
        return True
    # Treat single empty paragraph as empty
    if len(content) == 1 and isinstance(content[0], dict) and content[0].get("type") == "paragraph":
        txt = _text_from_text_nodes(content[0].get("content") or [])
        return txt.strip() == ""
    return False


def _make_paragraphs_from_plain(text: str) -> list[dict[str, Any]]:
    lines = [ln.strip() for ln in (text or "").splitlines()]
    lines = [ln for ln in lines if ln]
    if not lines:
        return [{"type": "paragraph"}]
    out: list[dict[str, Any]] = []
    for ln in lines:
        out.append({"type": "paragraph", "content": [{"type": "text", "text": ln}]})
    return out


def _ensure_section_shape(section_id: str, heading: Any | None, body: Any | None) -> dict[str, Any]:
    heading_node = heading if isinstance(heading, dict) and heading.get("type") == "outlineHeading" else {"type": "outlineHeading", "content": []}
    body_node = body if isinstance(body, dict) and body.get("type") == "outlineBody" else {"type": "outlineBody", "content": [{"type": "paragraph"}]}
    return {
        "type": "outlineSection",
        "attrs": {"id": section_id, "collapsed": False},
        "content": [
            heading_node,
            body_node,
            {"type": "outlineChildren", "content": []},
        ],
    }


@dataclass
class Candidate:
    section_id: str
    heading: dict[str, Any] | None
    body: dict[str, Any] | None
    ts_ms: int
    source: str


def _load_versions_doc_json(article_id: str) -> list[dict[str, Any]]:
    rows = CONN.execute(
        "SELECT doc_json, created_at FROM article_versions WHERE article_id = ? AND doc_json IS NOT NULL ORDER BY created_at DESC",
        (article_id,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows or []:
        raw = r["doc_json"]
        if not raw:
            continue
        try:
            d = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            continue
        if isinstance(d, dict) and d.get("type") == "doc":
            out.append(d)
    return out


def repair_inbox(user_id: str) -> dict[str, Any]:
    inbox_id = f"inbox-{user_id}"
    # Get server view of the article (docJson + history + blocks).
    article = get_article(inbox_id, author_id=user_id, include_blocks=True)
    if not article:
        raise RuntimeError(f"inbox not found: {inbox_id}")

    # Also include any other legacy inbox-* articles for this author (e.g. from recovery when userKey changed).
    other_inbox_ids: list[str] = []
    try:
        rows = CONN.execute(
            "SELECT id FROM articles WHERE author_id = ? AND id LIKE 'inbox-%' AND id <> ? AND deleted_at IS NULL",
            (user_id, inbox_id),
        ).fetchall()
        other_inbox_ids = [str(r["id"]) for r in rows or [] if r and r.get("id")]
    except Exception:
        other_inbox_ids = []

    current_doc = article.get("docJson")
    if not isinstance(current_doc, dict):
        current_doc = {"type": "doc", "content": []}

    # Build candidates from:
    # 1) current docJson
    # 2) history afterHeadingJson/afterBodyJson (latest wins)
    # 3) version snapshots
    candidates_by_id: dict[str, list[Candidate]] = {}

    def add_candidate(c: Candidate) -> None:
        candidates_by_id.setdefault(c.section_id, []).append(c)

    # current docJson
    for sec in _walk_outline_sections(current_doc):
        sid = str((sec.get("attrs") or {}).get("id") or "").strip()
        if not sid:
            continue
        add_candidate(
            Candidate(
                section_id=sid,
                heading=_pick_child(sec, "outlineHeading"),
                body=_pick_child(sec, "outlineBody"),
                ts_ms=_iso_to_ms(article.get("updatedAt")),
                source="current.docJson",
            )
        )

    # history
    history = article.get("history") or []
    if isinstance(history, list):
        for e in history:
            if not isinstance(e, dict):
                continue
            sid = str(e.get("blockId") or "").strip()
            if not sid:
                continue
            ts = _iso_to_ms(str(e.get("timestamp") or ""))
            h = e.get("afterHeadingJson")
            b = e.get("afterBodyJson")
            add_candidate(Candidate(section_id=sid, heading=h if isinstance(h, dict) else None, body=b if isinstance(b, dict) else None, ts_ms=ts, source="history.after"))

    # history + blocks from other inbox-* articles (server-side sources only)
    for other_id in other_inbox_ids:
        try:
            other = get_article(other_id, author_id=user_id, include_blocks=True) or {}
        except Exception:
            other = {}
        oh = other.get("history") or []
        if isinstance(oh, list):
            for e in oh:
                if not isinstance(e, dict):
                    continue
                sid = str(e.get("blockId") or "").strip()
                if not sid:
                    continue
                ts = _iso_to_ms(str(e.get("timestamp") or ""))
                h = e.get("afterHeadingJson")
                b = e.get("afterBodyJson")
                add_candidate(
                    Candidate(
                        section_id=sid,
                        heading=h if isinstance(h, dict) else None,
                        body=b if isinstance(b, dict) else None,
                        ts_ms=ts,
                        source=f"{other_id}.history.after",
                    )
                )
    # versions
    for vdoc in _load_versions_doc_json(inbox_id):
        for sec in _walk_outline_sections(vdoc):
            sid = str((sec.get("attrs") or {}).get("id") or "").strip()
            if not sid:
                continue
            add_candidate(
                Candidate(
                    section_id=sid,
                    heading=_pick_child(sec, "outlineHeading"),
                    body=_pick_child(sec, "outlineBody"),
                    ts_ms=0,
                    source="article_versions.doc_json",
                )
            )

    for other_id in other_inbox_ids:
        for vdoc in _load_versions_doc_json(other_id):
            for sec in _walk_outline_sections(vdoc):
                sid = str((sec.get("attrs") or {}).get("id") or "").strip()
                if not sid:
                    continue
                add_candidate(
                    Candidate(
                        section_id=sid,
                        heading=_pick_child(sec, "outlineHeading"),
                        body=_pick_child(sec, "outlineBody"),
                        ts_ms=0,
                        source=f"{other_id}.article_versions.doc_json",
                    )
                )

    # Pick best per section:
    # Prefer non-empty heading/body; newest timestamp wins.
    chosen: dict[str, dict[str, Any]] = {}
    ts_by_id: dict[str, int] = {}
    stats = {"sections": 0, "filled": 0, "added": 0}

    def score(c: Candidate) -> tuple[int, int]:
        # Higher is better: non-empty content + timestamp
        non_empty = 0
        if c.heading and not _is_empty_heading(c.heading):
            non_empty += 1
        if c.body and not _is_empty_body(c.body):
            non_empty += 1
        return (non_empty, c.ts_ms)

    for sid, lst in candidates_by_id.items():
        best = None
        best_score = (-1, -1)
        for c in lst:
            sc = score(c)
            if sc > best_score:
                best_score = sc
                best = c
        if not best:
            continue
        heading = best.heading if best.heading else {"type": "outlineHeading", "content": []}
        body = best.body if best.body else {"type": "outlineBody", "content": [{"type": "paragraph"}]}
        chosen[sid] = _ensure_section_shape(sid, heading, body)
        ts_by_id[sid] = best.ts_ms

    # Final order: newest first (inbox UX).
    ordered_ids = sorted(chosen.keys(), key=lambda sid: (ts_by_id.get(sid, 0), sid), reverse=True)
    rebuilt = {"type": "doc", "content": [chosen[sid] for sid in ordered_ids]}

    # Save as server truth.
    save_article_doc_json(article_id=inbox_id, author_id=user_id, doc_json=rebuilt, create_version_if_stale_hours=None)

    stats["sections"] = len(ordered_ids)
    return {"status": "ok", "articleId": inbox_id, "sections": len(ordered_ids)}


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: scripts/repair_inbox_from_server.py <user_id>", file=sys.stderr)
        return 2
    user_id = argv[1].strip()
    if not user_id:
        print("user_id required", file=sys.stderr)
        return 2
    res = repair_inbox(user_id)
    print(json.dumps(res, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
