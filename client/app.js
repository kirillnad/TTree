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
  // На мобильных (и вообще в браузере) больше не используем service worker,
  // чтобы ничего не кешировалось "поверх" обычного обновления страницы.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => {
        registrations.forEach((registration) => {
          registration.unregister().catch(() => {});
        });
      })
      .catch(() => {});
  }
}

async function init() {
  initAuth(startApp);
  await bootstrapAuth();
}

init().catch(() => {
  // Если что-то пошло не так при инициализации, просто покажем форму логина.
});
