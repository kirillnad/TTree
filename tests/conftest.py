import importlib
import os
import sys
import warnings

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

warnings.filterwarnings(
    'ignore',
    message="The 'app' shortcut is now deprecated.*",
    category=DeprecationWarning,
)
warnings.filterwarnings('ignore', category=DeprecationWarning, module='httpx._client')


def _load_app():
    # Force fresh imports so SERVPY_DATABASE_URL is picked up for each test DB.
    for mod in list(sys.modules):
        if mod.startswith('servpy.app'):
            sys.modules.pop(mod)
    importlib.invalidate_caches()
    db = importlib.import_module('servpy.app.db')
    importlib.import_module('servpy.app.schema')
    data_store = importlib.import_module('servpy.app.data_store')
    main = importlib.import_module('servpy.app.main')
    return db, data_store, main


@pytest.fixture()
def app_env(monkeypatch, tmp_path_factory):
    if not os.getenv('SERVPY_DATABASE_URL'):
        pytest.skip('SERVPY_DATABASE_URL is required for server tests (PostgreSQL)')

    db, data_store, main = _load_app()
    # main imports seed sample data; wipe to keep tests isolated
    for table in ('attachments', 'blocks_fts', 'articles_fts', 'blocks', 'articles', 'users'):
        try:
            db.execute(f'DELETE FROM {table}')
        except Exception:
            pass

    return {'db': db, 'data_store': data_store, 'app': main.app}


@pytest.fixture()
def client(app_env):
    client = TestClient(app_env['app'])
    client.app_db = app_env['db']
    client.data_store = app_env['data_store']
    # Register and authenticate default test user so API is usable in tests.
    resp = client.post('/api/auth/register', json={'username': 'test', 'password': 'test'})
    assert resp.status_code == 200
    return client
