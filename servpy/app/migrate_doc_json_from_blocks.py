from __future__ import annotations

import json
import shutil
import subprocess
import sys
from argparse import ArgumentParser
from pathlib import Path

from .db import CONN
from .schema import init_schema
from .data_store import rows_to_tree


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _node_script_path() -> Path:
    return _repo_root() / "scripts" / "blocks_to_outline_doc_json.mjs"


def _convert_blocks_to_doc_json(blocks: list[dict]) -> dict:
    script = _node_script_path()
    if not script.exists():
        raise RuntimeError(f"Node converter not found: {script}")
    if shutil.which("node") is None:
        raise RuntimeError("node is not installed or not in PATH")

    payload = {"blocks": blocks, "fallbackId": "migration-root"}
    proc = subprocess.run(
        ["node", str(script)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"node failed: {proc.stderr.strip()}")
    out = (proc.stdout or "").strip()
    if not out:
        raise RuntimeError("node returned empty output")
    return json.loads(out)


def migrate(*, limit: int | None = None, force: bool = False, dry_run: bool = False) -> None:
    init_schema()

    where = "deleted_at IS NULL"
    if not force:
        where += " AND (article_doc_json IS NULL OR article_doc_json = '')"

    rows = CONN.execute(
        f"""
        SELECT id, author_id, title
        FROM articles
        WHERE {where}
        ORDER BY updated_at DESC
        """
    ).fetchall()

    total = len(rows)
    if total == 0:
        if force:
            print("No articles to migrate.")
        else:
            print("No articles to migrate (article_doc_json already filled).")
        return

    migrated = 0
    failed = 0
    for idx, row in enumerate(rows, start=1):
        if limit is not None and migrated >= limit:
            break
        article_id = row["id"]
        title = row.get("title") or ""
        try:
            blocks = rows_to_tree(article_id)
            doc_json = _convert_blocks_to_doc_json(blocks)
            if not dry_run:
                CONN.execute(
                    "UPDATE articles SET article_doc_json = ? WHERE id = ?",
                    (json.dumps(doc_json, ensure_ascii=False), article_id),
                )
            migrated += 1
            if migrated % 25 == 0 or migrated == 1:
                suffix = " (dry-run)" if dry_run else ""
                print(f"[{idx}/{total}] migrated {migrated}{suffix} (last: {article_id} {title!r})")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"[{idx}/{total}] FAILED {article_id} {title!r}: {exc}", file=sys.stderr)

    print(f"Done. Migrated={migrated}, Failed={failed}, TotalCandidates={total}")


def main() -> None:
    parser = ArgumentParser(description="Migrate articles.blocks HTML into articles.article_doc_json (TipTap outline JSON).")
    parser.add_argument("limit", nargs="?", type=int, default=None, help="Optional limit of articles to migrate.")
    parser.add_argument("--force", action="store_true", help="Overwrite article_doc_json even if already present.")
    parser.add_argument("--dry-run", action="store_true", help="Run conversion but do not write to DB.")
    args = parser.parse_args()
    migrate(limit=args.limit, force=bool(args.force), dry_run=bool(args.dry_run))


if __name__ == "__main__":
    main()
