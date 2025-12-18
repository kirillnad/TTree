// Вынесено из `article.js`: шифрование/расшифровка статьи и управление ключами.

import { state } from '../state.js';
import { apiRequest } from '../api.js?v=4';
import { showToast } from '../toast.js';
import { showPrompt, showConfirm, showPasswordWithHintPrompt } from '../modal.js?v=5';
import { logDebug } from '../utils.js';
import {
  deriveKeyFromPassword,
  decryptArticleBlocks,
  checkEncryptionVerifier,
  createEncryptionVerifier,
  encryptTextForArticle,
} from '../encryption.js';
import { upsertArticleIndex } from '../sidebar.js';
import { updateArticleHeaderUi } from './header.js';

function setCurrentArticleKey(key) {
  if (!state.articleId) return;
  if (!state.articleEncryptionKeys) state.articleEncryptionKeys = {};
  if (key) {
    state.articleEncryptionKeys[state.articleId] = key;
  } else {
    delete state.articleEncryptionKeys[state.articleId];
  }
}

export async function ensureArticleDecrypted(article) {
  if (!article || !article.encrypted) {
    if (article) {
      logDebug('ensureArticleDecrypted: skip (not encrypted)', {
        id: article.id,
        encrypted: article.encrypted,
        hasSalt: Boolean(article.encryptionSalt),
        hasVerifier: Boolean(article.encryptionVerifier),
      });
    }
    return article;
  }

  // Уже есть ключ в памяти — просто расшифровываем без повторного запроса пароля.
  const existingKey = state.articleEncryptionKeys?.[article.id] || null;
  if (existingKey) {
    logDebug('ensureArticleDecrypted: using cached key', {
      id: article.id,
      encrypted: article.encrypted,
    });
    await decryptArticleBlocks(article, existingKey);
    return article;
  }

  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts += 1;
    let password = null;
    try {
      const hint = article.encryptionHint || '';
      const baseMessage = 'Введите пароль для этой страницы.';
      const message = hint ? `${baseMessage}\nПодсказка: ${hint}` : baseMessage;
      // eslint-disable-next-line no-await-in-loop
      password = await showPrompt({
        title: 'Страница зашифрована',
        message,
        confirmText: 'Открыть',
        cancelText: 'Отмена',
        placeholder: 'Пароль',
        inputType: 'password',
      });
    } catch (error) {
      // fallback на prompt браузера
      // eslint-disable-next-line no-alert
      password = window.prompt('Страница зашифрована. Введите пароль:') || '';
    }
    if (!password) {
      throw new Error('Пароль не введён');
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const { key } = await deriveKeyFromPassword(password, article.encryptionSalt || '');
      // eslint-disable-next-line no-await-in-loop
      const ok = await checkEncryptionVerifier(key, article.encryptionVerifier || '');
      if (!ok) {
        if (attempts >= 3) {
          throw new Error('Неверный пароль');
        }
        // eslint-disable-next-line no-alert
        window.alert('Неверный пароль, попробуйте ещё раз.');
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await decryptArticleBlocks(article, key);
      setCurrentArticleKey(key);
      logDebug('ensureArticleDecrypted: decrypted with password', {
        id: article.id,
        encrypted: article.encrypted,
      });
      return article;
    } catch (error) {
      if (attempts >= 3) {
        throw new Error(error.message || 'Не удалось расшифровать страницу');
      }
      // eslint-disable-next-line no-alert
      window.alert('Не удалось расшифровать страницу, попробуйте ещё раз.');
    }
  }
}

