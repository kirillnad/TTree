#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# By default use system PostgreSQL (local socket) and database `ttree`.
DEFAULT_SERVPY_URL="postgresql+psycopg:///ttree"
export SERVPY_DATABASE_URL=${SERVPY_DATABASE_URL:-$DEFAULT_SERVPY_URL}

HOST=${HOST:-0.0.0.0}
PORT=${PORT:-4500}
PYTHON_BIN=${PYTHON_BIN:-python3}

exec "$PYTHON_BIN" -m uvicorn servpy.app.main:app --host "$HOST" --port "$PORT"
