from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..auth import User, get_current_user
from ..data_store import get_yandex_tokens
from ..telegram_bot import TELEGRAM_BOT_TOKEN, create_link_token_for_user, process_telegram_update
from ..telegram_notify import send_to_user_chats
from ..db import CONN

# Вынесено из app/main.py → app/routers/telegram.py

router = APIRouter()


@router.post('/api/telegram/link-token')
def telegram_create_link_token(current_user: User = Depends(get_current_user)):
    """
    Создаёт одноразовый токен для привязки текущего пользователя к Telegram‑чату.

    Поток:
      1) пользователь в Memus вызывает этот эндпоинт (через UI);
      2) получает token и отправляет боту команду: /link <token>;
      3) бот сохраняет соответствие chat_id → user_id в telegram_links.
    """
    # Для смысловой привязки хотим, чтобы у пользователя уже был настроен Яндекс.Диск,
    # иначе вложения из Telegram всё равно некуда сохранять.
    tokens = get_yandex_tokens(current_user.id)
    if not tokens or not tokens.get('accessToken'):
        raise HTTPException(
            status_code=400,
            detail='Сначала настройте интеграцию с Яндекс.Диском, затем привязывайте Telegram.',
        )

    return create_link_token_for_user(current_user.id)


@router.post('/api/telegram/webhook/{token}')
def telegram_webhook(token: str, payload: dict[str, Any]):
    """
    Webhook для Telegram‑бота быстрых заметок.

    Ожидает JSON update от Telegram. Для простоты авторизацию делаем по токену
    в URL: /api/telegram/webhook/<TELEGRAM_BOT_TOKEN>.
    """
    if not TELEGRAM_BOT_TOKEN:
        raise HTTPException(status_code=503, detail='Telegram bot не настроен (нет TELEGRAM_BOT_TOKEN)')
    if token != TELEGRAM_BOT_TOKEN:
        raise HTTPException(status_code=403, detail='Invalid token')

    process_telegram_update(payload)
    return {'ok': True}


@router.post('/api/telegram/notify-test')
def telegram_notify_test(current_user: User = Depends(get_current_user)):
    """
    Диагностика: отправляет тестовое сообщение в Telegram-чаты,
    которые пользователь привязал через /link <token>.
    """
    result = send_to_user_chats(
        current_user.id,
        'Memus: тестовое сообщение от сервера (notify-test).',
        key='notify-test',
        force=True,
    )
    if not result.get('ok'):
        raise HTTPException(
            status_code=400,
            detail=(
                'Не удалось отправить тестовое сообщение в Telegram. '
                'Скорее всего этот пользователь не привязан к Telegram через /link.\n'
                f'Details: {result}'
            ),
        )
    return result