async function encryptAllBlocksOnServer(article, key) {
  if (!article || !Array.isArray(article.blocks)) return;
  const queue = [...article.blocks];
  // eslint-disable-next-line no-restricted-syntax
  for (const block of queue) {
    const children = Array.isArray(block.children) ? block.children : [];
    queue.push(...children);
    const currentText = block.text || '';
    // eslint-disable-next-line no-await-in-loop
    const encryptedText = await encryptTextForArticle(key, currentText);
    // eslint-disable-next-line no-await-in-loop
    await apiRequest(`/api/articles/${article.id}/blocks/${block.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ text: encryptedText }),
    });
  }
}

export async function toggleArticleEncryption() {
  if (!state.article || !state.articleId) {
    showToast('Сначала откройте статью');
    return;
  }
  if (state.articleId === 'inbox') {
    showToast('Быстрые заметки нельзя зашифровать');
    return;
  }
  if (!state.currentUser) {
    showToast('Нужно войти в систему');
    return;
  }

  const article = state.article;

  // Если статья уже зашифрована — считаем это сменой пароля (перешифровкой).
  if (article.encrypted) {
    let payload = null;
    try {
      payload = await showPasswordWithHintPrompt({
        title: 'Сменить пароль',
        message: 'Введите новый пароль и при желании подсказку.',
        confirmText: 'Перешифровать',
        cancelText: 'Отмена',
      });
    } catch (error) {
      payload = null;
    }
    if (!payload || !payload.password) return;
    const { password, hint } = payload;
    try {
      const { key, salt } = await deriveKeyFromPassword(password, '');
      const verifier = await createEncryptionVerifier(key);
      showToast('Перешифровываем содержимое страницы...');
      await encryptAllBlocksOnServer(article, key);
      const updated = await apiRequest(`/api/articles/${state.articleId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          encrypted: true,
          encryptionSalt: salt,
          encryptionVerifier: verifier,
          encryptionHint: hint || null,
        }),
      });
      article.encrypted = true;
      article.encryptionSalt = salt;
      article.encryptionVerifier = verifier;
      article.encryptionHint = hint || null;
      article.updatedAt = updated?.updatedAt || article.updatedAt;
      setCurrentArticleKey(key);
      upsertArticleIndex(updated);
      updateArticleHeaderUi();
      showToast('Пароль обновлён');
      logDebug('toggleArticleEncryption: password changed', {
        id: article.id,
        encrypted: article.encrypted,
        hasSalt: Boolean(article.encryptionSalt),
        hasVerifier: Boolean(article.encryptionVerifier),
      });
    } catch (error) {
      showToast(error.message || 'Не удалось перешифровать страницу');
    }
    return;
  }

  // Иначе включаем шифрование.
  let payload = null;
  try {
    payload = await showPasswordWithHintPrompt({
      title: 'Зашифровать',
      message: 'Введите пароль и при желании подсказку.',
      confirmText: 'Зашифровать',
      cancelText: 'Отмена',
    });
  } catch (error) {
    payload = null;
  }
  if (!payload || !payload.password) return;
  const { password, hint } = payload;

  try {
    const { key, salt } = await deriveKeyFromPassword(password, '');
    const verifier = await createEncryptionVerifier(key);
    showToast('Шифруем содержимое страницы...');
    await encryptAllBlocksOnServer(article, key);
    const updated = await apiRequest(`/api/articles/${state.articleId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        encrypted: true,
        encryptionSalt: salt,
        encryptionVerifier: verifier,
        encryptionHint: hint || null,
      }),
    });
    article.encrypted = true;
    article.encryptionSalt = salt;
    article.encryptionVerifier = verifier;
    article.encryptionHint = hint || null;
    article.updatedAt = updated?.updatedAt || article.updatedAt;
    setCurrentArticleKey(key);
    upsertArticleIndex(updated);
    updateArticleHeaderUi();
    showToast('Шифрование включено');
    logDebug('toggleArticleEncryption: enabled', {
      id: article.id,
      encrypted: article.encrypted,
      hasSalt: Boolean(article.encryptionSalt),
      hasVerifier: Boolean(article.encryptionVerifier),
    });
  } catch (error) {
    showToast(error.message || 'Не удалось включить шифрование');
  }
}

export async function removeArticleEncryption() {
  if (!state.article || !state.articleId) {
    showToast('Сначала откройте статью');
    return;
  }
  if (state.articleId === 'inbox') {
    showToast('Быстрые заметки нельзя зашифровать/расшифровать');
    return;
  }
  const article = state.article;
  if (!article.encrypted) {
    showToast('Страница уже не зашифрована');
    return;
  }

  let confirmed = false;
  try {
    confirmed = await showConfirm({
      title: 'Снять защиту?',
      message: 'Содержимое страницы будет сохранено в открытом виде.',
      confirmText: 'Снять защиту',
      cancelText: 'Отмена',
    });
  } catch (error) {
    // eslint-disable-next-line no-alert
    confirmed = window.confirm('Снять защиту и сохранить страницу в открытом виде?');
  }
  if (!confirmed) return;

  try {
    showToast('Сохраняем страницу в открытом виде...');
    if (Array.isArray(article.blocks)) {
      const queue = [...article.blocks];
      // eslint-disable-next-line no-restricted-syntax
      for (const block of queue) {
        const children = Array.isArray(block.children) ? block.children : [];
        queue.push(...children);
        const plainText = block.text || '';
        // eslint-disable-next-line no-await-in-loop
        await apiRequest(`/api/articles/${article.id}/blocks/${block.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ text: plainText }),
        });
      }
    }
    const updated = await apiRequest(`/api/articles/${state.articleId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        encrypted: false,
        encryptionSalt: null,
        encryptionVerifier: null,
      }),
    });
    article.encrypted = false;
    article.encryptionSalt = null;
    article.encryptionVerifier = null;
    article.encryptionHint = null;
    article.updatedAt = updated?.updatedAt || article.updatedAt;
    setCurrentArticleKey(null);
    upsertArticleIndex(updated);
    updateArticleHeaderUi();
    showToast('Шифрование страницы отключено');
    logDebug('removeArticleEncryption: disabled', {
      id: article.id,
      encrypted: article.encrypted,
    });
  } catch (error) {
    showToast(error.message || 'Не удалось отключить шифрование');
  }
}
