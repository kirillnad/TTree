#!/usr/bin/env python3
"""
Создаёт тестовую статью для визуальных проверок, если её ещё нет.
Название: "тестовая статья"
ID: test-article
Содержимое: простое дерево из четырёх узлов.
"""

from __future__ import annotations

import uuid
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from servpy.app.data_store import get_article, iso_now, save_article


def build_test_article():
  """Готовим фиктивное дерево, близкое к демо."""
  return {
      'id': 'test-article',
      'title': 'тестовая статья',
      'createdAt': iso_now(),
      'updatedAt': iso_now(),
      'history': [],
      'redoHistory': [],
      'blocks': [
          {
              'id': str(uuid.uuid4()),
              'text': 'Примерный узел',
              'collapsed': False,
              'children': [
                  {
                      'id': str(uuid.uuid4()),
                      'text': 'Дочерний элемент',
                      'collapsed': False,
                      'children': [],
                  },
                  {
                      'id': str(uuid.uuid4()),
                      'text': 'Развивающая ветка',
                      'collapsed': False,
                      'children': [
                          {
                              'id': str(uuid.uuid4()),
                              'text': 'Глубоко вложенный блок',
                              'collapsed': False,
                              'children': [],
                          }
                      ],
                  },
              ],
          },
      ],
  }


def main():
  existing = get_article('test-article', include_deleted=True)
  if existing:
      print('тестовая статья уже существует, пропускаю')
      return
  article = build_test_article()
  save_article(article)
  print('Создана тестовая статья (id=test-article)')


if __name__ == '__main__':
  main()
