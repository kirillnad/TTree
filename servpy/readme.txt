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
servpy/app/data_store.py — CRUD, история, indent/outdent/move, поиск (lemma:* OR normalized_text:*), ensure_sample_article, create_article и весь набор операций, которые раньше делал dataStore.js; жёсткое разделение данных по пользователям (author_id в articles, поиск только в статьях текущего пользователя);
servpy/app/main.py — FastAPI-приложение с CORS, аутентификацией и сессиями, загрузкой изображений (5МБ, MIME:image), сервингом клиентского client/, защищённым доступом к /uploads (каждый пользователь видит только свои файлы), API /api/auth/*, /api/articles/..., /api/search, /api/changelog и SPA-фолбеком (роутинг на стороне клиента);
servpy/requirements.txt + .gitignore (новые sqlite/Uploads) чтобы можно было установить uvicorn, fastapi, pymorphy2, aiofiles.

Стартовая «справочная» статья для новых пользователей

Memus автоматически создаёт пользователю первую статью (онбординг/руководство) при первом входе, но только если у него ещё нет ни одной не удалённой статьи.

Где реализовано:
  - servpy/app/main.py: ensure_help_article_for_user(author_id)
    - проверяет наличие статей пользователя;
    - если статей нет — создаёт статью на основе шаблона client/help.html.

Откуда берётся контент:
  - TTree/client/help.html — HTML экспорт Memus, внутри должен быть JSON-снапшот:
      <script id="memus-export">...</script>
    Парсер ожидает payload вида { "source": "memus", "version": 1, "article": {...}, "blocks": [...] }.

Как обновить стартовую статью:
  1) В Memus создайте/откройте нужную статью-руководство (как вы хотите, чтобы её увидел новый пользователь).
  2) Выполните «Экспорт в HTML».
  3) Замените файл TTree/client/help.html на экспортированный HTML (важно сохранить блок memus-export внутри <script id="memus-export">).
  4) Проверьте на новом пользователе: при первом входе статья должна появиться автоматически.

Скрипты на Python/FTS позволяют импортировать server/data/articles.json (python -m servpy.app.migrate_json) и заново индексировать (python -m servpy.app.reindex_fts).

Следующие шаги.

Установите зависимости pip install -r servpy/requirements.txt.
Запустите ключевой сервис uvicorn servpy.app.main:app --reload --host 0.0.0.0 --port 4500 (или другой порт, если Node всё ещё слушает).
Проверьте аутентификацию (вход/регистрация), CRUD, undo/redo, поиск и загрузки, а затем обновите changelog/CI.
