/*
 * Service worker for the Cantillate static web app.
 *
 * Works both on GitHub Pages (scope /cantillate/) and local dev (scope /),
 * because every path is resolved relative to the service worker's own location
 * rather than being hard-coded. No build step, no dependencies — plain SW APIs.
 *
 * Caching strategy summary:
 *   - App shell (html/css/js modules): network-first, fall back to cache.
 *   - data/ JSON + data/pitch/ shards + fonts/: cache-first (stale-while-revalidate).
 *   - readings.json manifest: network-first (changes when readings are added).
 *   - audio/*.mp3: network passthrough, never cached (Range/206 safe, avoids quota blowups).
 *   - Anything cross-origin or non-GET: bypassed entirely.
 */

// Bump VERSION to invalidate all previously cached content on next activate.
const VERSION = 'v-8a4accbd2433';
const SHELL_CACHE = 'cantillate-shell-' + VERSION;
const DATA_CACHE = 'cantillate-data-' + VERSION;

// The set of caches this SW version considers "current"; all others are purged.
const CURRENT_CACHES = [SHELL_CACHE, DATA_CACHE];

/*
 * Base URL derived from the SW's own location. On GH Pages this SW lives at
 * https://kylemath.github.io/cantillate/sw.js, so the base becomes
 * https://kylemath.github.io/cantillate/ . On local dev served from root it
 * becomes http://localhost:PORT/ . All shell paths are resolved against this.
 */
const SCOPE_BASE = new URL('./', self.location).href;

// App shell files to precache, expressed as URLs relative to SCOPE_BASE.
const SHELL_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/hebrew.js',
  './js/trope.js',
  './js/audio.js',
  './js/realaudio.js',
  './js/pitch.js',
  './js/viz.js',
  './js/levels.js',
  './js/aliyot.js',
  './js/store.js',
  './js/auth.js',
  './js/firebase-config.js',
  './js/scores.js',
].map(function (path) {
  return new URL(path, SCOPE_BASE).href;
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

self.addEventListener('install', function (event) {
  // Activate this SW as soon as it finishes installing.
  self.skipWaiting();

  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // Precache each shell asset individually so a single 404 (e.g. a JS
      // module that doesn't exist yet) does not abort the whole install.
      return Promise.allSettled(
        SHELL_ASSETS.map(function (url) {
          // cache: 'reload' bypasses the HTTP cache so we always precache fresh.
          return fetch(new Request(url, { cache: 'reload' })).then(function (response) {
            if (response && response.ok) {
              return cache.put(url, response);
            }
            // Non-OK responses are skipped rather than cached.
            return undefined;
          });
        })
      );
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (cacheNames) {
        // Delete every cache that isn't part of this SW version.
        return Promise.all(
          cacheNames.map(function (name) {
            if (CURRENT_CACHES.indexOf(name) === -1) {
              return caches.delete(name);
            }
            return undefined;
          })
        );
      })
      .then(function () {
        // Take control of already-open clients without requiring a reload.
        return self.clients.claim();
      })
  );
});

/* -------------------------------------------------------------------------- */
/* Fetch handling                                                             */
/* -------------------------------------------------------------------------- */

self.addEventListener('fetch', function (event) {
  const request = event.request;

  // Only ever handle same-origin GET requests. Everything else — POST/PUT,
  // Firestore/googleapis/gstatic/sefaria and any other cross-origin call —
  // is left to the network untouched.
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  const path = url.pathname;

  // --- Audio: never cache. -------------------------------------------------
  // The Cache API cannot store 206 (Partial Content) responses, and audio is
  // large. If the browser asks for a byte Range, or a 206 comes back, we must
  // pass through untouched so range/seek playback is never broken. We skip
  // caching audio entirely to avoid storage-quota blowups.
  if (isAudio(path) || request.headers.has('range')) {
    return; // default browser fetch, no caching
  }

  // --- readings.json manifest: network-first. ------------------------------
  // It changes whenever readings are added, so prefer fresh over cached.
  if (isReadingsManifest(path)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // --- Navigations + shell files: network-first, fall back to cache. --------
  // This lets fresh deploys show up while keeping the app usable offline.
  if (request.mode === 'navigate' || isShellAsset(url.href)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // --- data/ JSON + data/pitch/ shards + fonts/: cache-first (SWR). ---------
  if (isCacheableData(path)) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  // Anything else same-origin: try network, fall back to any cached copy.
  event.respondWith(networkFirst(request, DATA_CACHE));
});

/* -------------------------------------------------------------------------- */
/* Matchers                                                                   */
/* -------------------------------------------------------------------------- */

function isAudio(path) {
  return /\/audio\/.+\.mp3$/i.test(path) || /\.mp3$/i.test(path);
}

function isReadingsManifest(path) {
  return /\/readings\.json$/i.test(path);
}

function isShellAsset(href) {
  return SHELL_ASSETS.indexOf(href) !== -1;
}

function isCacheableData(path) {
  // data/*.json (incl. large *_pitch*.json), data/pitch/<slug>/*.json shards,
  // and any font files under fonts/.
  if (/\/data\/.+\.json$/i.test(path)) {
    return true;
  }
  if (/\/fonts\//i.test(path)) {
    return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Strategies                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Network-first: try the network, cache successful full responses, and fall
 * back to the cache when offline / on failure.
 */
function networkFirst(request, cacheName) {
  return fetch(request)
    .then(function (response) {
      if (isCacheableResponse(response)) {
        const copy = response.clone();
        caches.open(cacheName).then(function (cache) {
          cache.put(request, copy);
        });
      }
      return response;
    })
    .catch(function () {
      return caches.match(request).then(function (cached) {
        // As a last resort for navigations, serve the cached app shell.
        if (cached) {
          return cached;
        }
        if (request.mode === 'navigate') {
          return caches.match(new URL('./index.html', SCOPE_BASE).href);
        }
        // Nothing cached and offline: produce a clear error response.
        return Response.error();
      });
    });
}

/**
 * Cache-first with background revalidation (stale-while-revalidate): return the
 * cached copy immediately if present, and refresh the cache in the background.
 * On a miss, fetch from network, cache a clone, and return it.
 */
function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (cached) {
      const networkFetch = fetch(request)
        .then(function (response) {
          if (isCacheableResponse(response)) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(function () {
          // Swallow network errors; the cached copy (if any) is the fallback.
          return undefined;
        });

      // Cache hit: return it now, revalidate in the background.
      if (cached) {
        return cached;
      }
      // Cache miss: wait for the network.
      return networkFetch.then(function (response) {
        return response || Response.error();
      });
    });
  });
}

/**
 * A response is safe to cache only if it is a basic (same-origin) response with
 * status 200. This excludes opaque cross-origin responses and any error status.
 */
function isCacheableResponse(response) {
  return !!response && response.status === 200 && response.type === 'basic';
}
