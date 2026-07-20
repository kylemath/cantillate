// Offline audio store for Cantillate.
//
// The service worker (sw.js) deliberately never caches the recorded-chant MP3s:
// the Cache API can't store 206 (Partial Content) responses, and verse/word
// seeking relies on HTTP Range. This module solves that a different way — it
// downloads each *full* MP3 once (a normal 200), stores the bytes in IndexedDB,
// and hands playback a `blob:` object URL instead of the network path. Blob URLs
// support native seeking, so Range playback keeps working while the audio is
// served entirely from local storage (zero network on replay).
//
// The rest of a reading (text/pitch/shapes JSON, fonts) is already handled by the
// service worker's cache-first strategy; downloadReading() just warms that cache
// so a reading is fully usable offline after one explicit download.

const DB_NAME = 'cantillate-offline';
const DB_VERSION = 1;
const STORE = 'audio';

// path (e.g. "audio/devarim-1.mp3") -> blob: object URL, created lazily and kept
// for the lifetime of the page so playback can resolve it synchronously.
const objectUrls = new Map();

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE); // keyed by path string
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbTx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        Promise.resolve(fn(store))
          .then((r) => {
            result = r;
          })
          .catch(reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// True if IndexedDB is usable in this context (it isn't in some private modes).
export function offlineSupported() {
  return typeof indexedDB !== 'undefined';
}

async function idbGet(path) {
  try {
    return await idbTx('readonly', (store) => reqAsPromise(store.get(path)));
  } catch (e) {
    return undefined;
  }
}

async function idbPut(path, blob) {
  return idbTx('readwrite', (store) => reqAsPromise(store.put(blob, path)));
}

async function idbDelete(path) {
  return idbTx('readwrite', (store) => reqAsPromise(store.delete(path)));
}

async function idbHas(path) {
  try {
    const key = await idbTx('readonly', (store) => reqAsPromise(store.getKey(path)));
    return key !== undefined;
  } catch (e) {
    return false;
  }
}

// Synchronous resolver used by realaudio.js. Returns a previously-registered
// blob: URL for an audio path, or null so the caller falls back to the network.
export function getObjectUrl(path) {
  return objectUrls.get(path) || null;
}

function registerObjectUrl(path, blob) {
  if (objectUrls.has(path)) return objectUrls.get(path);
  const url = URL.createObjectURL(blob);
  objectUrls.set(path, url);
  return url;
}

// For each audio path already stored offline, create + register a blob: URL so
// playback resolves locally. Safe to call on every reading load; no network.
export async function primeReading(audioFiles) {
  if (!offlineSupported() || !Array.isArray(audioFiles)) return;
  for (const path of audioFiles) {
    if (objectUrls.has(path)) continue;
    const blob = await idbGet(path);
    if (blob) registerObjectUrl(path, blob);
  }
}

// Best-effort byte size of the not-yet-downloaded audio, via HEAD requests.
// Returns { bytes, known } — `known` is false when servers omit Content-Length.
export async function estimateReadingSize(audioFiles) {
  let bytes = 0;
  let known = true;
  await Promise.all(
    (audioFiles || []).map(async (path) => {
      try {
        const r = await fetch(path, { method: 'HEAD' });
        const len = r.headers.get('content-length');
        if (len) bytes += parseInt(len, 10);
        else known = false;
      } catch (e) {
        known = false;
      }
    })
  );
  return { bytes, known };
}

// Which of a reading's audio files are already stored offline.
export async function readingStatus(audioFiles) {
  const files = audioFiles || [];
  if (!offlineSupported() || !files.length) {
    return { total: files.length, cached: 0, complete: false };
  }
  let cached = 0;
  for (const path of files) {
    if (await idbHas(path)) cached += 1;
  }
  return { total: files.length, cached, complete: cached === files.length && files.length > 0 };
}

// Download a reading for full offline use:
//   1. warm the service-worker cache for its JSON (text/pitch/shapes/raw), and
//   2. fetch each full MP3 (no Range) and persist the bytes in IndexedDB.
// spec: { audioFiles: string[], dataFiles: string[] }
// onProgress({ phase, file, loaded, total, bytesLoaded }) is called as it runs.
export async function downloadReading(spec, onProgress) {
  const audioFiles = (spec && spec.audioFiles) || [];
  const dataFiles = (spec && spec.dataFiles) || [];
  const report = typeof onProgress === 'function' ? onProgress : () => {};

  const totalUnits = dataFiles.length + audioFiles.length;
  let done = 0;
  let bytesLoaded = 0;

  // Phase 1: warm the SW data cache. These are best-effort; a missing optional
  // file (e.g. a reading without a raw monolith) must not fail the download.
  for (const url of dataFiles) {
    report({ phase: 'data', file: url, loaded: done, total: totalUnits, bytesLoaded });
    try {
      await fetch(url, { cache: 'reload' });
    } catch (e) {
      /* optional; ignore */
    }
    done += 1;
  }

  // Phase 2: fetch + persist the audio blobs (the part that removes recurring
  // data usage). Skip anything already stored.
  for (const path of audioFiles) {
    report({ phase: 'audio', file: path, loaded: done, total: totalUnits, bytesLoaded });
    try {
      if (!(await idbHas(path))) {
        const resp = await fetch(path, { cache: 'reload' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        await idbPut(path, blob);
        bytesLoaded += blob.size;
        registerObjectUrl(path, blob);
      } else {
        // Already stored — make sure it's resolvable this session.
        const blob = await idbGet(path);
        if (blob) registerObjectUrl(path, blob);
      }
    } catch (e) {
      done += 1;
      report({ phase: 'audio', file: path, loaded: done, total: totalUnits, bytesLoaded, error: e });
      throw e;
    }
    done += 1;
  }

  report({ phase: 'done', loaded: totalUnits, total: totalUnits, bytesLoaded });
  return { bytesLoaded };
}

// Remove a reading's stored audio (frees space). Revokes any live object URLs.
export async function removeReading(audioFiles) {
  for (const path of audioFiles || []) {
    await idbDelete(path);
    const url = objectUrls.get(path);
    if (url) {
      URL.revokeObjectURL(url);
      objectUrls.delete(path);
    }
  }
}

// navigator.storage.estimate() wrapper for showing overall usage/quota.
export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      return await navigator.storage.estimate();
    }
  } catch (e) {
    /* not supported */
  }
  return null;
}

// Human-readable byte size for UI labels.
export function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
