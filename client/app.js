import { initRouting, route } from './routing.js';
import { attachEvents } from './events.js?v=18';
import { loadLastChangeFromChangelog } from './changelog.js';
import { initAuth, bootstrapAuth } from './auth.js';
import { initUsersPanel } from './users.js';
import { initGraphView } from './graph.js';
import { initTables } from './tables.js';
import { initSidebarStateFromStorage } from './sidebar.js';
import { refs } from './refs.js';

function logClient(kind, data) {
  try {
    fetch('/api/client/log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        data,
      }),
    }).catch(() => {});
  } catch {
    // ignore logging errors
  }
}

/**
 * Инициализация приложения
 */
function startApp() {
  logClient('app.start', {
    ua: navigator.userAgent,
  });
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
    const sw = navigator.serviceWorker;
    if (sw && typeof sw.getRegistrations === 'function') {
      sw
        .getRegistrations()
        .then((registrations) => {
          registrations.forEach((registration) => {
            registration.unregister().catch(() => {});
          });
        })
        .catch(() => {});
    } else if (sw && typeof sw.getRegistration === 'function') {
      sw
        .getRegistration()
        .then((registration) => {
          if (registration) {
            registration.unregister().catch(() => {});
          }
        })
        .catch(() => {});
    }
  }
}

function startPublicApp() {
  logClient('app.public.start', {
    ua: navigator.userAgent,
    path: window.location.pathname,
  });
  if (refs.authOverlay) refs.authOverlay.classList.add('hidden');
  initRouting();
  attachEvents();
  route(window.location.pathname);
  if ('serviceWorker' in navigator) {
    const sw = navigator.serviceWorker;
    if (sw && typeof sw.getRegistrations === 'function') {
      sw
        .getRegistrations()
        .then((registrations) => {
          registrations.forEach((registration) => {
            registration.unregister().catch(() => {});
          });
        })
        .catch(() => {});
    } else if (sw && typeof sw.getRegistration === 'function') {
      sw
        .getRegistration()
        .then((registration) => {
          if (registration) {
            registration.unregister().catch(() => {});
          }
        })
        .catch(() => {});
    }
  }
}

async function init() {
  if (/^\/p\/[^/?#]+/.test(window.location.pathname)) {
    startPublicApp();
    return;
  }
  logClient('auth.bootstrap.start', {
    ua: navigator.userAgent,
  });
  initAuth(startApp);
  await bootstrapAuth();
  logClient('auth.bootstrap.done', {
    ua: navigator.userAgent,
  });
}

init().catch(() => {
  // Если что-то пошло не так при инициализации, просто покажем форму логина.
});
