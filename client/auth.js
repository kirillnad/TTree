import { state } from './state.js';
import { refs } from './refs.js';
import { fetchCurrentUser, login, registerUser, logout } from './api.js';
import { showToast } from './toast.js';

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
      refs.authSubtitle.textContent = 'Войдите через Google, чтобы открыть свои заметки';
    }
    if (refs.authGoogleLoginBtn) {
      refs.authGoogleLoginBtn.classList.remove('hidden');
    }
  }
}

function applyUserToUi(user) {
  state.currentUser = user;
  if (refs.currentUserLabel) {
    refs.currentUserLabel.textContent = user?.displayName || user?.username || '';
  }
  if (refs.usersBtn) {
    const isSuperuser = !!(user && user.isSuperuser);
    refs.usersBtn.classList.toggle('hidden', !isSuperuser);
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

    const user = await fetchCurrentUser();
    if (user) {
      applyUserToUi(user);
      hideAuthOverlay();
      ensureAppStarted();
      return;
    }
  } catch (_) {
    // Игнорируем: просто покажем форму логина.
  }
  // Сессии нет или проверить не удалось — включаем режим логина.
  setAuthMode('login');
  showAuthOverlay();
}
