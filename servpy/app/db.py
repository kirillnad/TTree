from __future__ import annotations

import os
import threading
from typing import Any, Iterable

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, Result, RowMapping


def _resolve_database_url() -> str:
    env_url = os.getenv('SERVPY_DATABASE_URL')
    if not env_url:
        raise RuntimeError('SERVPY_DATABASE_URL is required (PostgreSQL only)')
    return env_url


DATABASE_URL = _resolve_database_url()

DB_POOL_SIZE = int(os.environ.get('SERVPY_DB_POOL_SIZE') or '10')
DB_MAX_OVERFLOW = int(os.environ.get('SERVPY_DB_MAX_OVERFLOW') or '20')
DB_POOL_TIMEOUT = int(os.environ.get('SERVPY_DB_POOL_TIMEOUT') or '60')

engine: Engine = create_engine(
    DATABASE_URL,
    future=True,
    echo=False,
    pool_pre_ping=True,
    pool_size=max(1, DB_POOL_SIZE),
    max_overflow=max(0, DB_MAX_OVERFLOW),
    pool_timeout=max(1, DB_POOL_TIMEOUT),
)

DIALECT_NAME = engine.dialect.name
IS_POSTGRES = DIALECT_NAME == 'postgresql'
if not IS_POSTGRES:
    raise RuntimeError(f'Unsupported DB dialect {DIALECT_NAME!r}; PostgreSQL only')


@event.listens_for(engine, 'connect')
def _set_postgres_options(dbapi_connection, connection_record):  # type: ignore[override]
    # Вынесено из app/main.py → app/db.py. Здесь оставляем хук на connect,
    # чтобы при необходимости добавлять postgres-настройки в одном месте.
    try:
        probes_raw = os.environ.get('SERVPY_PGVECTOR_IVFFLAT_PROBES')
        if probes_raw is None:
            return
        probes = int(probes_raw)
        if probes <= 0:
            return
        cur = dbapi_connection.cursor()
        cur.execute(f'SET ivfflat.probes = {probes}')
        try:
            cur.close()
        except Exception:
            pass
    except Exception:
        # Не блокируем подключение из-за настроек.
        return


class Database:
    """
    Thin helper over SQLAlchemy engine to preserve the old CONN.execute API.
    Supports context manager for a shared transaction inside `with CONN:`.
    """

    def __init__(self, engine: Engine):
        self.engine = engine
        # NOTE: This object is global (`CONN`) and used concurrently by FastAPI worker threads.
        # Transaction/connection state must be stored per-thread, otherwise concurrent `with CONN:`
        # will clobber shared state and crash with "ValueError: generator already executing".
        self._local = threading.local()

    def _get_local_conn(self):
        return getattr(self._local, 'conn', None)

    def _set_local_conn(self, conn):
        setattr(self._local, 'conn', conn)

    def _get_local_tx(self):
        return getattr(self._local, 'tx', None)

    def _set_local_tx(self, tx):
        setattr(self._local, 'tx', tx)

    def _get_local_depth(self) -> int:
        return int(getattr(self._local, 'depth', 0) or 0)

    def _set_local_depth(self, depth: int) -> None:
        setattr(self._local, 'depth', int(depth))

    class QueryResult:
        def __init__(self, rows: list[RowMapping]):
            self._rows = rows

        def fetchall(self):
            return self._rows

        def fetchone(self):
            return self._rows[0] if self._rows else None

    def __enter__(self):
        depth = self._get_local_depth()
        if depth <= 0:
            tx = self.engine.begin()
            conn = tx.__enter__()
            self._set_local_tx(tx)
            self._set_local_conn(conn)
            self._set_local_depth(1)
        else:
            # Re-entrant: reuse the same transaction/connection in the same thread.
            self._set_local_depth(depth + 1)
        return self

    def __exit__(self, exc_type, exc, tb):
        depth = self._get_local_depth()
        if depth <= 0:
            return False
        # Only the outermost exit commits/rollbacks.
        if depth > 1:
            self._set_local_depth(depth - 1)
            return False
        try:
            tx = self._get_local_tx()
            if tx is not None:
                return tx.__exit__(exc_type, exc, tb)
        finally:
            self._set_local_conn(None)
            self._set_local_tx(None)
            self._set_local_depth(0)
        return False

    def _prepare_statement(self, sql: str, params: Any | None):
        if params is None:
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
        conn = self._get_local_conn()
        if conn is not None:
            return self._run(conn, sql, params)
        with self.engine.begin() as conn:
            return self._run(conn, sql, params)

    def executemany(self, sql: str, seq: Iterable[Any]) -> Result | QueryResult:
        conn = self._get_local_conn()
        if conn is not None:
            return self._run(conn, sql, seq)
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
