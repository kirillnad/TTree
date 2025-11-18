const db = require('./db');
const initSchema = require('./schema');
const { stripHtml, buildLemma, buildNormalizedTokens } = require('./text-utils');

initSchema();

const deleteFtsStmt = db.prepare('DELETE FROM blocks_fts');
const insertFtsStmt = db.prepare(
  `
    INSERT OR REPLACE INTO blocks_fts (block_rowid, article_id, text, lemma, normalized_text)
    VALUES (?, ?, ?, ?, ?)
  `,
);
const updateNormalizedStmt = db.prepare(
  'UPDATE blocks SET normalized_text = ? WHERE block_rowid = ?',
);
const selectBlocksStmt = db.prepare(
  'SELECT block_rowid, article_id, text FROM blocks',
);

function rebuildFts() {
  deleteFtsStmt.run();
  selectBlocksStmt.all().forEach((row) => {
    const normalizedTokens = buildNormalizedTokens(stripHtml(row.text || ''));
    const lemma = buildLemma(stripHtml(row.text || ''));
    updateNormalizedStmt.run(normalizedTokens, row.block_rowid);
    insertFtsStmt.run(row.block_rowid, row.article_id, row.text || '', lemma, normalizedTokens);
  });
}

rebuildFts();
console.log('FTS reindexed with normalized lemmas');
