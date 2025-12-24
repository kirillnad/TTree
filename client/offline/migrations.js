const OFFLINE_SCHEMA_VERSION = 1;

export async function migrateOfflineDb(db) {
  if (!db) throw new Error('offline db is required');
  await db.query('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  await db.query(
    'CREATE TABLE IF NOT EXISTS articles (' +
      'id TEXT PRIMARY KEY,' +
      'title TEXT,' +
      'updated_at TEXT,' +
      'parent_id TEXT,' +
      'position INTEGER,' +
      'public_slug TEXT,' +
      'encrypted INTEGER DEFAULT 0,' +
      'deleted_at TEXT,' +
      'doc_json TEXT,' +
      'article_json TEXT' +
      ')',
  );
  await db.query(
    'CREATE TABLE IF NOT EXISTS outline_sections (' +
      'section_id TEXT PRIMARY KEY,' +
      'article_id TEXT,' +
      'title TEXT,' +
      'text TEXT,' +
      'updated_at TEXT' +
      ')',
  );
  await db.query('CREATE INDEX IF NOT EXISTS idx_outline_sections_article_id ON outline_sections(article_id)');
  // Local search is implemented as simple ILIKE/substring match for now.
  // PGlite runs real Postgres, so SQLite FTS5 VIRTUAL TABLE is not available here.
  await db.query(
    'CREATE TABLE IF NOT EXISTS section_embeddings (' +
      'section_id TEXT PRIMARY KEY,' +
      'article_id TEXT,' +
      'embedding_json TEXT,' +
      'updated_at TEXT' +
      ')',
  );
  await db.query('CREATE INDEX IF NOT EXISTS idx_section_embeddings_article_id ON section_embeddings(article_id)');
  await db.query(
    'CREATE TABLE IF NOT EXISTS media_assets (' +
      'url TEXT PRIMARY KEY,' +
      'status TEXT,' +
      'fetched_at TEXT,' +
      'fail_count INTEGER DEFAULT 0,' +
      'last_error TEXT' +
      ')',
  );
  await db.query(
    'CREATE TABLE IF NOT EXISTS media_refs (' +
      'article_id TEXT,' +
      'url TEXT,' +
      'PRIMARY KEY(article_id, url)' +
      ')',
  );
  await db.query('CREATE INDEX IF NOT EXISTS idx_media_refs_article_id ON media_refs(article_id)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_media_refs_url ON media_refs(url)');
  await db.query(
    'CREATE TABLE IF NOT EXISTS outbox (' +
      'id TEXT PRIMARY KEY,' +
      'created_at TEXT,' +
      'type TEXT,' +
      'article_id TEXT,' +
      'payload_json TEXT,' +
      'attempts INTEGER DEFAULT 0,' +
      'last_error TEXT,' +
      'last_attempt_at TEXT' +
      ')',
  );
  await db.query('CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON outbox(created_at)');
  await db.query(
    'INSERT INTO meta (key, value) VALUES ($1, $2) ' +
      'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    ['schema_version', String(OFFLINE_SCHEMA_VERSION)],
  );
}
