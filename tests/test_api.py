from __future__ import annotations

import io
from typing import List

import pytest
from fastapi.testclient import TestClient


def create_article(client: TestClient, title: str = 'Test article') -> dict:
    resp = client.post('/api/articles', json={'title': title})
    assert resp.status_code == 200
    return resp.json()


def test_create_and_read_article(client: TestClient):
    created = create_article(client)
    article_id = created['id']

    resp = client.get(f'/api/articles/{article_id}')
    assert resp.status_code == 200
    article = resp.json()
    assert article['title'] == 'Test article'
    # docJson-first API: blocks are not returned to keep payload small.
    assert article['blocks'] == []
    assert article.get('docJson')

    resp = client.get('/api/articles')
    ids = [row['id'] for row in resp.json()]
    assert article_id in ids


def test_update_article_meta_and_not_found(client: TestClient):
    created = create_article(client)
    article_id = created['id']

    resp = client.patch(f'/api/articles/{article_id}', json={'title': 'Renamed'})
    assert resp.status_code == 200
    assert resp.json()['title'] == 'Renamed'

    resp = client.patch('/api/articles/missing', json={'title': 'Nope'})
    assert resp.status_code == 404


def test_block_flow_create_update_delete(client: TestClient):
    pytest.skip('Legacy HTML blocks mode is disabled; outline-first uses docJson and section ops.')


def test_soft_delete_and_restore(client: TestClient):
    created = create_article(client)
    article_id = created['id']

    resp = client.delete(f'/api/articles/{article_id}')
    assert resp.status_code == 200
    assert resp.json()['status'] == 'deleted'

    resp = client.get('/api/articles')
    assert article_id not in [row['id'] for row in resp.json()]

    deleted_list = client.get('/api/articles/deleted').json()
    assert any(row['id'] == article_id and row['deletedAt'] for row in deleted_list)

    restored = client.post(f'/api/articles/{article_id}/restore')
    assert restored.status_code == 200
    restored_article = restored.json()
    assert restored_article['id'] == article_id
    assert restored_article['deletedAt'] is None

    active_ids = [row['id'] for row in client.get('/api/articles').json()]
    assert article_id in active_ids


def test_search_returns_block_and_article(client: TestClient):
    created = create_article(client, title='Searchable Title')
    article_id = created['id']
    section_id = 'sec-search'
    resp = client.put(
        f'/api/articles/{article_id}/sections/upsert-content',
        json={
            'sectionId': section_id,
            'headingJson': {'type': 'outlineHeading'},
            'bodyJson': {
                'type': 'outlineBody',
                'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'Giraffe spotted here'}]}],
            },
            'seq': 1,
        },
    )
    assert resp.status_code == 200

    results = client.get('/api/search', params={'q': 'giraffe'}).json()
    ids = {(item.get('articleId'), item.get('blockId')) for item in results}
    assert (article_id, None) in ids or any(item.get('articleId') == article_id for item in results)
    assert any(item.get('blockId') == section_id for item in results)


def test_move_indent_outdent_and_relocate(client: TestClient):
    pytest.skip('Legacy HTML blocks mode is disabled; outline-first uses structure snapshots.')


def test_move_block_to_other_article(client: TestClient):
    pytest.skip('Legacy HTML blocks mode is disabled; outline-first does not expose move-to-block API.')


def test_undo_redo_text_history(client: TestClient):
    pytest.skip('Legacy HTML blocks undo/redo is disabled; outline-first uses ProseMirror history client-side.')


def test_attachments_upload_and_validation(client: TestClient, tmp_path):
    article = create_article(client)
    article_id = article['id']

    file_bytes = b'hello world'
    resp = client.post(
        f'/api/articles/{article_id}/attachments',
        files={'file': ('note.txt', file_bytes, 'text/plain')},
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert payload['articleId'] == article_id
    assert payload['storedPath'].startswith(f'/uploads/{article_id}/')

    bad_type = client.post(
        f'/api/articles/{article_id}/attachments',
        files={'file': ('bad.bin', b'data', 'application/octet-stream')},
    )
    assert bad_type.status_code == 400

    missing_article = client.post(
        '/api/articles/missing/attachments',
        files={'file': ('note.txt', file_bytes, 'text/plain')},
    )
    assert missing_article.status_code == 404


def test_search_rebuild_indexes(client: TestClient):
    article = create_article(client, title='Indexer')
    article_id = article['id']
    section_id = 'sec-index'
    client.put(
        f'/api/articles/{article_id}/sections/upsert-content',
        json={
            'sectionId': section_id,
            'headingJson': {'type': 'outlineHeading'},
            'bodyJson': {
                'type': 'outlineBody',
                'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'Find me'}]}],
            },
            'seq': 1,
        },
    )

    # Clear FTS tables to simulate stale indexes
    client.app_db.execute('DELETE FROM outline_sections_fts')
    client.app_db.execute('DELETE FROM articles_fts')
    empty = client.get('/api/search', params={'q': 'find'}).json()
    assert empty == []

    client.data_store.rebuild_search_indexes()
    restored = client.get('/api/search', params={'q': 'find'}).json()
    assert any(item.get('blockId') == section_id for item in restored)
