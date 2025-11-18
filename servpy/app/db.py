from __future__ import annotations

import sqlite3
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / 'servpy.sqlite'

CONN = sqlite3.connect(DB_PATH, check_same_thread=False)
CONN.row_factory = sqlite3.Row
CONN.execute('PRAGMA foreign_keys = ON')
CONN.execute('PRAGMA journal_mode = WAL')


def cursor():
    return CONN.cursor()


def execute(sql: str, params: tuple | None = None):
    with CONN:
        cur = CONN.execute(sql, params or ())
    return cur


def executemany(sql: str, seq):
    with CONN:
        CONN.executemany(sql, seq)
