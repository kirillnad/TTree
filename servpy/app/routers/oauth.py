from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from ..auth import create_session, create_user, get_user_by_username, set_session_cookie, User
from ..data_store import upsert_yandex_tokens
from ..oauth_config import (
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
    YANDEX_CLIENT_ID,
    YANDEX_CLIENT_SECRET,
    YANDEX_DISK_APP_ROOT,
    YANDEX_REDIRECT_URI,
)
from ..onboarding import ensure_help_article_for_user

import urllib.parse
import urllib.request

router = APIRouter()
logger = logging.getLogger('uvicorn.error')

def _finish_oauth_login(*, session_id: str, provider_state_cookie: str | None = None) -> HTMLResponse:
    """
    Finish OAuth login with a 200 HTML response (instead of 302) to maximize cookie reliability
    on mobile/PWA browsers that may drop Set-Cookie on redirects.
    """
    html = """<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Memus — вход</title>
  </head>
  <body>
    <p>Входим…</p>
    <script>
      try { window.location.replace('/'); } catch (e) { window.location.href = '/'; }
    </script>
    <noscript><a href="/">Продолжить</a></noscript>
  </body>
</html>
"""
    resp = HTMLResponse(content=html, status_code=200)
    set_session_cookie(resp, session_id)
    if provider_state_cookie:
        try:
            resp.delete_cookie(provider_state_cookie, path='/')
        except Exception:
            pass
    return resp


# Вынесено из app/main.py → app/routers/oauth.py
@router.get('/api/auth/google/login')
def google_login(request: Request):
    """
    Запускает OAuth-авторизацию через Google:
    редиректит пользователя на accounts.google.com.
    """
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail='Google OAuth не настроен')

    state = os.urandom(16).hex()
    response = RedirectResponse(
        url='https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(
            {
                'client_id': GOOGLE_CLIENT_ID,
                'redirect_uri': GOOGLE_REDIRECT_URI,
                'response_type': 'code',
                'scope': 'openid email profile',
                'state': state,
                'access_type': 'online',
                'prompt': 'select_account',
            },
        ),
    )
    # Простой CSRF-guard через cookie.
    response.set_cookie(
        key='google_oauth_state',
        value=state,
        httponly=True,
        secure=False,
        samesite='lax',
        path='/',
    )
    return response


