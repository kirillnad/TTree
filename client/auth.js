import { state } from './state.js';
import { refs } from './refs.js';
import { fetchCurrentUser, login, registerUser, logout } from './api.js?v=11';
import { showToast } from './toast.js';
import { initOfflineForUser } from './offline/index.js';
import { startBackgroundFullPull, startSyncLoop, tryPullBootstrap } from './offline/sync.js';

const QUICK_NOTES_DEBUG_KEY = 'ttree_debug_quick_notes_v1';
function quickNotesDebugEnabled() {
  try {
    return window?.localStorage?.getItem?.(QUICK_NOTES_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}
function qlog(...args) {
  try {
    if (!quickNotesDebugEnabled()) return;
    // eslint-disable-next-line no-console
    console.log('[quick-notes][auth]', ...args);
  } catch {
    // ignore
  }
}

let pendingQuickNotesListenerAttached = false;
function attachPendingQuickNotesFlushListener() {
  if (pendingQuickNotesListenerAttached) return;
  pendingQuickNotesListenerAttached = true;
  let timer = null;
  let inFlight = null;

  const tryInsertNoteIntoOpenInbox = async (note) => {
    try {
      const noteId = String(note?.id || '').trim();
      const text = String(note?.text || '').trim();
      if (!noteId || !text) return false;
      if (String(state.articleId || '') !== 'inbox') return false;
      if (!state.article) return false;
      // Insert into the currently open outline editor (so user sees it immediately).
      const outline = await import('./outline/editor.js?v=104');
      if (!outline?.insertOutlineSectionFromPlainTextAtStart) return false;
      const ok = outline.insertOutlineSectionFromPlainTextAtStart(noteId, text);
      if (ok) {
        qlog('inbox.inserted', { noteId });
      }
      return Boolean(ok);
    } catch {
      return false;
    }
  };

  const scheduleSyncLater = () => {
    if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return;
    if (inFlight) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        qlog('sync.start');
        inFlight = import('./quickNotes/queuedInbox.js')
          .then((m) => m.syncQueuedInboxToServer?.())
          .then((res) => {
            qlog('sync.done', res || null);
          })
          .catch(() => {})
          .finally(() => {
            inFlight = null;
          });
      } catch {
        inFlight = null;
      }
    }, 7000);
  };

  const schedule = (event) => {
    const note = event?.detail?.note;
    if (note) {
      // If inbox is already open, insert immediately so user sees it right away.
      tryInsertNoteIntoOpenInbox(note).catch(() => {});
    }
    // Sync queued inbox in background after a delay (when app is likely fully loaded).
    scheduleSyncLater();
  };

  try {
    window.addEventListener('memus:queued-inbox-changed', schedule);
    qlog('listener.attached');
  } catch {
    // ignore
  }
}

let appStarted = false;
let onAuthenticated = null;
const LAST_USER_KEY = 'ttree_last_user_v1';

function showAuthOverlay() {
  if (refs.authOverlay) {
    refs.authOverlay.classList.remove('hidden');
  }
}

function hideAuthOverlay() {
  if (refs.authOverlay) {
    refs.authOverlay.classList.add('hidden');
  }
}

function setAuthError(message) {
  if (refs.authError) {
    refs.authError.textContent = message || '';
    refs.authError.classList.toggle('hidden', !message);
  }
}

function setAuthMode(mode) {
  // Режим логина сейчас только через Google — переключать вкладки и формы не нужно.
  setAuthError('');
  if (mode === 'login') {
    if (refs.authSubtitle) {
      refs.authSubtitle.textContent = 'Заходите, я соскучился! :)';
    }
     if (refs.authStorageInfo) {
      refs.authStorageInfo.textContent =
        'Уведомление о безопасности: Тексты и картинки хранятся на серверах Memus.pro, иные загруженные файлы сохраняются напрямую на ваш Яндекс.Диск. Вы можете зашифровать приватные данные.';
      refs.authStorageInfo.classList.remove('hidden');
    }
    if (refs.authGoogleLoginBtn) {
      refs.authGoogleLoginBtn.classList.remove('hidden');
    }
    if (refs.authYandexLoginBtn) {
      refs.authYandexLoginBtn.classList.remove('hidden');
    }
  }
}

function applyUserToUi(user) {
  state.currentUser = user;
  try {
    const minimal = {
      id: user?.id || null,
      username: user?.username || null,
      displayName: user?.displayName || null,
      isSuperuser: Boolean(user?.isSuperuser),
    };
    if (minimal.id || minimal.username) {
      localStorage.setItem(LAST_USER_KEY, JSON.stringify(minimal));
    }
  } catch {
    // ignore
  }
  if (refs.currentUserLabel) {
    refs.currentUserLabel.textContent = user?.displayName || user?.username || '';
  }
  const isSuperuser = !!(user && user.isSuperuser);
  if (refs.openUsersViewBtn) {
    refs.openUsersViewBtn.classList.toggle('hidden', !isSuperuser);
  }
  if (refs.semanticReindexBtn) {
    refs.semanticReindexBtn.classList.toggle('hidden', !isSuperuser);
  }
}

function ensureAppStarted() {
  if (appStarted || !onAuthenticated) return;
  appStarted = true;
  onAuthenticated();
}

