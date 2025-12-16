from __future__ import annotations

import os

# Вынесено из app/main.py → app/oauth_config.py

GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID') or ''
GOOGLE_CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET') or ''
GOOGLE_REDIRECT_URI = os.environ.get('GOOGLE_REDIRECT_URI') or 'https://memus.pro/api/auth/google/callback'

YANDEX_CLIENT_ID = os.environ.get('YANDEX_CLIENT_ID') or ''
YANDEX_CLIENT_SECRET = os.environ.get('YANDEX_CLIENT_SECRET') or ''
YANDEX_REDIRECT_URI = os.environ.get('YANDEX_REDIRECT_URI') or 'https://memus.pro/auth/yandex/callback'

YANDEX_DISK_APP_ROOT = os.environ.get('YANDEX_DISK_APP_ROOT') or 'app:/'

