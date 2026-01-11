// Two caches on purpose:
// - UPLOADS_CACHE: user files (/uploads/...) for offline media; should rarely change.
// - APP_CACHE: app shell (HTML/CSS/JS/icons) for offline startup; bump APP_VERSION to force client refresh.
const UPLOADS_CACHE = 'u1';
const APP_VERSION = 322;
const APP_BUILD = '9n67mtrv';
const APP_CACHE = `a${APP_VERSION}`;
  
const APP_SHELL_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/boot.js',
  '/app.js',
  // Keep TipTap bundle cached for offline outline editing (it is still loaded on-demand).
  '/outline/tiptap.bundle.js',
  '/manifest.webmanifest',
  '/fonts/SegoeIcons.ttf',
  '/icons/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Avoid revalidating the same asset too often (saves bandwidth and removes "double requests" noise).
const REVALIDATE_TTL_MS = 5 * 60 * 1000;
const lastRevalidateAtByUrl = new Map();
// When the network is very slow, "network-first" navigation can stall the whole app startup
// even though the app shell is already cached. Prefer a quick cache fallback.
const NAV_NETWORK_TIMEOUT_MS = 1200;

function isUploadsRequest(request) {
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin && url.pathname.startsWith('/uploads/');
  } catch {
    return false;
  }
}

function isApiRequest(request) {
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin && url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function isSameOrigin(request) {
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin;
  } catch {
    return false;
  }
}

function isNavigationRequest(request) {
  return request && request.mode === 'navigate';
}

function isImmutableAssetUrl(url) {
  try {
    if (!url || url.origin !== self.location.origin) return false;
    const p = url.pathname || '';
    return (
      p.endsWith('.ttf') ||
      p.endsWith('.woff') ||
      p.endsWith('.woff2') ||
      p.endsWith('.png') ||
      p.endsWith('.jpg') ||
      p.endsWith('.jpeg') ||
      p.endsWith('.gif') ||
      p.endsWith('.webp') ||
      p.endsWith('.ico') ||
      p.endsWith('.webmanifest') ||
      p.endsWith('.wasm') ||
      p.endsWith('.data')
    );
  } catch {
    return false;
  }
}

function isJsOrCssUrl(url) {
  try {
    if (!url || url.origin !== self.location.origin) return false;
    const p = url.pathname || '';
    return p.endsWith('.js') || p.endsWith('.css');
  } catch {
    return false;
  }
}

function canonicalizeSameOriginAssetRequest(req) {
  try {
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return req;
    // Strip search params so old `?v=` imports still work with app-shell caching.
    return new Request(url.origin + url.pathname, { method: 'GET' });
  } catch {
    return req;
  }
}

function makeReloadRequest(req) {
  try {
    return new Request(req, { cache: 'reload' });
  } catch {
    return req;
  }
}

function shouldRevalidateNow(urlStr) {
  const now = Date.now();
  const last = lastRevalidateAtByUrl.get(urlStr) || 0;
  if (now - last < REVALIDATE_TTL_MS) return false;
  lastRevalidateAtByUrl.set(urlStr, now);
  return true;
}

