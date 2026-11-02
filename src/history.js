// Print history: which orders were already printed, so they can be flagged when the
// same label turns up again. Kept in its own database so it survives "Clear everything",
// and so the service worker's database (src/store.js) never needs a schema upgrade.

const DB_NAME = 'label-cropper-history';

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      // { uid, orderId, platform, firstPrintedAt, lastPrintedAt, count }
      req.result.createObjectStore('printed', { keyPath: 'uid' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction('printed', mode);
        const result = fn(t.objectStore('printed'));
        t.oncomplete = () => resolve(result?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

// uid -> record
export async function loadHistory() {
  const all = await tx('readonly', (s) => s.getAll());
  return new Map(all.map((r) => [r.uid, r]));
}

// Adds the labels to `history` (the Map from loadHistory) and saves them.
// Only resolves once everything is written.
export async function recordPrinted(history, labels, now = Date.now()) {
  const updated = new Map();
  for (const l of labels) {
    if (!l.uid || updated.has(l.uid)) continue;
    const prev = history.get(l.uid);
    updated.set(l.uid, {
      uid: l.uid,
      orderId: l.orderId,
      platform: l.platform,
      firstPrintedAt: prev?.firstPrintedAt ?? now,
      lastPrintedAt: now,
      count: (prev?.count ?? 0) + 1,
    });
  }
  if (!updated.size) return 0;
  await tx('readwrite', (s) => {
    for (const r of updated.values()) s.put(r);
  });
  for (const [uid, r] of updated) history.set(uid, r);
  return updated.size;
}

export async function clearHistory(history) {
  await tx('readwrite', (s) => s.clear());
  history.clear();
}
