from __future__ import annotations

from .db import execute

# PostgreSQL-only schema.


def _init_postgres_schema() -> None:
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
            parent_id TEXT,
            position INTEGER NOT NULL DEFAULT 0,
            history TEXT NOT NULL DEFAULT '[]',
            redo_history TEXT NOT NULL DEFAULT '[]',
            block_trash TEXT NOT NULL DEFAULT '[]',
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
        CREATE INDEX IF NOT EXISTS idx_articles_parent_position
        ON articles(parent_id, position)
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
            block_id TEXT NOT NULL DEFAULT '',
            to_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            kind TEXT NOT NULL DEFAULT 'internal',
            PRIMARY KEY (from_id, block_id, to_id)
        )
        ''',
        '''
        CREATE INDEX IF NOT EXISTS idx_article_links_to
        ON article_links(to_id)
        ''',
        '''
        CREATE TABLE IF NOT EXISTS user_yandex_tokens (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            expires_at TEXT,
            disk_root TEXT NOT NULL DEFAULT 'app:/',
            initialized BOOLEAN NOT NULL DEFAULT FALSE
        )
        ''',
        '''
        CREATE TABLE IF NOT EXISTS telegram_links (
            chat_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL
        )
        ''',
        '''
        CREATE TABLE IF NOT EXISTS telegram_link_tokens (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
        ''',
    ]

    for stmt in statements:
        execute(stmt)

    # Backwards-compatible additions for existing PostgreSQL databases.
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
                WHERE table_name = 'articles' AND column_name = 'parent_id'
            ) THEN
                ALTER TABLE articles ADD COLUMN parent_id TEXT;
            END IF;
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'articles' AND column_name = 'position'
            ) THEN
                ALTER TABLE articles ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
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
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'articles' AND column_name = 'block_trash'
            ) THEN
                ALTER TABLE articles ADD COLUMN block_trash TEXT NOT NULL DEFAULT '[]';
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'article_links' AND column_name = 'block_id'
            ) THEN
                ALTER TABLE article_links ADD COLUMN block_id TEXT NOT NULL DEFAULT '';
            END IF;

            BEGIN
                ALTER TABLE article_links DROP CONSTRAINT IF EXISTS article_links_pkey;
            EXCEPTION
                WHEN undefined_object THEN
                    NULL;
            END;

            ALTER TABLE article_links
                ADD CONSTRAINT article_links_pkey
                PRIMARY KEY (from_id, block_id, to_id);
        END$$;
        """
    )


def init_schema() -> None:
    _init_postgres_schema()
