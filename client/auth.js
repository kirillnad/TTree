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
  if (!refs.authLoginTab || !refs.authRegisterTab || !refs.authLoginForm || !refs.authRegisterForm) {
    return;
  }
  const isLogin = mode === 'login';
  refs.authLoginTab.classList.toggle('active', isLogin);
  refs.authRegisterTab.classList.toggle('active', !isLogin);
  refs.authLoginForm.classList.toggle('hidden', !isLogin);
  refs.authRegisterForm.classList.toggle('hidden', isLogin);
  setAuthError('');
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

  if (refs.authLoginTab) {
    refs.authLoginTab.addEventListener('click', () => setAuthMode('login'));
  }
  if (refs.authRegisterTab) {
    refs.authRegisterTab.addEventListener('click', () => setAuthMode('register'));
  }
  if (refs.authLoginForm) {
    refs.authLoginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!refs.authLoginUsername || !refs.authLoginPassword) return;
      const username = refs.authLoginUsername.value.trim();
      const password = refs.authLoginPassword.value;
      if (!username || !password) {
        setAuthError('Введите логин и пароль');
        return;
      }
      try {
        setAuthError('');
        const user = await login(username, password);
        applyUserToUi(user);
        hideAuthOverlay();
        ensureAppStarted();
        showToast('Вы вошли в систему');
      } catch (error) {
        setAuthError(error.message || 'Не удалось войти');
      }
    });
  }
  if (refs.authRegisterForm) {
    refs.authRegisterForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!refs.authRegisterUsername || !refs.authRegisterPassword) return;
      const username = refs.authRegisterUsername.value.trim();
      const password = refs.authRegisterPassword.value;
      const displayName = refs.authRegisterDisplayName
        ? refs.authRegisterDisplayName.value.trim()
        : '';
      if (!username || !password) {
        setAuthError('Введите логин и пароль');
        return;
      }
      try {
        setAuthError('');
        const user = await registerUser(username, password, displayName || undefined);
        applyUserToUi(user);
        hideAuthOverlay();
        ensureAppStarted();
        showToast('Аккаунт создан, вы вошли');
      } catch (error) {
        setAuthError(error.message || 'Не удалось создать аккаунт');
      }
    });
  }
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

  // По умолчанию показываем форму входа.
  setAuthMode('login');
}

export async function bootstrapAuth() {
  try {
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
  showAuthOverlay();
}
