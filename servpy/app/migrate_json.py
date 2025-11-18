import json
from pathlib import Path

from .data_store import ensure_sample_article, save_article
from .schema import init_schema


def main():
    init_schema()
    data_path = Path(__file__).resolve().parents[1].parent / 'server' / 'data' / 'articles.json'
    if not data_path.exists():
        print('source JSON not found')
        return
    with data_path.open('r', encoding='utf-8') as handle:
        data = json.load(handle)
    articles = data.get('articles', [])
    if not articles:
        print('no articles in JSON')
        return
    for article in articles:
        save_article(article)
    print(f'migrated {len(articles)} articles')


if __name__ == '__main__':
    main()
