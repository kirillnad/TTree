import { initRouting, route } from './routing.js';
import { attachEvents } from './events.js';
import { loadLastChangeFromChangelog } from './changelog.js';
import { initAuth, bootstrapAuth } from './auth.js';
import { initUsersPanel } from './users.js';
import { initGraphView } from './graph.js';
import { initTables } from './tables.js';
import { refs } from './refs.js';

/**
 * Инициализация приложения
 */
function startApp() {
  initRouting();
  attachEvents();
  initUsersPanel();
  initGraphView();
  initTables();
  loadLastChangeFromChangelog();
  route(window.location.pathname);

  // Регистрация service worker для PWA (если поддерживается).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js')
      .catch(() => {
        // Молча игнорируем ошибки регистрации — приложение продолжит работать как обычно.
      });
  }

  // Обработка beforeinstallprompt: показываем свою кнопку "Установить приложение".
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (refs.installAppBtn) {
      refs.installAppBtn.classList.remove('hidden');
    }
  });

  if (refs.installAppBtn) {
    refs.installAppBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try {
        await deferredInstallPrompt.userChoice;
      } finally {
        deferredInstallPrompt = null;
        refs.installAppBtn.classList.add('hidden');
      }
    });
  }
}

async function init() {
  initAuth(startApp);
  await bootstrapAuth();
}

init().catch(() => {
  // Если что-то пошло не так при инициализации, просто покажем форму логина.
});
