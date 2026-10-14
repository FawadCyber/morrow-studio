// Morrow Studio service worker: app shell offline, photos cached, jacket lists available offline (last seen copy).
const VERSION = 'lh-v22';
const SHELL = ['/', '/index.html', '/styles.css', '/manifest.webmanifest',
  '/js/app.js', '/js/core.js', '/js/charts.js', '/js/actions.js', '/js/jackets.js', '/js/product.js', '/js/review.js', '/js/hunts.js', '/js/home.js', '/js/compare.js', '/js/settings.js', '/js/session.js', '/js/palette.js', '/js/boards.js', '/js/insights.js'];
const ICONS = ['/icons/morrow.png', '/icons/icon-192.png', '/icons/favicon-32.png', '/icons/apple-touch-icon.png', '/favicon.ico'];
// Personal data is never kept on the device (another person may use this browser later)
const PRIVATE = /^\/api\/(me|users|notifications|activity|perms|session|backups|events)(\/|$)/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION + '-shell').then(async c => {
    await c.addAll(SHELL);
    await Promise.all(ICONS.map(u => c.add(u).catch(() => {}))); // a missing icon must not stop the app from installing
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await c.delete(k);
}
// Store a copy. The copy is taken right away: the original goes to the page and can only be read once.
function keep(cacheName, req, res, max) {
  if (!res.ok) return;
  const copy = res.clone();
  caches.open(cacheName).then(c => c.put(req, copy)).then(() => max && trim(cacheName, max)).catch(() => {});
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // live stream, downloads, share pages and personal data: never cached
  if (PRIVATE.test(url.pathname) || url.pathname.endsWith('.zip') || url.pathname.endsWith('.csv') || url.pathname.startsWith('/s/')) return;

  // photos + thumbnails: cache first (they never change)
  if (url.pathname.startsWith('/media/') || url.pathname.startsWith('/thumbs/')) {
    e.respondWith(caches.open(VERSION + '-img').then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      keep(VERSION + '-img', req, res, 600);
      return res;
    }));
    return;
  }
  // data: network first, last copy when offline
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).then(res => { keep(VERSION + '-api', req, res, 150); return res; })
      .catch(async () => (await caches.match(req)) || new Response(JSON.stringify({ error: "You're offline — showing nothing new until you reconnect", offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  // app shell: network first so updates show, cache when offline
  e.respondWith(fetch(req).then(res => { keep(VERSION + '-shell', req, res); return res; })
    .catch(async () => (await caches.match(req)) || caches.match('/index.html')));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === location.origin);
    if (open) { open.focus(); open.postMessage({ url: target }); return; }
    return self.clients.openWindow(target);
  }));
});
