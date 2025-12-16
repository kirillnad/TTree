from __future__ import annotations

import logging
import os
import time
import urllib.parse
import urllib.request
from typing import Any

from .db import CONN

logger = logging.getLogger('uvicorn.error')

TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN') or ''

# Простейший антиспам: не чаще одного сообщения в минуту на (user_id, key).
_last_sent_at: dict[tuple[str, str], float] = {}
_MIN_INTERVAL_SECONDS = 60.0


def _send_message(chat_id: str, text: str) -> None:
    if not TELEGRAM_BOT_TOKEN:
        return
    api_url = f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage'
    payload: dict[str, Any] = {
        'chat_id': str(chat_id),
        'text': text,
    }
    try:
        body = urllib.parse.urlencode(payload).encode('utf-8')
        req = urllib.request.Request(
            api_url,
            data=body,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
        )
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception as exc:  # noqa: BLE001
        logger.error('Telegram notify: sendMessage error: %r', exc)


def send_to_user_chats(user_id: str, text: str, *, key: str = 'generic', force: bool = False) -> dict[str, Any]:
    """
    Отправляет сообщение в Telegram-чаты, привязанные к пользователю через /link.
    Используется для ошибок/диагностики (не для пользовательских фич).
    """
    if not user_id or not text or not TELEGRAM_BOT_TOKEN:
        return {'ok': False, 'sent': 0, 'reason': 'missing user/text/token', 'userId': user_id}

    now = time.time()
    rate_key = (user_id, key)
    last = _last_sent_at.get(rate_key, 0.0)
    if not force and now - last < _MIN_INTERVAL_SECONDS:
        return {'ok': False, 'sent': 0, 'reason': 'rate-limited', 'userId': user_id}
    _last_sent_at[rate_key] = now

    try:
        rows = CONN.execute('SELECT chat_id FROM telegram_links WHERE user_id = ?', (user_id,)).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.error('Telegram notify: failed to read telegram_links: %r', exc)
        return {'ok': False, 'sent': 0, 'reason': 'db-error', 'userId': user_id}

    sent = 0
    chat_ids: list[str] = []
    for row in rows or []:
        chat_id = None
        try:
            chat_id = row.get('chat_id')  # type: ignore[union-attr]
        except Exception:
            try:
                chat_id = row['chat_id']  # type: ignore[index]
            except Exception:
                chat_id = None
        if not chat_id:
            continue
        chat_ids.append(str(chat_id))
        _send_message(str(chat_id), text)
        sent += 1
    if sent == 0:
        return {'ok': False, 'sent': 0, 'reason': 'no-linked-chats', 'userId': user_id, 'chatIds': []}
    return {'ok': True, 'sent': sent, 'userId': user_id, 'chatIds': chat_ids}


def notify_user(user_id: str, text: str, *, key: str = 'generic') -> None:
    send_to_user_chats(user_id, text, key=key, force=False)
