import { initRouting, route } from './routing.js';
import { attachEvents } from './events.js?v=22';
import { initAuth, bootstrapAuth } from './auth.js?v=2';
import { initSidebarStateFromStorage } from './sidebar.js';
import { refs } from './refs.js';

// Used by `boot.js` to detect "slow boot" (app module didn't start quickly).
try {
  window.__memusAppStarted = true;
} catch {
  // ignore
}

function applyDebugFlagsFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const raw = params.get('profile') ?? params.get('perf');
    if (raw == null) return;
    const v = String(raw).trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') {
      window.localStorage.setItem('ttree_profile_v1', '1');
      return;
    }
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') {
      window.localStorage.removeItem('ttree_profile_v1');
    }
  } catch {
    // ignore
  }
}

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
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return;
  // Disable noisy client logging by default; enable only for debugging.
  try {
    if (window?.localStorage?.getItem?.('ttree_client_log_v1') !== '1') return;
  } catch {
    return;
  }
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

function runOnIdle(fn, { timeout = 3000, fallbackDelay = 1200 } = {}) {
  try {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => fn(), { timeout });
      return;
    }
  } catch {
    // ignore
  }
  setTimeout(() => fn(), fallbackDelay);
}

function attachLazyGraphInit() {
  if (!refs.graphToggleBtn) return;
  let inFlight = null;

  const onClickCapture = async () => {
    if (inFlight) return;
    inFlight = import('./graph.js')
      .then((m) => {
        refs.graphToggleBtn?.removeEventListener('click', onClickCapture, true);
        m.initGraphView?.();
        m.openGraphView?.();
      })
      .catch(() => {
        // If module isn't cached and we're offline, allow retry on next click.
      })
      .finally(() => {
        inFlight = null;
      });
  };

  refs.graphToggleBtn.addEventListener('click', onClickCapture, true);
}

function attachLazyUsersInit() {
  if (!refs.openUsersViewBtn) return;
  let inFlight = null;

  const onClickCapture = async () => {
    if (inFlight) return;
    inFlight = import('./users.js')
      .then((m) => {
        refs.openUsersViewBtn?.removeEventListener('click', onClickCapture, true);
        m.initUsersPanel?.();
        // re-trigger click so the real handler runs
        setTimeout(() => refs.openUsersViewBtn?.click(), 0);
      })
      .catch(() => {
        // allow retry on next click
      })
      .finally(() => {
        inFlight = null;
      });
  };

  refs.openUsersViewBtn.addEventListener('click', onClickCapture, true);
}

/**
 * Инициализация приложения
 */
function startApp() {
  applyDebugFlagsFromUrl();
  logClient('app.start', {
    ua: navigator.userAgent,
  });
  registerUploadsServiceWorker();
  initRouting();
  attachEvents();
  initSidebarStateFromStorage();
  attachLazyGraphInit();
  attachLazyUsersInit();
  runOnIdle(() => {
    import('./tables.js')
      .then((m) => m.initTables?.())
      .catch(() => {});
  });
  runOnIdle(
    () => {
      import('./changelog.js')
        .then((m) => m.loadLastChangeFromChangelog?.())
        .catch(() => {});
    },
    { timeout: 6000, fallbackDelay: 2500 },
  );
  route(window.location.pathname);
}

function startPublicApp() {
  applyDebugFlagsFromUrl();
  logClient('app.public.start', {
    ua: navigator.userAgent,
    path: window.location.pathname,
  });
  if (refs.authOverlay) refs.authOverlay.classList.add('hidden');
  registerUploadsServiceWorker();
  initRouting();
  attachEvents();
  attachLazyGraphInit();
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
