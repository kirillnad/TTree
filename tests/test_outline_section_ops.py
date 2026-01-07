from __future__ import annotations

import json
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from tests.test_api import create_article


def _heading(text: str) -> dict:
    if not text:
        return {"type": "outlineHeading"}
    return {
        "type": "outlineHeading",
        "content": [{"type": "text", "text": text}],
    }


def _body(text: str) -> dict:
    if not text:
        return {"type": "outlineBody", "content": [{"type": "paragraph"}]}
    return {
        "type": "outlineBody",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}],
    }


def test_section_upsert_seq_stale_and_history_window(client: TestClient):
    created = create_article(client, title="Outline ops")
    article_id = created["id"]
    section_id = "sec-1"

    # 1) First upsert creates section at root and creates first history entry.
    resp = client.put(
        f"/api/articles/{article_id}/sections/upsert-content",
        json={"sectionId": section_id, "headingJson": _heading(""), "bodyJson": _body("hello"), "seq": 1},
    )
    assert resp.status_code == 200
    assert resp.json().get("status") == "ok"

    # Verify section exists in stored article_doc_json.
    row = client.app_db.execute("SELECT article_doc_json FROM articles WHERE id = ?", (article_id,)).fetchone()
    assert row and row.get("article_doc_json")
    doc = json.loads(row["article_doc_json"])
    root_content = doc.get("content") or []
    assert any(
        isinstance(n, dict) and n.get("type") == "outlineSection" and (n.get("attrs") or {}).get("id") == section_id
        for n in root_content
    )

    hist = client.get(f"/api/articles/{article_id}/blocks/{section_id}/history?limit=20").json()["entries"]
    assert len(hist) == 1
    assert hist[0]["before"] == ""
    assert "hello" in (hist[0]["after"] or "")
    first_entry_id = hist[0]["id"]

    # 2) Second upsert within 1 hour updates the existing history entry (sliding window).
    resp2 = client.put(
        f"/api/articles/{article_id}/sections/upsert-content",
        json={"sectionId": section_id, "headingJson": _heading(""), "bodyJson": _body("hello2"), "seq": 2},
    )
    assert resp2.status_code == 200
    assert resp2.json().get("status") == "ok"

    hist2 = client.get(f"/api/articles/{article_id}/blocks/{section_id}/history?limit=20").json()["entries"]
    assert len(hist2) == 1
    assert hist2[0]["id"] == first_entry_id
    assert "hello2" in (hist2[0]["after"] or "")
    assert hist2[0].get("updatedAt")  # added on sliding update

    # 3) Stale seq is ignored (server should not apply changes).
    stale = client.put(
        f"/api/articles/{article_id}/sections/upsert-content",
        json={"sectionId": section_id, "headingJson": _heading(""), "bodyJson": _body("STale"), "seq": 2},
    )
    assert stale.status_code == 200
    assert stale.json().get("status") == "ignored"

    hist3 = client.get(f"/api/articles/{article_id}/blocks/{section_id}/history?limit=20").json()["entries"]
    assert len(hist3) == 1
    assert "hello2" in (hist3[0]["after"] or "")

    # 4) Force the history window to be old (> 1h) and ensure a new history entry is created.
    old = (datetime.utcnow() - timedelta(hours=2)).isoformat()
    client.app_db.execute(
        "UPDATE outline_section_meta SET history_window_started_at = ? WHERE article_id = ? AND section_id = ?",
        (old, article_id, section_id),
    )

    resp3 = client.put(
        f"/api/articles/{article_id}/sections/upsert-content",
        json={"sectionId": section_id, "headingJson": _heading(""), "bodyJson": _body("hello3"), "seq": 3},
    )
    assert resp3.status_code == 200
    assert resp3.json().get("status") == "ok"

    hist4 = client.get(f"/api/articles/{article_id}/blocks/{section_id}/history?limit=20").json()["entries"]
    assert len(hist4) == 2
    assert "hello3" in (hist4[0]["after"] or "")
    assert hist4[0]["id"] != first_entry_id

