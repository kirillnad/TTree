from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from ..auth import User, clear_session_cookie, get_current_user

router = APIRouter()


# Вынесено из app/main.py → app/routers/auth.py
@router.post('/api/auth/logout')
def logout(response: Response, current_user: User = Depends(get_current_user)):
    clear_session_cookie(response)
    return {'status': 'ok'}


# Вынесено из app/main.py → app/routers/auth.py
@router.get('/api/auth/me')
def me(current_user: User = Depends(get_current_user)):
    return {
        'id': current_user.id,
        'username': current_user.username,
        'displayName': current_user.display_name,
        'isSuperuser': bool(getattr(current_user, 'is_superuser', False)),
    }

