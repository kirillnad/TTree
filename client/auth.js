import { state } from './state.js';
import { refs } from './refs.js';
import { fetchCurrentUser, login, registerUser, logout } from './api.js?v=11';
import { showToast } from './toast.js';
import { initOfflineForUser } from './offline/index.js';
import { startBackgroundFullPull, startSyncLoop, tryPullBootstrap } from './offline/sync.js';

let appStarted = false;
let onAuthenticated = null;

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
        'Текст и картинки хранятся на серверах Memus.pro, иные вложения сохраняются напрямую на ваш Яндекс.Диск или Google Drive и не проходят через сервер. В Memus сохраняется только ссылка на загруженный файл, которая доступна только вам.';
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
    // При старте нейтральный текст — «загружаем заметки», а не призыв логиниться.
    if (refs.authSubtitle) {
      refs.authSubtitle.textContent = 'Загружаем ваши заметки…';
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
    const authCheck = fetchCurrentUser();
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve(null), 8000);
    });
    const user = await Promise.race([authCheck, timeout]);
    if (user) {
      applyUserToUi(user);
      // ВАЖНО: не блокируем запуск приложения на инициализации offline/PGlite.
      // Иначе на медленных устройствах/профилях оверлей “Загружаем…” может висеть очень долго,
      // хотя сеть уже доступна и сервер отвечает 200.
      hideAuthOverlay();
      ensureAppStarted();
      (async () => {
        let slowToastShown = false;
        let offlineOk = false;
        const slowTimer = setTimeout(() => {
          slowToastShown = true;
          showToast('Инициализируем offline-базу… (может занять время)');
        }, 5000);
        try {
          await initOfflineForUser(user);
          await tryPullBootstrap();
          startSyncLoop();
          startBackgroundFullPull();
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
      return;
    }
  } catch (_) {
    // Игнорируем: просто покажем форму логина.
  }
  // Сессии нет или проверить не удалось — включаем режим логина.
  setAuthMode('login');
  showAuthOverlay();
}
