/* Service worker для PWA Memus без собственного кэширования контента.
 * Всё (HTML, JS, CSS) всегда берётся с сети, чтобы изменения
 * подхватывались при обычном обновлении страницы, в том числе в PWA.
 */

self.addEventListener('install', (event) => {
  // Сразу активируем новую версию service worker.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Прозрачный proxy: просто отдаём сетевой ответ без кэширования.
  event.respondWith(fetch(request));
});