export function initAuth(callback) {
  onAuthenticated = callback;

  // Вход/регистрация по логину и паролю сейчас выключены.
  if (refs.logoutBtn) {
    refs.logoutBtn.addEventListener('click', async () => {
      try {
        await logout();
      } catch (_) {
        /* ignore */
      }
      state.currentUser = null;
      showAuthOverlay();
      showToast('Вы вышли из аккаунта');
      window.location.reload();
    });
  }

  if (refs.authGoogleLoginBtn) {
    refs.authGoogleLoginBtn.addEventListener('click', () => {
      // Перенаправление на серверный OAuth-логин через Google.
      window.location.href = '/api/auth/google/login';
    });
  }

  if (refs.authYandexLoginBtn) {
    refs.authYandexLoginBtn.addEventListener('click', () => {
      window.location.href = '/api/auth/yandex/login';
    });
  }

}

export async function bootstrapAuth() {
  try {
    // If there is no network, skip /api/auth/me and try offline fallback immediately.
    if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
      throw new Error('offline');
    }
    // При старте нейтральный текст — «загружаем заметки», а не призыв логиниться.
    if (refs.authSubtitle) {
      refs.authSubtitle.textContent = 'Загружаем базу знаний…';
    }
    if (refs.authGoogleLoginBtn) {
      refs.authGoogleLoginBtn.classList.add('hidden');
    }
    if (refs.authYandexLoginBtn) {
      refs.authYandexLoginBtn.classList.add('hidden');
    }

    // На некоторых мобильных браузерах (вроде старых WebView/Huawei)
    // запрос /api/auth/me иногда «подвисает» без явной ошибки.
    // Ограничиваем ожидание по таймауту, чтобы не держать оверлей бесконечно.
    const authCheck = fetchCurrentUser().catch(() => null);
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve(null), 8000);
    });
    const user = await Promise.race([authCheck, timeout]);
    if (user) {
      applyUserToUi(user);
      // ВАЖНО: не блокируем запуск приложения на инициализации offline/IndexedDB.
      // Иначе на медленных устройствах/профилях оверлей “Загружаем…” может висеть очень долго,
      // хотя сеть уже доступна и сервер отвечает 200.
      hideAuthOverlay();
      ensureAppStarted();
      attachPendingQuickNotesFlushListener();
      // Sync queued inbox (boot modal) in background.
      try {
        setTimeout(() => {
          import('./quickNotes/queuedInbox.js')
            .then((m) => m.syncQueuedInboxToServer?.())
            .catch(() => {});
        }, 50);
      } catch {
        // ignore
      }
      // Warm up TipTap bundle on idle so first article open doesn't spend seconds on parsing/initialization.
      // This is especially noticeable on mobile after Ctrl-F5 when caches are cold.
      try {
        const warm = () => import('./outline/tiptap.bundle.js?v=3').catch(() => {});
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => warm(), { timeout: 2500 });
        } else {
          setTimeout(() => warm(), 800);
        }
      } catch {
        // ignore
      }
      const startOfflineLater = (fn) => {
        try {
          if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => fn(), { timeout: 3000 });
            return;
          }
        } catch {
          // ignore
        }
        setTimeout(() => fn(), 1500);
      };
      startOfflineLater(() => {
        (async () => {
        let slowToastShown = false;
        let offlineOk = false;
        const slowTimer = setTimeout(() => {
          slowToastShown = true;
          showToast('Инициализируем offline-базу… (может занять время)');
        }, 5000);
        try {
          await initOfflineForUser(user);
          const bootstrapIndex = await tryPullBootstrap();
          startSyncLoop();
          startBackgroundFullPull({ initialIndex: bootstrapIndex || undefined });
          offlineOk = true;
        } catch (err) {
          // Offline в этом браузере может быть недоступен (например, нет IndexedDB),
          // но это не должно ломать онлайн-работу.
          showToast('Offline база недоступна в этом браузере');
          try {
            console.warn('[offline] init failed', err);
          } catch {
            // ignore
          }
        } finally {
          clearTimeout(slowTimer);
          if (slowToastShown && offlineOk) {
            showToast('Offline-база готова');
          }
        }
        })();
      });
      return;
    }
  } catch (_) {
    // Игнорируем: просто покажем форму логина.
  }

  // Offline fallback: allow opening the PWA without network using cached user and IndexedDB.
  try {
    if (!navigator.onLine) {
      const raw = localStorage.getItem(LAST_USER_KEY);
      const cachedUser = raw ? JSON.parse(raw) : null;
      if (cachedUser && (cachedUser.id || cachedUser.username)) {
        applyUserToUi(cachedUser);
        hideAuthOverlay();
        ensureAppStarted();
        showToast('Оффлайн режим: используем локальные данные');
        try {
          await initOfflineForUser(cachedUser);
          startSyncLoop();
        } catch (err) {
          try {
            console.warn('[offline] init failed', err);
          } catch {
            // ignore
          }
        }
        return;
      }
      setAuthError('Нет интернета. Оффлайн-режим будет доступен после первого входа онлайн.');
    }
  } catch {
    // ignore
  }

  // Сессии нет или проверить не удалось — включаем режим логина.
  setAuthMode('login');
  showAuthOverlay();
}
