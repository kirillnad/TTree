import importlib
import os
import sys
import warnings
from pathlib import Path

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
    test_db_url = os.getenv('SERVPY_TEST_DATABASE_URL')
    if not test_db_url:
        pytest.skip('SERVPY_TEST_DATABASE_URL is required for server tests (to avoid wiping a real DB)')
    monkeypatch.setenv('SERVPY_DATABASE_URL', test_db_url)

    db, data_store, main = _load_app()
    # main imports seed sample data; wipe to keep tests isolated
    for table in (
        'attachments',
        'blocks_fts',
        'outline_sections_fts',
        'articles_fts',
        'block_embeddings',
        'article_links',
        'article_versions',
        'applied_ops',
        'outline_section_meta',
        'sessions',
        'blocks',
        'articles',
        'users',
    ):
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
    # Password auth endpoints are disabled in routing; authenticate by creating a session directly.
    auth = importlib.import_module('servpy.app.auth')
    user = auth.create_user('test', 'test')
    sid = auth.create_session(user.id)
    client.cookies.set(auth.SESSION_COOKIE_NAME, sid)
    return client