function offlineHtml() {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111827" />
    <title>Memus — оффлайн</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; color: #111827; }
      .card { max-width: 520px; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
      h1 { margin: 0 0 8px; font-size: 18px; }
      p { margin: 8px 0; line-height: 1.4; color: #334155; }
      code { background: #f1f5f9; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Нет сети</h1>
      <p>Оффлайн-режим доступен после того, как приложение хотя бы один раз открылось с интернетом и закешировало файлы.</p>
      <p>Если вы только что установили PWA — откройте его онлайн, дождитесь загрузки, затем можно использовать без сети.</p>
    </div>
  </body>
</html>`;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      let precached = false;
      try {
        const cache = await caches.open(APP_CACHE);
        await cache.addAll(APP_SHELL_URLS);
        precached = true;
      } catch {
        // ignore (e.g. offline first install)
      }
      // Never activate a new SW if we failed to precache app-shell (would break offline for existing users).
      if (precached) {
        await self.skipWaiting();
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys.map((k) => {
            if (k === APP_CACHE) return Promise.resolve();
            if (k === UPLOADS_CACHE) return Promise.resolve();
            if (/^a\\d+$/.test(String(k))) return caches.delete(k);
            if (k.startsWith('memus-app-shell-')) return caches.delete(k);
            if (k.startsWith('memus-uploads-')) return caches.delete(k);
            return Promise.resolve();
          }),
        );
      } catch {
        // ignore
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  try {
    const data = event.data || {};
    if (data.type === 'memus:skipWaiting') {
      try {
        self.skipWaiting();
      } catch {
        // ignore
      }
      return;
    }
    if (data.type !== 'memus:get-sw-build') return;
    const port = event.ports && event.ports[0];
    if (!port) return;
    port.postMessage({
      buildId: String(APP_VERSION),
      buildHash: String(APP_BUILD),
    });
  } catch {
    // ignore
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  // SPA navigation fallback: serve cached app shell when offline.
  if (isNavigationRequest(req) && isSameOrigin(req)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(APP_CACHE);
        const cached = (await cache.match('/index.html')) || (await cache.match('/'));

        // Kick off a network fetch to refresh cache, but don't block startup on slow networks.
        const fetchPromise = fetch(req)
          .then((resp) => {
            try {
              if (resp && resp.ok) cache.put('/index.html', resp.clone()).catch(() => {});
            } catch {
              // ignore
            }
            return resp;
          })
          .catch(() => null);

        // If network doesn't respond quickly, serve cached shell immediately.
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), NAV_NETWORK_TIMEOUT_MS));
        const fast = await Promise.race([fetchPromise, timeoutPromise]);
        if (fast) return fast;
        if (cached) {
          event.waitUntil(fetchPromise.catch(() => {}));
          return cached;
        }
        // No cache yet (e.g. first visit while offline/slow) — wait for network if possible.
        const resp = await fetchPromise;
        if (resp) return resp;
        return new Response(offlineHtml(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      })(),
    );
    return;
  }

  if (isUploadsRequest(req)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(UPLOADS_CACHE);
        const cached = await cache.match(req, { ignoreSearch: false });
        if (cached) {
          // stale-while-revalidate
          event.waitUntil(
            fetch(req)
              .then((resp) => {
                if (resp && resp.ok) cache.put(req, resp.clone());
              })
              .catch(() => {}),
          );
          return cached;
        }
        try {
          const resp = await fetch(req);
          if (resp && resp.ok) {
            cache.put(req, resp.clone()).catch(() => {});
          }
          return resp;
        } catch {
          return new Response('', { status: 504, statusText: 'Offline' });
        }
      })(),
    );
    return;
  }

  // Cache-first for same-origin static assets (JS/CSS/icons/etc) so the PWA can start offline.
  if (isSameOrigin(req) && !isApiRequest(req)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(APP_CACHE);
        const keyReq = canonicalizeSameOriginAssetRequest(req);
        const cached = await cache.match(keyReq, { ignoreSearch: true });
	        if (cached) {
	          // IMPORTANT: keep app code consistent.
	          // For JS/CSS we always serve from the currently active APP_CACHE (cache-first),
	          // so we never mix different app versions (some from cache, some from network).
	          // Updates are applied by bumping APP_VERSION, which creates a new APP_CACHE on the next SW update.
	          try {
	            const url = new URL(req.url);
	            if (isJsOrCssUrl(url)) return cached;
	            // For other assets: stale-while-revalidate but throttle.
	            if (!isImmutableAssetUrl(url) && shouldRevalidateNow(req.url)) {
	              event.waitUntil(
	                fetch(makeReloadRequest(req))
	                  .then((resp) => {
	                    if (resp && resp.ok) cache.put(keyReq, resp.clone());
	                  })
	                  .catch(() => {}),
	              );
	            }
	          } catch {
	            // ignore
	          }
	          return cached;
	        }
        try {
          const url = new URL(req.url);
          const resp = await fetch(isJsOrCssUrl(url) ? makeReloadRequest(req) : req);
          if (resp && resp.ok) cache.put(keyReq, resp.clone()).catch(() => {});
          return resp;
        } catch (err) {
          // If it's an HTML request (rare, aside from navigation), fall back to app shell.
          const accept = req.headers.get('accept') || '';
          if (accept.includes('text/html')) {
            const shell = (await cache.match('/index.html')) || (await cache.match('/'));
            if (shell) return shell;
            return new Response(offlineHtml(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
          }
          // For non-HTML assets we can't synthesize a meaningful response. Return a controlled offline response
          // instead of throwing (which shows "FetchEvent resulted in a network error" in console).
          return new Response('', { status: 504, statusText: 'Offline' });
        }
      })(),
    );
  }

});
