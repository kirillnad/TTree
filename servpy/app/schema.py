from .db import execute


def init_schema():
    statements = [
        '''
        CREATE TABLE IF NOT EXISTS articles (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            history TEXT NOT NULL DEFAULT '[]',
            redo_history TEXT NOT NULL DEFAULT '[]',
            deleted_at TEXT
        )
        ''',
        '''
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
        ''',
        '''
        CREATE INDEX IF NOT EXISTS idx_blocks_article_parent
        ON blocks(article_id, parent_id, position)
        ''',
        '''
        CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            article_id TEXT NOT NULL,
            stored_path TEXT NOT NULL,
            original_name TEXT NOT NULL,
            content_type TEXT,
            size INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY(article_id) REFERENCES articles(id) ON DELETE CASCADE
        )
        ''',
        '''
        CREATE INDEX IF NOT EXISTS idx_attachments_article
        ON attachments(article_id)
        ''',
    ]

    for stmt in statements:
        execute(stmt)

    # migrate older DBs that do not have deleted_at
    execute("PRAGMA table_info(articles)")
    has_deleted = any(col['name'] == 'deleted_at' for col in execute("PRAGMA table_info(articles)").fetchall())
    if not has_deleted:
        execute("ALTER TABLE articles ADD COLUMN deleted_at TEXT")

    execute('DROP TABLE IF EXISTS blocks_fts')
    execute(
        '''
        CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts
        USING fts5(
            block_rowid UNINDEXED,
            article_id UNINDEXED,
            text,
            lemma,
            normalized_text,
            tokenize = 'unicode61 remove_diacritics 0'
        )
        ''',
    )

    execute('DROP TABLE IF EXISTS articles_fts')
    execute(
        '''
        CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts
        USING fts5(
            article_id UNINDEXED,
            title,
            lemma,
            normalized_text,
            tokenize = 'unicode61 remove_diacritics 0'
        )
        ''',
    )
