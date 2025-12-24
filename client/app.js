import { initRouting, route } from './routing.js';
import { attachEvents } from './events.js?v=22';
import { loadLastChangeFromChangelog } from './changelog.js';
import { initAuth, bootstrapAuth } from './auth.js?v=2';
import { initUsersPanel } from './users.js';
import { initGraphView } from './graph.js';
import { initTables } from './tables.js';
import { initSidebarStateFromStorage } from './sidebar.js';
import { refs } from './refs.js';

function registerUploadsServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    navigator.serviceWorker
      .register('/uploads-sw.js', { scope: '/' })
      .catch(() => {
        // ignore SW registration failures
      });
  } catch {
    // ignore
  }
}

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
  registerUploadsServiceWorker();
  initRouting();
  attachEvents();
  initSidebarStateFromStorage();
  initUsersPanel();
  initGraphView();
  initTables();
  loadLastChangeFromChangelog();
  route(window.location.pathname);
}

function startPublicApp() {
  logClient('app.public.start', {
    ua: navigator.userAgent,
    path: window.location.pathname,
  });
  if (refs.authOverlay) refs.authOverlay.classList.add('hidden');
  registerUploadsServiceWorker();
  initRouting();
  attachEvents();
  route(window.location.pathname);
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
