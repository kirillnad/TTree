import { getOfflineDbReady } from './index.js';

function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // fallback (not cryptographically strong, but ok for offline ids)
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

export async function enqueueOp(type, { articleId, payload, coalesceKey } = {}) {
  const db = await getOfflineDbReady();
  const opId = uuid();
  const createdAt = nowIso();
  const payloadJson = payload ? JSON.stringify(payload) : '{}';

  if (coalesceKey) {
    await db.query('DELETE FROM outbox WHERE type = $1 AND article_id = $2', [type, articleId || null]);
  }

  await db.query(
    'INSERT INTO outbox (id, created_at, type, article_id, payload_json, attempts, last_error, last_attempt_at) ' +
      'VALUES ($1, $2, $3, $4, $5, 0, NULL, NULL)',
    [opId, createdAt, type, articleId || null, payloadJson],
  );
  return opId;
}

export async function listOutbox(limit = 50) {
  const db = await getOfflineDbReady();
  const result = await db.query(
    'SELECT id, created_at, type, article_id, payload_json, attempts FROM outbox ORDER BY created_at ASC LIMIT $1',
    [limit],
  );
  return (result?.rows || []).map((row) => {
    let payload = {};
    try {
      payload = JSON.parse(row.payload_json || '{}');
    } catch {
      payload = {};
    }
    return {
      id: row.id,
      createdAt: row.created_at,
      type: row.type,
      articleId: row.article_id,
      payload,
      attempts: row.attempts || 0,
    };
  });
}

export async function markOutboxError(opId, message) {
  const db = await getOfflineDbReady();
  await db.query(
    'UPDATE outbox SET attempts = attempts + 1, last_error = $1, last_attempt_at = $2 WHERE id = $3',
    [String(message || 'error'), nowIso(), opId],
  );
}

export async function removeOutboxOp(opId) {
  const db = await getOfflineDbReady();
  await db.query('DELETE FROM outbox WHERE id = $1', [opId]);
}
