import { initRouting, route } from '../routing.js';
import { attachEvents } from '../events.js';
import { initAuth, bootstrapAuth } from '../auth.js';
import { initSidebarStateFromStorage } from '../sidebar.js';
import { refs } from '../refs.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { showConfirm } from '../modal.js';

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
      .register('/uploads-sw.js', { scope: '/', updateViaCache: 'none' })
      .then((reg) => {
        // Ensure the browser checks the SW script immediately (otherwise it can stay on an old SW for a long time).
        try {
          const p = reg?.update?.();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {
          // ignore
        }
      })
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

function withTimeout(promise, ms) {
  const t = typeof ms === 'number' ? Math.max(0, Math.floor(ms)) : 0;
  if (!t) return Promise.resolve().then(() => promise);
  let timer = null;
  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), t);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function pingServer({ timeoutMs = 2500 } = {}) {
  let controller = null;
  let timer = null;
  try {
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
      }, Math.max(0, Math.floor(timeoutMs)));
    }
    const resp = await fetch('/api/auth/me', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
    });
    return { ok: resp.ok, status: resp.status };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err || '') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function initResumeRecoveryWatchdog() {
  // Goal: after long idle/sleep, users can get into a "half-alive" state:
  // - clicks don't trigger requests
  // - soft reload doesn't help
  // This adds:
  // - lifecycle logging (optional)
  // - a gentle prompt to reload on "resume after long idle" if server ping fails
  let lastInteractionAt = Date.now();
  let lastPromptAt = 0;
  let wasFrozenAt = 0;

  const recordInteraction = () => {
    lastInteractionAt = Date.now();
  };
  ['pointerdown', 'keydown', 'focus', 'touchstart', 'mousedown'].forEach((evt) => {
    try {
      window.addEventListener(evt, recordInteraction, true);
    } catch {
      // ignore
    }
  });

  const logLife = (kind, extra = {}) => {
    logClient(kind, {
      t: new Date().toISOString(),
      path: window.location.pathname,
      hidden: Boolean(document.hidden),
      onLine: (() => {
        try {
          return navigator?.onLine !== false;
        } catch {
          return null;
        }
      })(),
      serverStatus: String(state.serverStatus || ''),
      offlineReady: Boolean(state.offlineReady),
      articlesIndexLen: Array.isArray(state.articlesIndex) ? state.articlesIndex.length : null,
      ...extra,
    });
  };

  const maybePromptReload = async (reason) => {
    const now = Date.now();
    if (now - lastPromptAt < 60_000) return;
    lastPromptAt = now;
    logLife('app.resume_check.start', { reason });

    const ping = await pingServer({ timeoutMs: 2500 });
    logLife('app.resume_check.done', { reason, ping });

    // If the server is reachable, do nothing.
    if (ping && ping.ok) return;

    // If browser says offline, do not spam a reload prompt.
    try {
      if (navigator?.onLine === false) {
        showToast('Нет интернета. Оффлайн режим должен работать после докачки.');
        return;
      }
    } catch {
      // ignore
    }

    // If we are in "auth required", the existing auth flow will handle it.
    if (ping && (ping.status === 401 || ping.status === 403)) return;

    // User-facing: suggest a reload.
    const action = await showConfirm({
      title: 'Приложение могло “уснуть”',
      message:
        'После долгого бездействия браузер может заморозить вкладку. Если клики/обновление не работают — перезагрузите приложение.',
      confirmText: 'Перезагрузить',
      cancelText: 'Позже',
    }).catch(() => false);
    if (action) {
      try {
        window.location.reload();
      } catch {
        // ignore
      }
    }
  };

  const onResume = (src) => {
    const now = Date.now();
    const idleMs = now - (lastInteractionAt || now);
    const frozenMs = wasFrozenAt ? now - wasFrozenAt : 0;
    logLife('app.lifecycle', { src, idleMs, frozenMs });
    // Only act on long inactivity (>= 2h) or after a freeze event.
    if (idleMs < 2 * 60 * 60 * 1000 && !wasFrozenAt) return;
    if (document.hidden) return;
    maybePromptReload(src).catch(() => {});
  };

  try {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) onResume('visibility');
    });
  } catch {
    // ignore
  }
  try {
    window.addEventListener('pageshow', () => onResume('pageshow'));
    window.addEventListener('pagehide', () => logLife('app.lifecycle', { src: 'pagehide' }));
  } catch {
    // ignore
  }
  try {
    document.addEventListener('freeze', () => {
      wasFrozenAt = Date.now();
      logLife('app.lifecycle', { src: 'freeze' });
    });
    document.addEventListener('resume', () => onResume('resume'));
  } catch {
    // ignore
  }
}

