const db = require('./db');

function initSchema() {
  const statements = [
    `
      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        history TEXT NOT NULL DEFAULT '[]',
        redo_history TEXT NOT NULL DEFAULT '[]'
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS blocks (
        block_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        article_id TEXT NOT NULL,
        parent_id TEXT,
        position INTEGER NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        normalized_text TEXT NOT NULL DEFAULT '',
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(article_id) REFERENCES articles(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_id) REFERENCES blocks(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_blocks_article_parent
      ON blocks(article_id, parent_id, position)
    `,
  ];

  statements.forEach((sql) => db.prepare(sql).run());

  const blockColumns = db.prepare("PRAGMA table_info('blocks')").all();
  if (!blockColumns.some((column) => column.name === 'normalized_text')) {
    db.prepare('ALTER TABLE blocks ADD COLUMN normalized_text TEXT NOT NULL DEFAULT \'\'').run();
  }

    const ftsInfo = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'blocks_fts'").get();
    const needsRecreateFts =
      !ftsInfo || !ftsInfo.sql.includes('lemma') || !ftsInfo.sql.includes('normalized_text');
  if (needsRecreateFts) {
    db.prepare('DROP TABLE IF EXISTS blocks_fts').run();
  }

  db
    .prepare(`
      CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts
      USING fts5(
        block_rowid UNINDEXED,
        article_id UNINDEXED,
        text,
        lemma,
        normalized_text,
        tokenize = 'unicode61 remove_diacritics 0'
      )
    `)
    .run();
}

module.exports = initSchema;
