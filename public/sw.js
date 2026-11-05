// Service worker: receives PDFs shared from other apps (WhatsApp etc.) through the
// Web Share Target in manifest.webmanifest, and caches the app for offline use.

const CACHE = 'label-cropper-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['./', './manifest.webmanifest']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;

  // Stale-while-revalidate: instant (and offline) loads, refreshed in the background.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
      const network = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

async function receiveShare(request) {
  const form = await request.formData();
  const shared = form.getAll('files').filter((f) => typeof f !== 'string');
  // PDFs and label images (the app turns images into a PDF when it loads them).
  const pdfs = shared.filter(
    (f) => ['application/pdf', 'image/png', 'image/jpeg'].includes(f.type) || /\.(pdf|png|jpe?g)$/i.test(f.name),
  );
  let added = 0;
  const db = await openDb();
  for (const file of pdfs) {
    const key = `${file.name}|${file.size}`; // same as fileKey() in src/store.js
    if (await idb(db.transaction('files').objectStore('files').get(key))) continue;
    await idb(
      db
        .transaction('files', 'readwrite')
        .objectStore('files')
        .put({ key, name: file.name, size: file.size, blob: file, addedAt: Date.now() + added }),
    );
    added++;
  }
  const back = new URL('./', self.registration.scope);
  back.searchParams.set('shared', String(added));
  back.searchParams.set('ignored', String(shared.length - added));
  return Response.redirect(back.href, 303);
}

// Keep in sync with src/store.js.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('label-cropper', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('labels')) d.createObjectStore('labels');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
