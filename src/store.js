// IndexedDB persistence, so labels survive reloads and WhatsApp shares (which open
// the app fresh). The service worker (public/sw.js) writes shared files into the
// same "files" store — keep the schema in sync with it.

const DB_NAME = 'label-cropper';
const DB_VERSION = 1;

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      // { key, name, size, blob, addedAt }
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'key' });
      // labelKey -> { skip, crop? } — the user's changes to a detected label
      if (!d.objectStoreNames.contains('labels')) d.createObjectStore('labels');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
  });
}

// Same name + size counts as the same file, so sharing it twice doesn't duplicate labels.
export const fileKey = (name, size) => `${name}|${size}`;
export const labelKey = (fileId, pageIndex, index) => `${fileId}#${pageIndex}#${index}`;

export async function listFiles() {
  const all = await run('files', 'readonly', (s) => s.getAll());
  return all.sort((a, b) => a.addedAt - b.addedAt);
}

export function saveFile(record) {
  return run('files', 'readwrite', (s) => s.put(record));
}

export function deleteFile(key) {
  return run('files', 'readwrite', (s) => s.delete(key));
}

export async function listOverrides() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const map = new Map();
    const req = d.transaction('labels').objectStore('labels').openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(map);
      map.set(cursor.key, cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export function saveOverride(key, value) {
  return run('labels', 'readwrite', (s) => s.put(value, key));
}

export async function clearAll() {
  await run('files', 'readwrite', (s) => s.clear());
  await run('labels', 'readwrite', (s) => s.clear());
}
