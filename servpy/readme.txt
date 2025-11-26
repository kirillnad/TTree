Установите зависимости 
    pip install -r servpy/requirements.txt.
Запустите ключевой сервис 
    uvicorn servpy.app.main:app --reload --host 0.0.0.0 --port 4500 (или другой порт, если Node всё ещё слушает).

Тесты клиентской части собираются через Vitest. Поскольку Node.js установлен локально в /home/aadminn/node-v20.18.0-linux-x64, выполнять проверки удобнее так:
    PATH=/home/aadminn/node-v20.18.0-linux-x64/bin:$PATH npm test
Команда использует встроенное окружение happy-dom и прогоняет сценарии из client/__tests__.

Для быстрого запуска в корне репозитория есть скрипт scripts/start_servpy.sh. По умолчанию он пытается стартовать локальный Postgres-кластер в ~/pgdata (порт 5544), выставляет SERVPY_DATABASE_URL и запускает uvicorn на 4500‑м порту. HOST, PORT, PGDATA_DIR и другие параметры можно переопределить через одноимённые переменные окружения.

Чтобы сервис стартовал автоматически при логине и писал логи в файл, создан user-unit ~/.config/systemd/user/ttree.service. После любых правок не забудьте выполнить:
    systemctl --user daemon-reload
    systemctl --user enable --now ttree.service
    systemctl --user status ttree.service   # убедиться, что запустился
    journalctl --user -u ttree.service -f   # для отладки; stdout/stderr также в logs/servpy.log

По умолчанию backend использует встроенный sqlite. Чтобы переключиться на PostgreSQL, задайте переменную окружения
    SERVPY_DATABASE_URL=postgresql+psycopg://user:pass@host:5432/dbname
Перед первым запуском создайте пустую БД, после чего init_schema() автоматически создаст таблицы, индексы и tsvector-поля
для полнотекстового поиска.

Локально уже развёрнут PostgreSQL 16.11 (conda env `pg16`) с данными в `/home/aadminn/pg16data` и базой `ttree`. Быстрые команды:

    /home/aadminn/miniconda3/bin/conda run -n pg16 pg_ctl -D /home/aadminn/pg16data -l /home/aadminn/pg16data/postgresql.log start
    /home/aadminn/miniconda3/bin/conda run -n pg16 pg_ctl -D /home/aadminn/pg16data stop
    /home/aadminn/miniconda3/bin/conda run -n pg16 pg_ctl -D /home/aadminn/pg16data status

Для backend используйте переменную
    SERVPY_DATABASE_URL=postgresql+psycopg:///ttree?host=/home/aadminn/pg16data&port=5555
и, если нужно мигрировать старый контент, запустите
    python3 -m servpy.app.reindex_fts
уже с этим DSN (init_schema и reindex_fts прогнаны, таблицы и индекс tsvector созданы).

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
