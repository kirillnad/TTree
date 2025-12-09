import { initRouting, route } from './routing.js';
import { attachEvents } from './events.js';
import { loadLastChangeFromChangelog } from './changelog.js';
import { initAuth, bootstrapAuth } from './auth.js';
import { initUsersPanel } from './users.js';
import { initGraphView } from './graph.js';
import { initTables } from './tables.js';
import { initSidebarStateFromStorage } from './sidebar.js';

/**
 * Инициализация приложения
 */
function startApp() {
  initRouting();
  attachEvents();
  initSidebarStateFromStorage();
  initUsersPanel();
  initGraphView();
  initTables();
  loadLastChangeFromChangelog();
  route(window.location.pathname);
  // Регистрация service worker для PWA (если поддерживается).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      // Версионируем URL, чтобы гарантированно обойти старый кэшированный sw.js.
      .register('/sw.js?v=2')
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
