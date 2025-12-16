from __future__ import annotations

"""
One-off utility: rebuild article_links for all existing (not deleted) articles.

Usage (from repo root):

    SERVPY_DATABASE_URL=postgresql+psycopg:///ttree python3 rebuild_article_links.py
"""

from servpy.app.db import CONN
from servpy.app.data_store import _rebuild_article_links_for_article_id  # type: ignore[attr-defined]


def main() -> None:
  rows = CONN.execute(
      'SELECT id FROM articles WHERE deleted_at IS NULL',
  ).fetchall()
  total = 0
  for row in rows or []:
    article_id = row.get('id')
    if not article_id:
      continue
    _rebuild_article_links_for_article_id(article_id)
    total += 1
  print(f'Rebuilt article_links for {total} articles')


if __name__ == '__main__':
  main()
