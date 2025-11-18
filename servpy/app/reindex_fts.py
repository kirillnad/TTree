from .db import CONN
from .schema import init_schema
from .text_utils import build_lemma, build_normalized_tokens, strip_html


def main():
    init_schema()
    CONN.execute('DELETE FROM blocks_fts')
    rows = CONN.execute('SELECT block_rowid, article_id, text FROM blocks').fetchall()
    for row in rows:
        normalized = build_normalized_tokens(strip_html(row['text'] or ''))
        lemma = build_lemma(strip_html(row['text'] or ''))
        CONN.execute(
            '''
            INSERT OR REPLACE INTO blocks_fts (block_rowid, article_id, text, lemma, normalized_text)
            VALUES (?, ?, ?, ?, ?)
            ''',
            (row['block_rowid'], row['article_id'], row['text'] or '', lemma, normalized),
        )
        CONN.execute(
            'UPDATE blocks SET normalized_text = ? WHERE block_rowid = ?',
            (normalized, row['block_rowid']),
        )
    print('FTS reindexed')


if __name__ == '__main__':
    main()