# Вынесено из app/main.py → app/routers/oauth.py
@router.get('/api/auth/google/callback')
def google_callback(request: Request):
    """
    Обрабатывает колбек от Google:
    - проверяет state;
    - обменивает code на токены;
    - получает email/имя пользователя;
    - находит/создаёт пользователя и создаёт сессию;
    - редиректит на SPA.
    """
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail='Google OAuth не настроен')

    params = dict(request.query_params)
    error = params.get('error')
    if error:
        logger.warning('Google OAuth error: %s', error)
        raise HTTPException(status_code=400, detail=f'Ошибка Google OAuth: {error}')

    code = params.get('code')
    state = params.get('state') or ''
    if not code:
        raise HTTPException(status_code=400, detail='Не передан code от Google')

    cookie_state = request.cookies.get('google_oauth_state') or ''
    # В идеале state из query-параметра и cookie должны совпадать.
    # На некоторых мобильных платформах (PWA / внешние браузеры) cookie
    # может потеряться, поэтому:
    # - если cookie есть и он отличается от state — считаем это ошибкой;
    # - если cookie отсутствует, но code/state пришли от Google, продолжаем,
    #   только логируем предупреждение.
    if cookie_state:
        if cookie_state != state:
            raise HTTPException(status_code=400, detail='Некорректный state для Google OAuth')
    else:
        logger.warning('Google OAuth callback without state cookie; continuing without CSRF check')

    # Обмениваем code на access_token и id_token.
    token_data = urllib.parse.urlencode(
        {
            'code': code,
            'client_id': GOOGLE_CLIENT_ID,
            'client_secret': GOOGLE_CLIENT_SECRET,
            'redirect_uri': GOOGLE_REDIRECT_URI,
            'grant_type': 'authorization_code',
        },
    ).encode('utf-8')
    try:
        token_req = urllib.request.Request(
            'https://oauth2.googleapis.com/token',
            data=token_data,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
        )
        with urllib.request.urlopen(token_req, timeout=10) as resp:
            token_info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to exchange code for token: %s', exc)
        raise HTTPException(status_code=502, detail='Не удалось связаться с Google (token)')

    access_token = token_info.get('access_token')
    if not access_token:
        raise HTTPException(status_code=400, detail='Google не вернул access_token')

    # Запрашиваем данные пользователя.
    try:
        user_req = urllib.request.Request(
            'https://openidconnect.googleapis.com/v1/userinfo',
            headers={'Authorization': f'Bearer {access_token}'},
        )
        with urllib.request.urlopen(user_req, timeout=10) as resp:
            user_info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to fetch Google userinfo: %s', exc)
        raise HTTPException(status_code=502, detail='Не удалось получить профиль Google')

    email = (user_info.get('email') or '').strip().lower()
    name = (user_info.get('name') or '').strip() or None
    if not email:
        raise HTTPException(status_code=400, detail='Google не вернул email')

    # Для администратора: логиним существующего пользователя "kirill"
    # по Google-аккаунту с email kirillnad@gmail.com.
    admin_user: User | None = None
    if email == 'kirillnad@gmail.com':
        try:
            admin_user = get_user_by_username('kirill')
        except Exception:  # noqa: BLE001
            admin_user = None

    if admin_user:
        user = admin_user
    else:
        # Для остальных пользователей Google-логин мапится на
        # одного и того же локального пользователя с username == email.
        # Если такой пользователь уже есть — переиспользуем его.
        # Если нет — создаём нового без всяких суффиксов +g1/+g2.
        existing = get_user_by_username(email)
        if existing:
            user = existing
        else:
            random_pwd = os.urandom(16).hex()
            user = create_user(email, random_pwd, name or email, is_superuser=False)

    # Для нового (или только что найденного) пользователя гарантируем
    # наличие стартовой статьи «Руководство пользователя».
    try:
        ensure_help_article_for_user(user.id)
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to ensure help article after Google auth for %s: %r', user.id, exc)

    # Создаём сессию и редиректим в SPA.
    sid = create_session(user.id)
    return _finish_oauth_login(session_id=sid, provider_state_cookie='google_oauth_state')


# Вынесено из app/main.py → app/routers/oauth.py
@router.get('/api/auth/yandex/login')
def yandex_login(request: Request):
    """
    Запускает OAuth-авторизацию через Яндекс ID:
    редиректит пользователя на oauth.yandex.ru/authorize.
    """
    if not YANDEX_CLIENT_ID or not YANDEX_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail='Yandex OAuth не настроен')

    state = os.urandom(16).hex()
    params = {
        'response_type': 'code',
        'client_id': YANDEX_CLIENT_ID,
        'redirect_uri': YANDEX_REDIRECT_URI,
        # Email + доступ к app‑папке на Диске.
        # В настройках OAuth‑клиента должны быть разрешения:
        #  - login:email
        #  - cloud_api:disk.app_folder
        'scope': 'login:email cloud_api:disk.app_folder',
        'state': state,
    }
    response = RedirectResponse(
        url='https://oauth.yandex.ru/authorize?' + urllib.parse.urlencode(params),
    )
    response.set_cookie(
        key='yandex_oauth_state',
        value=state,
        httponly=True,
        secure=False,
        samesite='lax',
        path='/',
    )
    return response


