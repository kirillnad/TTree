from .schema import init_schema
from .data_store import rebuild_search_indexes


def main():
    init_schema()
    rebuild_search_indexes()
    print('FTS reindexed (articles_fts, blocks_fts, outline_sections_fts)')


if __name__ == '__main__':
    main()
