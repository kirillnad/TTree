const CACHE_NAME = 'memus-uploads-v1';

function isUploadsRequest(request) {
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin && url.pathname.startsWith('/uploads/');
  } catch {
    return false;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!isUploadsRequest(req)) return;

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
});

