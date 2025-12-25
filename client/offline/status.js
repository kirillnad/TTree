import { getOfflineDbReady } from './index.js';

export async function getOfflineCoverageSummary() {
  const db = await getOfflineDbReady();

  const articleRes = await db.query(
    'SELECT ' +
      'COUNT(1) AS total, ' +
      'SUM(CASE WHEN doc_json IS NOT NULL THEN 1 ELSE 0 END) AS with_doc ' +
      'FROM articles ' +
      'WHERE deleted_at IS NULL AND (encrypted IS NULL OR encrypted = 0)',
  );
  const aRow = articleRes?.rows?.[0] || {};
  const articlesTotal = Number(aRow.total || 0);
  const articlesWithDoc = Number(aRow.with_doc || 0);

  const mediaRes = await db.query(
    'SELECT ' +
      'COUNT(1) AS total, ' +
      "SUM(CASE WHEN ma.status = 'ok' THEN 1 ELSE 0 END) AS ok, " +
      "SUM(CASE WHEN ma.status = 'error' THEN 1 ELSE 0 END) AS error " +
      'FROM (SELECT DISTINCT url FROM media_refs) u ' +
      'LEFT JOIN media_assets ma ON ma.url = u.url',
  );
  const mRow = mediaRes?.rows?.[0] || {};
  const mediaTotal = Number(mRow.total || 0);
  const mediaOk = Number(mRow.ok || 0);
  const mediaError = Number(mRow.error || 0);

  return {
    articles: { total: articlesTotal, withDoc: articlesWithDoc },
    media: { total: mediaTotal, ok: mediaOk, error: mediaError },
  };
}

