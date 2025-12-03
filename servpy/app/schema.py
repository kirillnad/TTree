from .db import IS_POSTGRES, IS_SQLITE, execute


def _init_sqlite_schema():
    statements = [
        '''
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            created_at TEXT NOT NULL,
            is_superuser INTEGER NOT NULL DEFAULT 0
        )
        ''',
        '''
        CREATE TABLE IF NOT EXISTS articles (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            history TEXT NOT NULL DEFAULT '[]',
            redo_history TEXT NOT NULL DEFAULT '[]',
            deleted_at TEXT,
            author_id TEXT,
            is_encrypted INTEGER NOT NULL DEFAULT 0,
            encryption_salt TEXT,
            encryption_verifier TEXT,
            encryption_hint TEXT,
            public_slug TEXT UNIQUE
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
        '''
        CREATE TABLE IF NOT EXISTS article_links (
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'internal',
            PRIMARY KEY (from_id, to_id),
            FOREIGN KEY(from_id) REFERENCES articles(id) ON DELETE CASCADE,
            FOREIGN KEY(to_id) REFERENCES articles(id) ON DELETE CASCADE
        )
        ''',
        '''
        CREATE INDEX IF NOT EXISTS idx_article_links_to
        ON article_links(to_id)
        ''',
    ]

    for stmt in statements:
        execute(stmt)

    # Backwards-compatible additions for existing SQLite databases.
    user_columns = execute("PRAGMA table_info(users)").fetchall()
    user_col_names = {col['name'] for col in user_columns}
    if 'is_superuser' not in user_col_names:
        execute("ALTER TABLE users ADD COLUMN is_superuser INTEGER NOT NULL DEFAULT 0")

    article_columns = execute("PRAGMA table_info(articles)").fetchall()
    col_names = {col['name'] for col in article_columns}
    if 'deleted_at' not in col_names:
        execute("ALTER TABLE articles ADD COLUMN deleted_at TEXT")
    if 'author_id' not in col_names:
        execute("ALTER TABLE articles ADD COLUMN author_id TEXT")
    if 'is_encrypted' not in col_names:
        execute("ALTER TABLE articles ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0")
    if 'encryption_salt' not in col_names:
        execute("ALTER TABLE articles ADD COLUMN encryption_salt TEXT")
    if 'encryption_verifier' not in col_names:
        execute("ALTER TABLE articles ADD COLUMN encryption_verifier TEXT")
    if 'encryption_hint' not in col_names:
        execute("ALTER TABLE articles ADD COLUMN encryption_hint TEXT")
    if 'public_slug' not in col_names:
        execute("ALTER TABLE articles ADD COLUMN public_slug TEXT")
        execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_public_slug ON articles(public_slug)")

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


def _init_postgres_schema():
    statements = [
        '''
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            created_at TEXT NOT NULL,
            is_superuser BOOLEAN NOT NULL DEFAULT FALSE
        )
        ''',
        '''
        CREATE TABLE IF NOT EXISTS articles (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            history TEXT NOT NULL DEFAULT '[]',
            redo_history TEXT NOT NULL DEFAULT '[]',
            deleted_at TEXT,
            author_id TEXT,
            is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
            encryption_salt TEXT,
            encryption_verifier TEXT,
            encryption_hint TEXT,
            public_slug TEXT UNIQUE
        )
        ''',
        '''
        CREATE TABLE IF NOT EXISTS blocks (
            block_rowid BIGSERIAL PRIMARY KEY,
            id TEXT NOT NULL UNIQUE,
            article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            parent_id TEXT REFERENCES blocks(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            normalized_text TEXT NOT NULL DEFAULT '',
            collapsed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        ''',
        '''
        CREATE INDEX IF NOT EXISTS idx_blocks_article_parent
        ON blocks(article_id, parent_id, position)
        ''',
        '''
        CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            stored_path TEXT NOT NULL,
            original_name TEXT NOT NULL,
            content_type TEXT,
            size BIGINT NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
        ''',
        '''
        CREATE INDEX IF NOT EXISTS idx_attachments_article
        ON attachments(article_id)
        ''',
        '''
        CREATE TABLE IF NOT EXISTS blocks_fts (
            block_rowid BIGINT PRIMARY KEY,
            article_id TEXT NOT NULL,
            text TEXT NOT NULL,
            lemma TEXT NOT NULL,
            normalized_text TEXT NOT NULL,
            search_vector tsvector GENERATED ALWAYS AS (
                to_tsvector('simple', coalesce(lemma, '') || ' ' || coalesce(normalized_text, ''))
            ) STORED
        )
        ''',
        '''
        CREATE INDEX IF NOT EXISTS idx_blocks_fts_article
        ON blocks_fts(article_id)
        ''',
        '''
        CREATE INDEX IF NOT EXISTS idx_blocks_fts_search
        ON blocks_fts USING GIN (search_vector)
        ''',
        '''
        CREATE TABLE IF NOT EXISTS articles_fts (
            article_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            lemma TEXT NOT NULL,
            normalized_text TEXT NOT NULL,
            search_vector tsvector GENERATED ALWAYS AS (
                to_tsvector('simple', coalesce(lemma, '') || ' ' || coalesce(normalized_text, ''))
            ) STORED
        )
        ''',
        '''
        CREATE INDEX IF NOT EXISTS idx_articles_fts_search
        ON articles_fts USING GIN (search_vector)
        ''',
        '''
        CREATE TABLE IF NOT EXISTS article_links (
            from_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            to_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            kind TEXT NOT NULL DEFAULT 'internal',
            PRIMARY KEY (from_id, to_id)
        )
        ''',
        '''
        CREATE INDEX IF NOT EXISTS idx_article_links_to
        ON article_links(to_id)
        ''',
    ]

    for stmt in statements:
        execute(stmt)

    # Ensure author_id, encryption flags and is_superuser exist even if tables pre-existed.
    execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'articles' AND column_name = 'author_id'
            ) THEN
                ALTER TABLE articles ADD COLUMN author_id TEXT;
            END IF;
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'users' AND column_name = 'is_superuser'
            ) THEN
                ALTER TABLE users ADD COLUMN is_superuser BOOLEAN NOT NULL DEFAULT FALSE;
            END IF;
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'articles' AND column_name = 'is_encrypted'
            ) THEN
                ALTER TABLE articles ADD COLUMN is_encrypted BOOLEAN NOT NULL DEFAULT FALSE;
            END IF;
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'articles' AND column_name = 'encryption_salt'
            ) THEN
                ALTER TABLE articles ADD COLUMN encryption_salt TEXT;
            END IF;
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'articles' AND column_name = 'encryption_verifier'
            ) THEN
                ALTER TABLE articles ADD COLUMN encryption_verifier TEXT;
            END IF;
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'articles' AND column_name = 'encryption_hint'
            ) THEN
                ALTER TABLE articles ADD COLUMN encryption_hint TEXT;
            END IF;
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'articles' AND column_name = 'public_slug'
            ) THEN
                ALTER TABLE articles ADD COLUMN public_slug TEXT;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_public_slug ON articles(public_slug);
            END IF;
        END$$;
        """
    )


def init_schema():
    if IS_SQLITE:
        _init_sqlite_schema()
    elif IS_POSTGRES:
        _init_postgres_schema()
    else:
        _init_sqlite_schema()
