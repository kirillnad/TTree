from __future__ import annotations

import io
from typing import List

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
    assert article['blocks']
    assert article['blocks'][0]['id']

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
    created = create_article(client)
    article_id = created['id']
    root_id = created['blocks'][0]['id']

    resp = client.post(
        f'/api/articles/{article_id}/blocks/{root_id}/siblings',
        json={'direction': 'after', 'payload': {'text': 'Second block'}},
    )
    assert resp.status_code == 200
    sibling_id = resp.json()['block']['id']

    resp = client.patch(
        f'/api/articles/{article_id}/blocks/{root_id}',
        json={'text': '<b>Updated</b>'},
    )
    assert resp.status_code == 200
    assert resp.json()['id'] == root_id

    # Fetch and verify text sanitized and persisted
    fetched = client.get(f'/api/articles/{article_id}').json()
    assert fetched['blocks'][0]['text'] == '<b>Updated</b>'

    resp = client.delete(f'/api/articles/{article_id}/blocks/{sibling_id}')
    assert resp.status_code == 200
    assert resp.json()['removedBlockId'] == sibling_id

    # Cannot delete the last remaining block
    resp = client.delete(f'/api/articles/{article_id}/blocks/{root_id}')
    assert resp.status_code == 400
    # Ensure deletion cascaded through children if any remain
    remaining = client.get(f'/api/articles/{article_id}').json()['blocks']
    assert len(remaining) == 1


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
    block_id = created['blocks'][0]['id']

    resp = client.patch(
        f'/api/articles/{article_id}/blocks/{block_id}',
        json={'text': 'Giraffe spotted here'},
    )
    assert resp.status_code == 200

    results = client.get('/api/search', params={'q': 'giraffe'}).json()
    ids = {(item.get('articleId'), item.get('blockId')) for item in results}
    assert (article_id, None) in ids or any(item.get('articleId') == article_id for item in results)
    assert any(item.get('blockId') == block_id for item in results)


def test_move_indent_outdent_and_relocate(client: TestClient):
    created = create_article(client, title='Structure')
    article_id = created['id']
    root = created['blocks'][0]['id']

    def add_sibling(after_id: str, text: str) -> str:
        resp = client.post(
            f'/api/articles/{article_id}/blocks/{after_id}/siblings',
            json={'direction': 'after', 'payload': {'text': text}},
        )
        assert resp.status_code == 200
        return resp.json()['block']['id']

    second = add_sibling(root, 'second')
    third = add_sibling(second, 'third')

    # Move third up
    resp = client.post(f'/api/articles/{article_id}/blocks/{third}/move', json={'direction': 'up'})
    assert resp.status_code == 200
    order = [b['id'] for b in client.get(f'/api/articles/{article_id}').json()['blocks']]
    assert order == [root, third, second]

    # Indent third under root's new first child fails for first item
    bad_indent = client.post(f'/api/articles/{article_id}/blocks/{root}/indent')
    assert bad_indent.status_code == 400

    resp = client.post(f'/api/articles/{article_id}/blocks/{third}/indent')
    assert resp.status_code == 200
    data = client.get(f'/api/articles/{article_id}').json()
    assert data['blocks'][0]['children'][0]['id'] == third

    resp = client.post(f'/api/articles/{article_id}/blocks/{third}/outdent')
    assert resp.status_code == 200
    data = client.get(f'/api/articles/{article_id}').json()
    assert [b['id'] for b in data['blocks']] == [root, third, second]

    # Relocate second under third
    resp = client.post(
        f'/api/articles/{article_id}/blocks/{second}/relocate',
        json={'parentId': third, 'index': 0},
    )
    assert resp.status_code == 200
    data = client.get(f'/api/articles/{article_id}').json()
    assert data['blocks'][1]['id'] == third
    assert data['blocks'][1]['children'][0]['id'] == second

    # Moving into descendant is forbidden
    forbidden = client.post(
        f'/api/articles/{article_id}/blocks/{third}/relocate',
        json={'parentId': second, 'index': 0},
    )
    assert forbidden.status_code == 400


def test_move_block_to_other_article(client: TestClient):
    src = create_article(client, title='Source')
    dst = create_article(client, title='Dest')
    src_id = src['id']
    dst_id = dst['id']
    src_root = src['blocks'][0]['id']

    # Add one more block so source keeps at least one after move
    resp = client.post(
        f'/api/articles/{src_id}/blocks/{src_root}/siblings',
        json={'direction': 'after', 'payload': {'text': 'to-move'}},
    )
    moving_id = resp.json()['block']['id']

    moved = client.post(f'/api/articles/{src_id}/blocks/{moving_id}/move-to/{dst_id}')
    assert moved.status_code == 200
    dst_blocks: List[dict] = client.get(f'/api/articles/{dst_id}').json()['blocks']
    assert any(b['id'] == moving_id for b in dst_blocks)
    src_blocks: List[dict] = client.get(f'/api/articles/{src_id}').json()['blocks']
    assert all(b['id'] != moving_id for b in src_blocks)


def test_undo_redo_text_history(client: TestClient):
    created = create_article(client)
    article_id = created['id']
    block_id = created['blocks'][0]['id']

    first = client.patch(
        f'/api/articles/{article_id}/blocks/{block_id}',
        json={'text': 'first'},
    )
    assert first.status_code == 200
    second = client.patch(
        f'/api/articles/{article_id}/blocks/{block_id}',
        json={'text': 'second'},
    )
    assert second.status_code == 200

    undone = client.post(f'/api/articles/{article_id}/blocks/undo-text', json={})
    assert undone.status_code == 200
    assert undone.json()['block']['text'] == 'first'

    redone = client.post(f'/api/articles/{article_id}/blocks/redo-text', json={})
    assert redone.status_code == 200
    assert redone.json()['block']['text'] == 'second'


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
    block_id = article['blocks'][0]['id']
    client.patch(
        f'/api/articles/{article_id}/blocks/{block_id}',
        json={'text': 'Find me'},
    )

    # Clear FTS tables to simulate stale indexes
    client.app_db.execute('DELETE FROM blocks_fts')
    client.app_db.execute('DELETE FROM articles_fts')
    empty = client.get('/api/search', params={'q': 'find'}).json()
    assert empty == []

    client.data_store.rebuild_search_indexes()
    restored = client.get('/api/search', params={'q': 'find'}).json()
    assert any(item.get('blockId') == block_id for item in restored)
