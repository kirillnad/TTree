from __future__ import annotations

import logging
import os

from .db import execute

# PostgreSQL-only schema.

logger = logging.getLogger('uvicorn.error')

def _parse_version(ver: str) -> tuple[int, int, int]:
    raw = (ver or '').strip()
    parts = raw.split('.')
    out = []
    for i in range(3):
        try:
            out.append(int(parts[i]))
        except Exception:
            out.append(0)
    return (out[0], out[1], out[2])


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

    # Семантический поиск (pgvector) — опционально.
    # Если расширение/права недоступны, core-функциональность не должна падать.
    try:
        # Размерность должна совпадать с embeddings-провайдером (SERVPY_EMBEDDING_DIM).
        # Важно: при смене размерности нужно пересоздать таблицу/колонку embeddings.
        from .embeddings import EMBEDDING_DIM  # локальный импорт, чтобы не тащить модуль везде

        index_type = (os.environ.get('SERVPY_PGVECTOR_INDEX_TYPE') or 'auto').strip().lower()
        ivfflat_lists = int(os.environ.get('SERVPY_PGVECTOR_IVFFLAT_LISTS') or '200')

        execute('CREATE EXTENSION IF NOT EXISTS vector')
        # Выясняем версию pgvector, чтобы корректно выбирать индексы.
        # На старых версиях/сборках бывает ограничение dims<=2000 и для hnsw, и для ivfflat.
        try:
            row = execute("SELECT extversion AS v FROM pg_extension WHERE extname='vector'").fetchone()
            pgvector_version = str((row or {}).get('v') or '')
        except Exception:
            pgvector_version = ''
        _pgvector_v = _parse_version(pgvector_version)
        ann_dim_limit = 2000

        execute(
            f'''
            CREATE TABLE IF NOT EXISTS block_embeddings (
                block_id TEXT PRIMARY KEY,
                author_id TEXT NOT NULL,
                article_id TEXT NOT NULL,
                article_title TEXT NOT NULL DEFAULT '',
                plain_text TEXT NOT NULL DEFAULT '',
                embedding vector({EMBEDDING_DIM}) NOT NULL,
                updated_at TEXT NOT NULL
            )
            '''
        )
        execute(
            '''
            CREATE INDEX IF NOT EXISTS idx_block_embeddings_author
            ON block_embeddings(author_id)
            '''
        )
        # Индекс по embedding:
        # - hnsw быстрее, но в pgvector имеет ограничение dims<=2000
        # - ivfflat работает и для больших размерностей (например vector(3072))
        if EMBEDDING_DIM > ann_dim_limit and index_type in ('auto', 'hnsw', 'ivfflat'):
            logger.warning(
                'pgvector %s: ANN index (hnsw/ivfflat) disabled for vector(%s) due to dim limit %s; '
                'semantic search will work without ANN index (slower).',
                pgvector_version or '?',
                EMBEDDING_DIM,
                ann_dim_limit,
            )
            return

        if index_type == 'hnsw' or (index_type == 'auto' and EMBEDDING_DIM <= ann_dim_limit):
            execute(
                """
                DO $$
                BEGIN
                    IF EXISTS (SELECT 1 FROM pg_am WHERE amname = 'hnsw') THEN
                        CREATE INDEX IF NOT EXISTS idx_block_embeddings_embedding_hnsw
                            ON block_embeddings USING hnsw (embedding vector_cosine_ops);
                    END IF;
                END$$;
                """
            )
        if index_type == 'ivfflat' or (index_type == 'auto' and EMBEDDING_DIM > ann_dim_limit):
            # ivfflat требует ANALYZE для корректного планирования.
            execute('ANALYZE block_embeddings')
            execute(
                f'''
                CREATE INDEX IF NOT EXISTS idx_block_embeddings_embedding_ivfflat
                    ON block_embeddings USING ivfflat (embedding vector_cosine_ops)
                    WITH (lists = {max(1, ivfflat_lists)});
                '''
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning('pgvector is not available; semantic search disabled: %r', exc)


def init_schema() -> None:
    _init_postgres_schema()