function initWakeLockManager() {
  // Screen Wake Lock API can help prevent the display from turning off while the user edits
  // (or while there are unsynced changes), but browsers may still suspend the page in background.
  // We request it only after a user gesture, and only when it makes sense.
  const supported = Boolean(navigator && navigator.wakeLock && typeof navigator.wakeLock.request === 'function');
  if (!supported) return;

  let sentinel = null;
  let hasUserGesture = false;
  let lastAttemptAt = 0;

  const log = (kind, data) => {
    logClient(kind, {
      t: new Date().toISOString(),
      ...data,
    });
  };

  const shouldHold = () => {
    try {
      if (document.hidden) return false;
    } catch {
      // ignore
    }
    const outboxN = (() => {
      try {
        return state.outboxCount == null ? 0 : Number(state.outboxCount) || 0;
      } catch {
        return 0;
      }
    })();
    return state.mode === 'edit' || Boolean(state.isOutlineEditing) || outboxN > 0;
  };

  const release = async (reason) => {
    if (!sentinel) return;
    try {
      await sentinel.release();
    } catch {
      // ignore
    } finally {
      sentinel = null;
      log('wake_lock.release', { reason });
    }
  };

  const ensure = async (reason) => {
    if (!shouldHold()) {
      await release(`not_needed:${reason}`);
      return;
    }
    if (!hasUserGesture) return;
    if (sentinel) return;

    const now = Date.now();
    if (now - lastAttemptAt < 1500) return;
    lastAttemptAt = now;

    try {
      sentinel = await navigator.wakeLock.request('screen');
      log('wake_lock.acquired', { reason });
      try {
        sentinel.addEventListener('release', () => {
          sentinel = null;
          log('wake_lock.released', { reason: 'event' });
        });
      } catch {
        // ignore
      }
    } catch (err) {
      sentinel = null;
      log('wake_lock.failed', { reason, err: String(err?.name || err?.message || err || '') });
    }
  };

  const onUserGesture = () => {
    hasUserGesture = true;
    ensure('gesture').catch(() => {});
  };

  ['pointerdown', 'keydown', 'touchstart', 'mousedown'].forEach((evt) => {
    try {
      window.addEventListener(evt, onUserGesture, { capture: true, passive: true });
    } catch {
      // ignore
    }
  });

  try {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        release('hidden').catch(() => {});
      } else {
        ensure('visible').catch(() => {});
      }
    });
  } catch {
    // ignore
  }

  // Poll: state changes (edit/outbox) aren't centrally observable here, keep it simple.
  setInterval(() => {
    ensure('tick').catch(() => {});
  }, 2000);
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

function parseVersionFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''), window.location.href);
    const v = url.searchParams.get('v');
    return v ? String(v) : '';
  } catch {
    return '';
  }
}

function findResourceVersion(regex) {
  try {
    const entries = performance.getEntriesByType?.('resource') || [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const name = entries[i]?.name;
      if (!name) continue;
      if (regex.test(String(name))) return parseVersionFromUrl(name);
    }
  } catch {
    // ignore
  }
  return '';
}

async function getServiceWorkerBuildInfo() {
  try {
    if (!('serviceWorker' in navigator)) return null;
    const postToTarget = async (target) => await new Promise((resolve) => {
      if (!target) return resolve(null);
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 500);
      channel.port1.onmessage = (e) => {
        clearTimeout(timer);
        resolve(e.data || null);
      };
      try {
        target.postMessage({ type: 'memus:get-sw-build' }, [channel.port2]);
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });

    // Most of the time we are controlled by the active SW.
    if (navigator.serviceWorker.controller) {
      return await postToTarget(navigator.serviceWorker.controller);
    }

    // Hard reload (Ctrl-F5) can result in an uncontrolled page; still try talking to the active SW.
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.active) return await postToTarget(reg.active);
    } catch {
      // ignore
    }

    return await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 300);
      channel.port1.onmessage = (e) => {
        clearTimeout(timer);
        resolve(e.data || null);
      };
      navigator.serviceWorker.controller?.postMessage?.({ type: 'memus:get-sw-build' }, [channel.port2]);
    });
  } catch {
    return null;
  }
}

async function refreshSidebarVersionLabel() {
  const el = document.getElementById('sidebarVersionLabel');
  if (!el) return;
  try {
    const apiV = findResourceVersion(/\/api\.js(\?|$)/);
    const swInfo = await getServiceWorkerBuildInfo();
    const buildId = swInfo?.buildId ? String(swInfo.buildId) : '';
    if (buildId) {
      try {
        window.__BUILD_ID__ = buildId;
      } catch {
        // ignore
      }
      el.textContent = `v${buildId}`;
      return;
    }

    // Fallback (e.g. first load before SW takes control)
    if (apiV) {
      el.textContent = `api v${apiV}`;
    }
  } catch {
    // ignore
  }
}

try {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      refreshSidebarVersionLabel().catch(() => {});
    });
  }
} catch {
  // ignore
}

function attachLazyGraphInit() {
  if (!refs.graphToggleBtn) return;
  let inFlight = null;

  const onClickCapture = async () => {
    if (inFlight) return;
    inFlight = import('../graph.js')
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
    inFlight = import('../users.js')
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

// Best-effort: show a server-derived revision marker in the sidebar.
runOnIdle(() => refreshSidebarVersionLabel(), { timeout: 1500, fallbackDelay: 50 });
setTimeout(() => refreshSidebarVersionLabel(), 3000);
try {
  navigator?.serviceWorker?.addEventListener?.('controllerchange', () => refreshSidebarVersionLabel());
} catch {
  // ignore
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
  initResumeRecoveryWatchdog();
  initWakeLockManager();
  initRouting();
  attachEvents();
  initSidebarStateFromStorage();
  attachLazyGraphInit();
  attachLazyUsersInit();
  runOnIdle(() => {
	    import('../tables.js')
      .then((m) => m.initTables?.())
      .catch(() => {});
  });
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
