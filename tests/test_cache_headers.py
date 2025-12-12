from __future__ import annotations

from fastapi.testclient import TestClient


def _assert_no_cache_headers(resp):
  # Все эти заголовки должны быть выставлены middleware
  # disable_client_caching для HTML/CSS/JS-ответов.
  assert resp.headers.get('cache-control') == 'no-store, no-cache, must-revalidate'
  assert resp.headers.get('pragma') == 'no-cache'
  assert resp.headers.get('expires') == '0'


def test_html_css_js_responses_are_not_cached(client: TestClient):
  # Главная страница SPA
  html = client.get('/')
  assert html.status_code == 200
  assert 'text/html' in (html.headers.get('content-type') or '')
  _assert_no_cache_headers(html)

  # Основные статические ресурсы фронтенда
  css = client.get('/style.css')
  assert css.status_code == 200
  assert 'text/css' in (css.headers.get('content-type') or '')
  _assert_no_cache_headers(css)

  js = client.get('/app.js')
  # В теории app.js может отсутствовать, если сборка другая,
  # поэтому проверяем заголовки только при успешной выдаче.
  if js.status_code == 200:
    ctype = (js.headers.get('content-type') or '').lower()
    assert 'javascript' in ctype or 'text/plain' in ctype
    _assert_no_cache_headers(js)


def test_uploads_are_not_forced_no_cache(client: TestClient):
  # Создаём статью и загружаем вложение, чтобы получить валидный /uploads/... URL.
  created = client.post('/api/articles', json={'title': 'Cache test'})
  assert created.status_code == 200
  article_id = created.json()['id']

  file_bytes = b'hello world'
  upload = client.post(
    f'/api/articles/{article_id}/attachments',
    files={'file': ('note.txt', file_bytes, 'text/plain')},
  )
  assert upload.status_code == 200
  stored_path = upload.json()['storedPath']

  resp = client.get(stored_path)
  assert resp.status_code == 200
  # Для /uploads/* middleware не должен навязывать no-store.
  assert resp.headers.get('cache-control') != 'no-store, no-cache, must-revalidate'

