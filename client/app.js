import { initRouting, route } from './routing.js';
import { attachEvents } from './events.js';
import { loadLastChangeFromChangelog } from './changelog.js';
import { initAuth, bootstrapAuth } from './auth.js';
import { initUsersPanel } from './users.js';
import { initGraphView } from './graph.js';
import { initTables } from './tables.js';

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
}

async function init() {
  initAuth(startApp);
  await bootstrapAuth();
}

init().catch(() => {
  // Если что-то пошло не так при инициализации, просто покажем форму логина.
});
