from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, Result, RowMapping


def _resolve_database_url() -> str:
    env_url = os.getenv('SERVPY_DATABASE_URL')
    if env_url:
        if env_url.startswith('sqlite:///'):
            path_part = env_url.replace('sqlite:///', '', 1)
            if path_part and path_part != ':memory:':
                db_file = Path(path_part)
                db_file.parent.mkdir(parents=True, exist_ok=True)
        return env_url

    data_dir = Path(__file__).resolve().parent.parent / 'data'
    data_dir.mkdir(parents=True, exist_ok=True)
    db_path = data_dir / 'servpy.sqlite'
    return f'sqlite:///{db_path}'


DATABASE_URL = _resolve_database_url()
CONNECT_ARGS: dict[str, Any] = {}
if DATABASE_URL.startswith('sqlite'):
    CONNECT_ARGS['check_same_thread'] = False

engine: Engine = create_engine(
    DATABASE_URL,
    future=True,
    echo=False,
    connect_args=CONNECT_ARGS,
    pool_pre_ping=True,
)

DIALECT_NAME = engine.dialect.name
IS_SQLITE = DIALECT_NAME == 'sqlite'
IS_POSTGRES = DIALECT_NAME == 'postgresql'


if IS_SQLITE:
    @event.listens_for(engine, 'connect')
    def _set_sqlite_pragmas(dbapi_connection, connection_record):  # type: ignore[override]
        cursor = dbapi_connection.cursor()
        cursor.execute('PRAGMA foreign_keys = ON')
        cursor.execute('PRAGMA journal_mode = WAL')
        cursor.close()


class Database:
    """
    Thin helper over SQLAlchemy engine to preserve the old CONN.execute API.
    Supports context manager for a shared transaction inside `with CONN:`.
    """

    def __init__(self, engine: Engine):
        self.engine = engine
        self._conn = None
        self._tx = None

    class QueryResult:
        def __init__(self, rows: list[RowMapping]):
            self._rows = rows

        def fetchall(self):
            return self._rows

        def fetchone(self):
            return self._rows[0] if self._rows else None

    def __enter__(self):
        self._tx = self.engine.begin()
        self._conn = self._tx.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if self._tx is not None:
                return self._tx.__exit__(exc_type, exc, tb)
        finally:
            self._conn = None
            self._tx = None
        return False

    def _prepare_statement(self, sql: str, params: Any | None):
        if not IS_POSTGRES or params is None:
            return sql, params
        if isinstance(params, dict):
            return sql, params
        replacement = sql.replace('?', '%s')
        return replacement, params

    def _run(self, conn, sql: str, params: Any | None = None) -> Result | QueryResult:
        sql, params = self._prepare_statement(sql, params)
        result: Result = conn.exec_driver_sql(sql, params or ())
        if result.returns_rows:
            rows = result.mappings().all()
            result.close()
            return self.QueryResult(rows)
        return result

    def execute(self, sql: str, params: Any | None = None) -> Result | QueryResult:
        if isinstance(sql, str) and 'DELETE FROM blocks_fts' in sql and 'WHERE article_id' not in sql:
            # Полное удаление индекса блоков — помечаем поисковые индексы как «грязные».
            mark_search_index_dirty()
        if self._conn is not None:
            return self._run(self._conn, sql, params)
        with self.engine.begin() as conn:
            return self._run(conn, sql, params)

    def executemany(self, sql: str, seq: Iterable[Any]) -> Result | QueryResult:
        if self._conn is not None:
            return self._run(self._conn, sql, seq)
        with self.engine.begin() as conn:
            return self._run(conn, sql, seq)

    def cursor(self):
        return self.engine.raw_connection().cursor()


CONN = Database(engine)

# Глобальное состояние индексов поиска.
SEARCH_INDEX_DIRTY = False


def mark_search_index_dirty() -> None:
    # noqa: D401
    """Помечает индексы поиска как «грязные» (stale) после явной очистки FTS."""
    global SEARCH_INDEX_DIRTY
    # Если ещё нет статей, считаем очистку частью инициализации.
    row = CONN.execute('SELECT COUNT(*) AS c FROM articles').fetchone()
    count_articles = int(row['c']) if row and row['c'] is not None else 0
    if count_articles == 0:
        SEARCH_INDEX_DIRTY = False
    else:
        SEARCH_INDEX_DIRTY = True


def mark_search_index_clean() -> None:
    # noqa: D401
    """Помечает индексы поиска как актуальные."""
    global SEARCH_INDEX_DIRTY
    SEARCH_INDEX_DIRTY = False


def cursor():
    return CONN.cursor()


def execute(sql: str, params: Any | None = None):
    return CONN.execute(sql, params)


def executemany(sql: str, seq):
    return CONN.executemany(sql, seq)