# Вынесено из app/main.py → app/routers/oauth.py
@router.get('/auth/yandex/callback')
def yandex_callback(request: Request):
    """
    Обрабатывает колбек от Яндекса:
    - проверяет state;
    - обменивает code на токены;
    - получает email/uid пользователя;
    - находит/создаёт пользователя и создаёт сессию;
    - сохраняет access_token Яндекса, чтобы позже работать с Диском;
    - редиректит в SPA.
    """
    if not YANDEX_CLIENT_ID or not YANDEX_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail='Yandex OAuth не настроен')

    params = dict(request.query_params)
    error = params.get('error')
    if error:
      logger.warning('Yandex OAuth error: %s', error)
      raise HTTPException(status_code=400, detail=f'Ошибка Yandex OAuth: {error}')

    code = params.get('code') or ''
    state = params.get('state') or ''
    if not code:
        raise HTTPException(status_code=400, detail='Не передан code от Яндекса')

    cookie_state = request.cookies.get('yandex_oauth_state') or ''
    if cookie_state:
        if cookie_state != state:
            raise HTTPException(status_code=400, detail='Некорректный state для Yandex OAuth')
    else:
        logger.warning('Yandex OAuth callback без state cookie; продолжаем без CSRF-проверки')

    token_data = urllib.parse.urlencode(
        {
            'grant_type': 'authorization_code',
            'code': code,
            'client_id': YANDEX_CLIENT_ID,
            'client_secret': YANDEX_CLIENT_SECRET,
        },
    ).encode('utf-8')
    try:
        token_req = urllib.request.Request(
            'https://oauth.yandex.ru/token',
            data=token_data,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
        )
        with urllib.request.urlopen(token_req, timeout=10) as resp:
            token_info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to exchange Yandex code for token: %s', exc)
        raise HTTPException(status_code=502, detail='Не удалось связаться с Яндексом (token)')

    access_token = token_info.get('access_token')
    if not access_token:
        raise HTTPException(status_code=400, detail='Яндекс не вернул access_token')
    refresh_token = token_info.get('refresh_token') or None
    expires_in = token_info.get('expires_in')

    expires_at = None
    if expires_in:
        try:
            expires_at = (datetime.utcnow() + timedelta(seconds=int(expires_in))).isoformat()
        except Exception:  # noqa: BLE001
            expires_at = None

    # Профиль пользователя Яндекса.
    try:
        user_req = urllib.request.Request(
            'https://login.yandex.ru/info?format=json',
            headers={'Authorization': f'OAuth {access_token}'},
        )
        with urllib.request.urlopen(user_req, timeout=10) as resp:
            user_info = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to fetch Yandex userinfo: %s', exc)
        raise HTTPException(status_code=502, detail='Не удалось получить профиль Яндекса')

    # Yandex may return email in `default_email` and/or in a list `emails`.
    # We normalize and consider both to avoid silently creating a "new" user for the same account.
    emails: list[str] = []
    try:
        default_email = (user_info.get('default_email') or '').strip()
        if default_email:
            emails.append(default_email)
        extra = user_info.get('emails') or []
        if isinstance(extra, list):
            emails.extend([str(e or '').strip() for e in extra if str(e or '').strip()])
    except Exception:
        emails = []
    email = (emails[0] if emails else '').strip().lower()
    uid = str(user_info.get('id') or '') or ''
    if not email and not uid:
        raise HTTPException(status_code=400, detail='Яндекс не вернул идентификатор пользователя')

    # Для администратора: логиним существующего пользователя "kirill"
    # по Яндекс-аккаунту с email kirillnad@yandex.ru.
    admin_user: User | None = None
    email_set = {e.lower() for e in emails if e}
    if 'kirillnad@yandex.ru' in email_set:
        try:
            admin_user = get_user_by_username('kirill')
        except Exception:  # noqa: BLE001
            admin_user = None

    if admin_user:
        user = admin_user
    else:
        # Используем email, если он есть, иначе стабильный uid.
        username = email or f'yandex:{uid}'
        display_name = (user_info.get('real_name') or username) or None

        existing = get_user_by_username(username)
        if existing:
            user = existing
        else:
            random_pwd = os.urandom(16).hex()
            user = create_user(username, random_pwd, display_name, is_superuser=False)

    # Сохраняем токены Яндекса для этого пользователя (для дальнейшей работы с Диском).
    # В качестве базового корня для файлов используем app‑папку.
    upsert_yandex_tokens(user.id, access_token, refresh_token, expires_at, disk_root=YANDEX_DISK_APP_ROOT)

    try:
        ensure_help_article_for_user(user.id)
    except Exception as exc:  # noqa: BLE001
        logger.error('Failed to ensure help article after Yandex auth for %s: %r', user.id, exc)

    sid = create_session(user.id)
    return _finish_oauth_login(session_id=sid, provider_state_cookie='yandex_oauth_state')
