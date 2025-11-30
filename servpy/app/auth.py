from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Cookie, Depends, HTTPException, Request, Response

from .db import CONN
from .schema import init_schema


SESSION_COOKIE_NAME = 'ttree_session'
SESSION_TTL = timedelta(days=30)


@dataclass
class User:
    id: str
    username: str
    display_name: str | None
    is_superuser: bool = False


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    if salt is None:
        salt = os.urandom(16).hex()
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100_000)
    return salt, dk.hex()


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt, hex_hash = stored_hash.split('$', 1)
    except ValueError:
        return False
    _, candidate = _hash_password(password, salt)
    return hmac.compare_digest(candidate, hex_hash)


def hash_password_for_store(password: str) -> str:
    salt, hex_hash = _hash_password(password)
    return f'{salt}${hex_hash}'


def _create_sessions_table() -> None:
    init_schema()
    CONN.execute(
        '''
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
        ''',
    )


def get_user_by_username(username: str) -> Optional[User]:
    row = CONN.execute(
        'SELECT id, username, display_name, is_superuser FROM users WHERE username = ?',
        (username,),
    ).fetchone()
    if not row:
        return None
    is_super = bool(row.get('is_superuser')) if 'is_superuser' in row else False
    return User(id=row['id'], username=row['username'], display_name=row.get('display_name'), is_superuser=is_super)


def get_user_by_id(user_id: str) -> Optional[User]:
    row = CONN.execute(
        'SELECT id, username, display_name, is_superuser FROM users WHERE id = ?',
        (user_id,),
    ).fetchone()
    if not row:
        return None
    is_super = bool(row.get('is_superuser')) if 'is_superuser' in row else False
    return User(id=row['id'], username=row['username'], display_name=row.get('display_name'), is_superuser=is_super)


def create_user(
    username: str,
    password: str,
    display_name: str | None = None,
    is_superuser: bool = False,
) -> User:
    now = _iso_now()
    pwd_hash = hash_password_for_store(password)
    user_id = os.urandom(16).hex()
    with CONN:
        CONN.execute(
            'INSERT INTO users (id, username, password_hash, display_name, created_at, is_superuser) VALUES (?, ?, ?, ?, ?, ?)',
            (user_id, username, pwd_hash, display_name or username, now, bool(is_superuser)),
        )
    return User(id=user_id, username=username, display_name=display_name or username, is_superuser=is_superuser)


def create_session(user_id: str) -> str:
    _create_sessions_table()
    now = datetime.now(timezone.utc)
    sid = os.urandom(16).hex()
    expires = now + SESSION_TTL
    with CONN:
        CONN.execute(
            'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
            (sid, user_id, now.isoformat(), expires.isoformat()),
        )
    return sid


def get_user_by_session(session_id: str | None) -> Optional[User]:
    if not session_id:
        return None
    _create_sessions_table()
    row = CONN.execute(
        'SELECT user_id, expires_at FROM sessions WHERE id = ?',
        (session_id,),
    ).fetchone()
    if not row:
        return None
    try:
        expires = datetime.fromisoformat(row['expires_at'])
    except Exception:
        return None
    if expires < datetime.now(timezone.utc):
        with CONN:
            CONN.execute('DELETE FROM sessions WHERE id = ?', (session_id,))
        return None
    return get_user_by_id(row['user_id'])


def get_current_user(
    request: Request,
    session_id: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> User:
    user = get_user_by_session(session_id)
    if not user:
        raise HTTPException(status_code=401, detail='Authentication required')
    return user


def set_session_cookie(response: Response, session_id: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_id,
        httponly=True,
        secure=False,
        samesite='lax',
        path='/',
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE_NAME, path='/')


def ensure_superuser(username: str, password: str, display_name: str | None = None) -> None:
    """
    Гарантирует наличие суперпользователя с заданным логином.
    Если пользователь уже есть, повышает его до суперпользователя и обновляет пароль.
    """
    init_schema()
    row = CONN.execute('SELECT id, is_superuser FROM users WHERE username = ?', (username,)).fetchone()
    if row:
        # Обновляем пароль и права.
        pwd_hash = hash_password_for_store(password)
        with CONN:
            CONN.execute(
                'UPDATE users SET password_hash = ?, is_superuser = ? WHERE id = ?',
                (pwd_hash, True, row['id']),
            )
        return
    # Создаём нового суперпользователя.
    create_user(username, password, display_name or username, is_superuser=True)
