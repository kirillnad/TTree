from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any


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

