Установите зависимости 
    pip install -r servpy/requirements.txt.
Запустите ключевой сервис 
    uvicorn servpy.app.main:app --reload --host 0.0.0.0 --port 4500 (или другой порт, если Node всё ещё слушает).

По умолчанию backend использует встроенный sqlite. Чтобы переключиться на PostgreSQL, задайте переменную окружения
    SERVPY_DATABASE_URL=postgresql+psycopg://user:pass@host:5432/dbname
Перед первым запуском создайте пустую БД, после чего init_schema() автоматически создаст таблицы, индексы и tsvector-поля
для полнотекстового поиска.

В servpy/ появился полный FastAPI‑сервер с теми же маршрутами и поведением, что в Node:

servpy/app/text_utils.py + pymorphy2 — лемматизация и нормализация текста (lemma + normalized_text) для каждого блока;
servpy/app/db.py + schema.py — чистый sqlite3, WAL, FTS5 с колонками lemma и normalized_text, миграция/реиндексация (скрипты migrate_json.py и reindex_fts.py);
servpy/app/data_store.py — CRUD, история, indent/outdent/move, поиск (lemma:* OR normalized_text:*), ensure_sample_article, create_article и весь набор операций, которые раньше делал dataStore.js;
servpy/app/main.py — FastAPI-приложение с CORS, загрузкой изображений (5МБ, MIME:image), сервингом /uploads и клиентского client/, API /api/..., /api/search, /changelog.txt и SPA-фолбеком;
servpy/requirements.txt + .gitignore (новые sqlite/Uploads) чтобы можно было установить uvicorn, fastapi, pymorphy2, aiofiles.

Скрипты на Python/FTS позволяют импортировать server/data/articles.json (python -m servpy.app.migrate_json) и заново индексировать (python -m servpy.app.reindex_fts).

Следующие шаги.

Установите зависимости pip install -r servpy/requirements.txt.
Запустите ключевой сервис uvicorn servpy.app.main:app --reload --host 0.0.0.0 --port 4500 (или другой порт, если Node всё ещё слушает).
Проверьте CRUD, undo/redo, поиск и загрузки, а затем обновите changelog/CI.
