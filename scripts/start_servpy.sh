#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PGDATA_DIR=${PGDATA_DIR:-"$HOME/pgdata"}
PGPORT=${PGPORT:-5544}
DEFAULT_SERVPY_URL="postgresql+psycopg:///ttree?host=${PGDATA_DIR}&port=${PGPORT}"
export SERVPY_DATABASE_URL=${SERVPY_DATABASE_URL:-$DEFAULT_SERVPY_URL}

# Try to start PostgreSQL if pg_ctl and data directory are available.
PG_CTL_BIN=${PG_CTL_BIN:-}
if [[ -z "${PG_CTL_BIN}" ]]; then
  if command -v pg_ctl >/dev/null 2>&1; then
    PG_CTL_BIN=$(command -v pg_ctl)
  elif [[ -x "$HOME/pg16/bin/pg_ctl" ]]; then
    PG_CTL_BIN="$HOME/pg16/bin/pg_ctl"
  fi
fi

if [[ -n "${PG_CTL_BIN:-}" && -d "$PGDATA_DIR" ]]; then
  if ! "$PG_CTL_BIN" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    echo "[start_servpy] starting postgres cluster in $PGDATA_DIR"
    "$PG_CTL_BIN" -D "$PGDATA_DIR" -l "$PGDATA_DIR/logfile" start
  fi
else
  echo "[start_servpy] warning: pg_ctl or data dir not found, skipping postgres start" >&2
fi

HOST=${HOST:-0.0.0.0}
PORT=${PORT:-4500}
PYTHON_BIN=${PYTHON_BIN:-python3}

exec "$PYTHON_BIN" -m uvicorn servpy.app.main:app --host "$HOST" --port "$PORT"
