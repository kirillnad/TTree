#!/usr/bin/env python3
"""
Простой Telegram‑бот для сбора обратной связи от пользователей Memus.

Функции:
  - принимает любые текстовые сообщения от пользователей;
  - пересылает их администратору (тебе) в личку как «пересланное сообщение»;
  - когда администратор отвечает на это пересланное сообщение, ответ уходит
    обратно пользователю в его диалог с ботом (а не администратору);
  - пользователю отправляется короткое подтверждение, что сообщение доставлено.

Конфигурация через переменные окружения:
  TELEGRAM_BOT_TOKEN       — токен бота от BotFather (обязательно);
  TELEGRAM_ADMIN_CHAT_ID   — chat_id администратора, по умолчанию 42981813 (@Kirillnad).
"""

import logging
import os
from textwrap import shorten
from typing import Any, Dict

from telegram import Message, Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, MessageHandler, filters


logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)


TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
ADMIN_CHAT_ID = int(os.getenv("TELEGRAM_ADMIN_CHAT_ID", "42981813"))

if not TOKEN:
    raise RuntimeError(
        "TELEGRAM_BOT_TOKEN не задан. "
        "Установите переменную окружения TELEGRAM_BOT_TOKEN с токеном @Memus_feedback_bot.",
    )


# Соответствие: message_id в чате администратора -> информация о пользователе,
# чей запрос отображён в этом сообщении.
ADMIN_INBOX: Dict[int, Dict[str, Any]] = {}


def format_user_label_from_user(user) -> str:
    if not user:
        return "неизвестный пользователь"
    parts = []
    if user.first_name:
        parts.append(user.first_name)
    if user.last_name:
        parts.append(user.last_name)
    full_name = " ".join(parts) or user.username or str(user.id)
    username_part = f" (@{user.username})" if user.username else ""
    return f"{full_name}{username_part} [id={user.id}]"


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Обработка /start."""
    user_label = format_user_label_from_user(update.effective_user)
    logger.info("User started bot: %s", user_label)

    await update.message.reply_text(
        "Привет! Это бот обратной связи Memus.\n"
        "Напишите сюда любые вопросы, идеи или баги — я передам их автору.",
    )

    # Уведомляем администратора о новом /start
    try:
        await context.bot.send_message(
            chat_id=ADMIN_CHAT_ID,
            text=f"👤 Новый пользователь написал /start: {user_label}",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to notify admin about /start: %s", exc)


async def handle_user_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Любое обычное текстовое сообщение от пользователя (не администратора)."""
    if not update.message:
        return

    user = update.effective_user
    user_label = format_user_label_from_user(user)
    text = update.message.text or ""

    logger.info(
        "Incoming message from %s (id=%s): %s",
        user_label,
        user.id if user else None,
        shorten(text, width=120),
    )

    # Отправляем отдельное сообщение администратору с текстом и данными пользователя
    # и запоминаем сопоставление message_id -> user_id.
    try:
        admin_text = (
            "✉️ Новое сообщение от пользователя:\n"
            f"{user_label}\n\n"
            f"Текст:\n{text}"
        )
        admin_msg: Message = await context.bot.send_message(
            chat_id=ADMIN_CHAT_ID,
            text=admin_text,
        )
        ADMIN_INBOX[admin_msg.message_id] = {
            "user_id": user.id if user else None,
            "label": user_label,
        }
        logger.info(
            "Registered admin_msg_id=%s for user_id=%s",
            admin_msg.message_id,
            user.id if user else None,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to deliver message to admin: %s", exc)

    # Подтверждаем пользователю
    try:
        await update.message.reply_text(
            "Спасибо за сообщение! Я передал его автору Memus.\n"
            "Если нужно, с вами свяжутся через Telegram.",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to reply to user: %s", exc)


async def handle_admin_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Обработка текстовых сообщений от администратора.
    Правила:
      1. Если это reply на пересланное сообщение и в нём есть forward_from —
         отвечаем именно этому пользователю.
      2. В остальных случаях показываем подсказку администратору.
    """
    msg = update.message
    if not msg:
        return

    # Пытаемся определить, это ли ответ на сообщение, которое бот показывал администратору.
    target_user_id = None
    target_label = None

    original = msg.reply_to_message
    if original:
        meta = ADMIN_INBOX.get(original.message_id)
        if meta:
            target_user_id = meta.get("user_id")
            target_label = meta.get("label")
            logger.info(
                "Resolved admin reply via ADMIN_INBOX: msg_id=%s -> user_id=%s",
                original.message_id,
                target_user_id,
            )

    if not target_user_id:
        await msg.reply_text(
            "Не удалось определить, кому отправить ответ.\n"
            "Ответить можно только на пересланное ботом сообщение: "
            "нажмите «Ответить» / Reply на нужном сообщении пользователя.",
        )
        return

    text_to_send = msg.text or msg.caption or ""
    if not text_to_send.strip():
        await msg.reply_text("Пустое сообщение не отправлено.")
        return

    try:
        await context.bot.send_message(
            chat_id=target_user_id,
            text=text_to_send,
        )
        info = f"Ответ отправлен пользователю: {target_label or target_user_id}."
        await msg.reply_text(info, quote=True)
        logger.info(
            "Delivered admin reply to user_id=%s (%s): %s",
            target_user_id,
            target_label,
            shorten(text_to_send, width=120),
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to send admin reply to user: %s", exc)
        await msg.reply_text("Не удалось отправить сообщение пользователю.")


async def handle_unknown(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """На всякий случай обработчик неизвестных команд."""
    if not update.message:
        return
    await update.message.reply_text(
        "Я пока понимаю только обычные текстовые сообщения.\n"
        "Просто напишите, что хотите передать автору Memus.",
    )


async def handle_text_router(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Единая точка входа для всех текстовых сообщений (без команд).
    Внутри решаем, это администратор или обычный пользователь.
    """
    user = update.effective_user
    if user and user.id == ADMIN_CHAT_ID:
        await handle_admin_message(update, context)
    else:
        await handle_user_text(update, context)


def main() -> None:
    """Точка входа: запускает long polling."""
    logger.info("Starting Telegram feedback bot for Memus...")
    app = ApplicationBuilder().token(TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", start))
    # Все текстовые сообщения (кроме команд) проходят через один роутер.
    app.add_handler(
        MessageHandler(
            filters.TEXT & (~filters.COMMAND),
            handle_text_router,
        ),
    )
    app.add_handler(MessageHandler(filters.COMMAND, handle_unknown))

    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
