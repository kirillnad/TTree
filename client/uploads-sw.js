const CACHE_NAME = 'memus-uploads-v1';
const APP_CACHE = 'memus-app-shell-v1';

const APP_SHELL_URLS = [
  '/',
  '/index.html',
  '/style.css?v=38',
  '/app.js?v=26',
  '/manifest.webmanifest',
  '/icons/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Avoid revalidating the same asset too often (saves bandwidth and removes "double requests" noise).
const REVALIDATE_TTL_MS = 5 * 60 * 1000;
const lastRevalidateAtByUrl = new Map();

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
    if (url.searchParams && url.searchParams.has('v')) return true;
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
      try {
        const cache = await caches.open(APP_CACHE);
        await cache.addAll(APP_SHELL_URLS);
      } catch {
        // ignore (e.g. offline first install)
      }
      await self.skipWaiting();
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
            if (k === CACHE_NAME) return Promise.resolve();
            if (k === APP_CACHE) return Promise.resolve();
            if (k.startsWith('memus-app-shell-')) return caches.delete(k);
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  // SPA navigation fallback: serve cached app shell when offline.
  if (isNavigationRequest(req) && isSameOrigin(req)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(APP_CACHE);
        try {
          const resp = await fetch(req);
          if (resp && resp.ok) {
            cache.put('/index.html', resp.clone()).catch(() => {});
          }
          return resp;
        } catch {
          const cached = (await cache.match('/index.html')) || (await cache.match('/'));
          if (cached) return cached;
          return new Response(offlineHtml(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
      })(),
    );
    return;
  }

  if (isUploadsRequest(req)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
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
        const cached = await cache.match(req, { ignoreSearch: false });
        if (cached) {
          // Versioned URLs (and most binaries) are immutable: no need to revalidate on every load.
          // For others, keep stale-while-revalidate but throttle to reduce duplicate traffic on F5.
          try {
            const url = new URL(req.url);
            if (!isImmutableAssetUrl(url) && shouldRevalidateNow(req.url)) {
              event.waitUntil(
                fetch(req)
                  .then((resp) => {
                    if (resp && resp.ok) cache.put(req, resp.clone());
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
          const resp = await fetch(req);
          if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
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
