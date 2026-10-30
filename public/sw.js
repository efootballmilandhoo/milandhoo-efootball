/* MG Efootball service worker.
   - App shell (page, styles, script, icons) is precached per version, so the app opens instantly and offline.
   - Libraries and fonts from CDNs, and pictures from Supabase Storage, are cached after first use.
   - Live data (Supabase API and realtime) always goes to the network.
   - Push notifications. */
const VERSION = '0b8d7a1a49';
const PRECACHE = ["/", "/assets/app.7872dc9ff7.css", "/assets/app.ad8f36f090.js", "/icons/icon-192.png?v=2", "/icons/icon-512.png?v=2", "/icons/badge-96.png?v=2", "/icons/apple-touch-icon.png?v=2", "/icons/favicon-32.png?v=2"];
const SHELL = 'shell-' + VERSION;
const RUNTIME = 'runtime-v1';
const IMAGES = 'images-v1';
const MEDIA = 'https://pdgkxbkxpzinlbyedvco.supabase.co/storage/v1/object/public/';
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => c.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [SHELL, RUNTIME, IMAGES];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function cacheFirst(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(name, req, event) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const update = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  if (hit) { event.waitUntil(update); return hit; }
  return (await update) || Response.error();
}

let trimTimer = null;
async function trimImages() {
  const cache = await caches.open(IMAGES);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - 400; i++) await cache.delete(keys[i]);
}

// Pictures are fetched in CORS mode, so they can also be drawn into exported images.
async function media(req, event) {
  const cache = await caches.open(IMAGES);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    const res = await fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' }));
    if (res.ok) {
      event.waitUntil(cache.put(req.url, res.clone()));
      clearTimeout(trimTimer); trimTimer = setTimeout(trimImages, 5000);
    }
    return res;
  } catch (err) {
    return fetch(req);
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate' && url.origin === location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match('/');
      if (hit) return hit;
      try { return await fetch(req); }
      catch (err) { return new Response('<!doctype html><meta name="viewport" content="width=device-width"><p style="font-family:sans-serif;padding:24px">You are offline. Connect to the internet and try again.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
    })());
    return;
  }

  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
      e.respondWith(cacheFirst(SHELL, req));
    }
    return;
  }
  if (req.url.startsWith(MEDIA)) { e.respondWith(media(req, e)); return; }
  if (CDN_HOSTS.includes(url.hostname)) { e.respondWith(cacheFirst(RUNTIME, req)); return; }
  if (url.hostname === 'fonts.googleapis.com') { e.respondWith(staleWhileRevalidate(RUNTIME, req, e)); return; }
});

// The page asks which version this worker serves, to decide whether to offer a reload.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'version' && e.source) e.source.postMessage({ type: 'version', assets: PRECACHE });
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'MG Efootball', body: e.data && e.data.text() }; }
  const title = d.title || 'MG Efootball';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/icons/icon-192.png?v=2',
    badge: '/icons/badge-96.png?v=2',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === location.origin) {
        await w.focus();
        w.postMessage({ type: 'open', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('pushsubscriptionchange', e => {
  // The browser rotated the subscription; the page registers the new one the next time it opens.
  e.waitUntil(Promise.resolve());
});
