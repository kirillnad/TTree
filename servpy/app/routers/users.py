from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import User, get_current_user
from ..db import CONN
from ..data_store import delete_user_with_data

router = APIRouter()

# Вынесено из app/main.py → app/routers/users.py
USERS_PANEL_PASSWORD = os.environ.get('USERS_PANEL_PASSWORD') or 'zZ141400'

# Вынесено из app/main.py → app/routers/users.py
BASE_DIR = Path(__file__).resolve().parents[3]
UPLOADS_DIR = BASE_DIR / 'uploads'


# Вынесено из app/main.py → app/routers/users.py
@router.get('/api/users')
def list_users(request: Request, current_user: User = Depends(get_current_user)):
    if not getattr(current_user, 'is_superuser', False):
        raise HTTPException(status_code=403, detail='Forbidden')
    supplied = request.headers.get('X-Users-Password') or ''
    if USERS_PANEL_PASSWORD and supplied != USERS_PANEL_PASSWORD:
        raise HTTPException(status_code=403, detail='Forbidden')
    rows = CONN.execute(
        '''
        SELECT id, username, display_name, created_at,
               is_superuser
        FROM users
        ORDER BY username
        ''',
    ).fetchall()
    return [
        {
            'id': row['id'],
            'username': row['username'],
            'displayName': row.get('display_name'),
            'createdAt': row['created_at'],
            'isSuperuser': bool(row.get('is_superuser', 0)),
        }
        for row in rows
    ]


# Вынесено из app/main.py → app/routers/users.py
@router.delete('/api/users/{user_id}')
def delete_user(user_id: str, current_user: User = Depends(get_current_user)):
    if not getattr(current_user, 'is_superuser', False):
        raise HTTPException(status_code=403, detail='Forbidden')
    row = CONN.execute(
        'SELECT id, username, is_superuser FROM users WHERE id = ?',
        (user_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='User not found')
    if bool(row.get('is_superuser', 0)):
        raise HTTPException(status_code=400, detail='Cannot delete a superuser')
    # Удаляем данные пользователя в БД.
    delete_user_with_data(user_id)
    # Чистим его uploads на диске.
    user_root = UPLOADS_DIR / user_id
    if user_root.exists():
        import shutil
        shutil.rmtree(user_root, ignore_errors=True)
    return {'status': 'deleted'}

