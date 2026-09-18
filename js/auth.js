// Optional Google sign-in + cloud-synced progress + leaderboard, layered on top
// of the existing localStorage store WITHOUT changing how the rest of the app
// reads/writes progress. Everything here degrades gracefully:
//   - If firebase-config.js still has placeholders, nothing loads and the app
//     stays 100% offline (localStorage only), exactly as before.
//   - If the user never signs in, progress stays local.
//   - When the user signs in, cloud progress is MERGED with local (best of
//     each) so nothing is lost, then kept in sync on every subsequent change.
//
// The Firebase JS SDK is imported dynamically from the CDN so there is still no
// build step and no bundler; the imports only run once sign-in is configured.

import * as store from './store.js';
import { firebaseConfig, FIREBASE_SDK_VERSION, isConfigured } from './firebase-config.js';

const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

const stateCb = { onUserChange: () => {}, onProgressMerged: () => {} };

let fb = null;         // resolved Firebase SDK fns (once loaded)
let auth = null;
let popupResolver = null; // browserPopupRedirectResolver from the Auth SDK
let db = null;
let currentUser = null;
let loadFailed = false; // the SDK never arrived (offline, blocked); see readyState
let synced = false;    // true once this session's cloud progress has merged in
let syncWaiters = [];  // resolve when the in-flight merge finishes (see whenSynced)
let pushTimer = null;
// Extra, corpus-wide summary fields (per-sefer practice aggregates + hours)
// computed in app.js where the readings metadata lives, then merged into the
// public leaderboard doc on the next push. See updateSummaryExtras.
let summaryExtras = null;

export { isConfigured };
export function getUser() { return currentUser; }

// Whether a sign-in can actually be attempted right now: the config is real AND
// the SDK has finished loading. "Configured but not ready yet" is the ordinary
// state for the first moment of a page load, and anything that puts a sign-in
// button on screen has to tell it apart from "sign-in will never work here".
export function isReady() { return !!(auth && fb); }

// Resolves once this session's cloud snapshot has been merged into local
// progress (or immediately if that has already happened, or there is no user).
// Sign-in callers that need the restored plan — the onboarding intro on a new
// device — have to wait for this; the popup finishing is not the same moment
// as the plan arriving.
export function whenSynced() {
  if (synced || !currentUser) return Promise.resolve();
  return new Promise((resolve) => { syncWaiters.push(resolve); });
}

function flushSyncWaiters() {
  const waiting = syncWaiters.splice(0);
  for (const fn of waiting) {
    try { fn(); } catch (e) { /* a waiter's failure is its own */ }
  }
}

// The popup can resolve before onAuthStateChanged has swapped in the Google
// user (an anonymous session is still currentUser until then). Wait until a
// lasting account is present, then until that account's snapshot has merged.
async function waitForSignedInSync() {
  if (!currentUser || currentUser.isAnonymous) {
    await new Promise((resolve) => {
      const unsub = watchUser(() => {
        if (currentUser && !currentUser.isAnonymous) { unsub(); resolve(); }
      });
      if (currentUser && !currentUser.isAnonymous) { unsub(); resolve(); }
    });
  }
  await whenSynced();
}

// The same answer with its reasons, for UI that has to choose between offering
// sign-in, waiting for it, and not mentioning it at all:
//   'unconfigured' — no Firebase project; this build is local-storage only
//   'loading'      — configured, SDK still arriving from the CDN
//   'ready'        — signing in will work
//   'failed'       — the SDK didn't load (offline, blocked); it won't work now
export function readyState() {
  if (!isConfigured()) return 'unconfigured';
  if (auth && fb) return 'ready';
  return loadFailed ? 'failed' : 'loading';
}

// Extra listeners for "the session or the sign-in machinery changed". initAuth's
// onUserChange is the one long-lived subscriber (the header box); this is for UI
// that comes and goes within a session — the onboarding wizard, which draws a
// sign-in screen and has to redraw it when the popup completes, or when the SDK
// finishes loading underneath it. Returns an unsubscribe function.
const watchers = new Set();
export function watchUser(fn) {
  if (typeof fn !== 'function') return () => {};
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function notifyWatchers() {
  for (const fn of Array.from(watchers)) {
    try { fn(currentUser); } catch (e) { /* a watcher's failure is its own */ }
  }
}

// True when the current session is a Firebase *anonymous* sign-in — i.e. the
// user submitted scores without a Google account. Everything they publish is
// tagged with this so the leaderboard can mark them as anonymous.
export function isAnon() { return !!(currentUser && currentUser.isAnonymous); }
function anonFlag() { return isAnon(); }

// The user's raw Google identity (before any anonymous override), or null when
// signed out. Used by the profile picker to offer "keep my Google name/photo".
export function getGoogleIdentity() {
  if (!currentUser) return null;
  return {
    name: currentUser.displayName || '',
    photo: currentUser.photoURL || '',
    email: currentUser.email || '',
  };
}

// Whether the signed-in user has already picked how they appear (so we only
// prompt for it once, on first login).
export function hasChosenProfile() {
  const p = store.getProfile();
  return !!(p && p.chosen);
}

// The name/photo the user should actually appear as: their chosen anonymous
// profile if set, otherwise their Google defaults. This is the single source of
// truth for everything we publish (leaderboard summary + per-scope entries).
export function publicIdentity() {
  const p = store.getProfile();
  if (p && p.chosen) {
    return { name: p.name || 'Anonymous', photo: p.photo || '' };
  }
  return {
    name: (currentUser && currentUser.displayName) || 'Anonymous',
    photo: (currentUser && currentUser.photoURL) || '',
  };
}

// Persist a chosen public identity and immediately re-publish it so the
// leaderboard summary reflects the new name/photo right away.
export async function saveProfile({ name, photo } = {}) {
  store.setProfile({ chosen: true, name: name || 'Anonymous', photo: photo || '' });
  await pushNow();
}

// Wire up the sync layer. Safe to call even when unconfigured — it simply
// reports that sign-in is unavailable and does nothing else.
export async function initAuth({ onUserChange, onProgressMerged } = {}) {
  if (onUserChange) stateCb.onUserChange = onUserChange;
  if (onProgressMerged) stateCb.onProgressMerged = onProgressMerged;

  // Any local write schedules a debounced push (a no-op until signed in).
  store.onSave(() => schedulePush());

  if (!isConfigured()) {
    stateCb.onUserChange(null, { configured: false });
    notifyWatchers();
    return { configured: false };
  }

  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(`${CDN}/firebase-app.js`),
      import(`${CDN}/firebase-auth.js`),
      import(`${CDN}/firebase-firestore.js`),
    ]);
    fb = { ...authMod, ...fsMod };
    const app = appMod.initializeApp(firebaseConfig);
    // initializeAuth() does NOT install a popup/redirect resolver the way
    // getAuth() does. signInWithPopup then throws auth/argument-error at
    // _withDefaultResolver unless we pass browserPopupRedirectResolver here
    // (or as the third argument to the popup call). Keep the resolver from
    // the Auth module itself — not the merged `fb` object — so a Firestore
    // export can never overwrite it. Every sign-in button (onboarding intro,
    // onboarding account step, guided menu, workshop header) calls signIn().
    popupResolver = authMod.browserPopupRedirectResolver;
    try {
      auth = authMod.initializeAuth(app, {
        persistence: authMod.browserLocalPersistence,
        popupRedirectResolver: popupResolver,
      });
    } catch (e) {
      try {
        auth = authMod.initializeAuth(app, {
          persistence: authMod.inMemoryPersistence,
          popupRedirectResolver: popupResolver,
        });
      } catch (e2) {
        auth = authMod.getAuth(app);
      }
    }
    db = fsMod.getFirestore(app);

    authMod.onAuthStateChanged(auth, (user) => { handleUser(user); });
    // Completes a signInWithRedirect that started on a previous page load
    // (popup-blocked fallback). onAuthStateChanged still fires; this just
    // consumes the pending redirect so it isn't retried.
    if (authMod.getRedirectResult) {
      try { await authMod.getRedirectResult(auth); } catch (e) {
        console.warn('[auth] redirect sign-in did not complete:', e);
      }
    }
    notifyWatchers();
    return { configured: true };
  } catch (e) {
    console.error('[auth] Firebase failed to load:', e);
    loadFailed = true;
    stateCb.onUserChange(null, { configured: true, error: 'load-failed' });
    notifyWatchers();
    return { configured: true, error: 'load-failed' };
  }
}

async function handleUser(user) {
  currentUser = user || null;
  synced = false;
  stateCb.onUserChange(currentUser, { configured: true });
  notifyWatchers();
  if (!currentUser) {
    flushSyncWaiters();
    return;
  }
  // Pull this account's saved progress and merge it with whatever is local
  // (including anything earned while logged out), keeping the best of each.
  try {
    const snap = await fb.getDoc(fb.doc(db, 'users', currentUser.uid));
    const remote = snap.exists() ? (snap.data().data || {}) : {};
    store.mergeRemote(remote);
  } catch (e) {
    console.warn('[auth] could not load cloud progress:', e);
  }
  synced = true;
  flushSyncWaiters();
  stateCb.onProgressMerged();
  // Persist the merged snapshot back up (so local-only progress is saved and
  // the leaderboard summary reflects it).
  pushNow();
}

// Firebase authorizes the name `localhost` by default, not the loopback IP.
// Opening the app at http://127.0.0.1:... makes Google sign-in fail with an
// unauthorized-domain iframe warning, then auth/popup-blocked. Callers can
// send the reader to this URL instead of fighting the popup.
export function loopbackSignInUrl() {
  if (typeof location === 'undefined') return null;
  const host = location.hostname;
  if (host !== '127.0.0.1' && host !== '[::1]') return null;
  try {
    const u = new URL(location.href);
    u.hostname = 'localhost';
    return u.href;
  } catch (e) {
    return null;
  }
}

function popupBlocked(e) {
  return !!(e && (e.code === 'auth/popup-blocked'
    || e.code === 'auth/operation-not-supported-in-this-environment'));
}

export async function signIn() {
  if (!auth || !fb) throw new Error('Sign-in is not configured.');
  const provider = new fb.GoogleAuthProvider();
  const resolver = popupResolver || fb.browserPopupRedirectResolver;
  // Must open the popup in this turn of the click handler. Any await before
  // window.open (or tearing down the button that was clicked) is what the
  // browser reports as auth/popup-blocked.
  try {
    if (currentUser && currentUser.isAnonymous && fb.linkWithPopup) {
      try {
        await fb.linkWithPopup(currentUser, provider, resolver);
        await waitForSignedInSync();
        return;
      } catch (e) {
        // A blocked or dismissed popup is done — a second popup would also be
        // blocked because the user gesture is spent. Other link failures (the
        // Google account already exists) fall through to a fresh sign-in.
        if (popupBlocked(e) || (e && e.code === 'auth/popup-closed-by-user')) throw e;
        console.warn('[auth] could not link anonymous account, signing in fresh:', e);
      }
    }
    await fb.signInWithPopup(auth, provider, resolver);
    await waitForSignedInSync();
  } catch (e) {
    if (popupBlocked(e) && fb.signInWithRedirect && !loopbackSignInUrl()) {
      await fb.signInWithRedirect(auth, provider, resolver);
      return;
    }
    throw e;
  }
}

// Sign in anonymously (no Google account) so a logged-out user can still post
// scores to the shared leaderboard. Requires the Anonymous provider to be
// enabled in the Firebase console; see the README.
export async function signInAnon() {
  if (!auth || !fb || !fb.signInAnonymously) throw new Error('Anonymous sign-in is not configured.');
  await fb.signInAnonymously(auth);
}

export async function signOutUser() {
  if (!auth || !fb) return;
  await fb.signOut(auth);
}

function schedulePush() {
  if (!currentUser || !synced || !db) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1500);
}

// Firestore rejects `undefined` anywhere in a document. The in-memory progress
// object can carry keys like `passages: undefined` after a merge (JSON.stringify
// drops those for localStorage, but getAll() returns the live object). Round-
// tripping through JSON matches what we already persist locally and is safe for
// the progress shape (plain data, no Dates / functions).
function forFirestore(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

async function pushNow() {
  if (!currentUser || !db || !fb) return;
  clearTimeout(pushTimer);
  const data = forFirestore(store.getAll());
  const summary = computeSummary(data);
  const id = publicIdentity();
  try {
    await fb.setDoc(fb.doc(db, 'users', currentUser.uid), {
      data,
      updatedAt: fb.serverTimestamp(),
    });
    await fb.setDoc(fb.doc(db, 'leaderboard', currentUser.uid), {
      ...forFirestore({
        ...(summaryExtras || {}),
        name: id.name,
        photo: id.photo,
        anon: anonFlag(),
        ...summary,
      }),
      updatedAt: fb.serverTimestamp(),
    });
  } catch (e) {
    console.warn('[auth] could not save progress:', e);
  }
}

// Stash corpus-wide summary aggregates (per-sefer practice counts + hours) to be
// published with the next leaderboard-doc push. Computed by app.js (which owns
// the readings metadata) and merged into the public doc so the Sefer/Overall
// boards can rank users. A no-op offline / signed out.
export function updateSummaryExtras(extras) {
  summaryExtras = extras || null;
  schedulePush();
}

// Derive public leaderboard metrics from the raw progress object. "XP" is the
// sum of every best whole-verse and aliyah accuracy; mastery/completion counts
// give secondary tie-break context.
export function computeSummary(data = {}) {
  const modes = data.modes || {};
  const aliyot = data.aliyot || {};
  const levels = data.levels || {};
  let xp = 0;
  for (const k of Object.keys(modes)) xp += Number(modes[k]) || 0;
  for (const k of Object.keys(aliyot)) xp += Number(aliyot[k]) || 0;
  const versesMastered = Object.values(levels).filter((l) => (Number(l) || 0) >= 4).length;
  const aliyotComplete = Object.values(aliyot).filter((s) => (Number(s) || 0) >= 80).length;
  return { xp: Math.round(xp), versesMastered, aliyotComplete };
}

// ---------------------------------------------------------------------------
// Hierarchical per-scope leaderboards (client-only, best-only writes).
//
// Path (Firestore requires alternating collection/doc segments):
//   boards/{type}/refs/{refId}/entries/{uid}
// where {type} is 'pasuk' | 'aliyah' | 'parasha' and {refId} is a canonical id.
// Writes are gated by a monotonic localStorage cache so we only touch Firestore
// when a score actually improves on what we last pushed.
// ---------------------------------------------------------------------------

function sanitizeRefId(refId) {
  return String(refId).replace(/\//g, '_');
}

function pushedScopesKey(uid) {
  return 'cantillate.pushedScopes.' + uid;
}

function loadPushedScopes(uid) {
  try {
    const raw = localStorage.getItem(pushedScopesKey(uid));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function savePushedScopes(uid, map) {
  try {
    localStorage.setItem(pushedScopesKey(uid), JSON.stringify(map));
  } catch (e) { /* ignore quota/serialization errors */ }
}

// Push an array of per-scope scores. Each entry:
//   { type, refId, score, cycle?, partial?, label? }
// Only entries that strictly beat their last-pushed value are written, and the
// local cache is updated after each successful write so repeated calls are cheap.
export async function pushScopeScores(entries) {
  if (!currentUser || !db || !fb) return;
  if (!Array.isArray(entries) || entries.length === 0) return;
  try {
    const uid = currentUser.uid;
    const id = publicIdentity();
    const pushed = loadPushedScopes(uid);
    const jobs = [];
    for (const entry of entries) {
      if (!entry || !entry.type || !entry.refId) continue;
      const score = Number(entry.score) || 0;
      const safeRef = sanitizeRefId(entry.refId);
      const cacheKey = `${entry.type}:${safeRef}`;
      const prev = Number(pushed[cacheKey]) || 0;
      const runs = Array.isArray(entry.runs) ? entry.runs.map((x) => Math.round(Number(x) || 0)).slice(-50) : [];
      const prevN = Number(pushed[cacheKey + '#n']) || 0;
      // Write when the best improves OR a new attempt lengthens the run history
      // (so the score-over-runs colourbar stays current even on non-PB takes).
      if (score <= prev && runs.length <= prevN) continue;
      const ref = fb.doc(db, 'boards', entry.type, 'refs', safeRef, 'entries', uid);
      const payload = {
        uid,
        name: id.name,
        photo: id.photo,
        anon: anonFlag(),
        score: Math.round(score),
        cycle: entry.cycle || null,
        partial: !!entry.partial,
        incomplete: !!entry.incomplete,
        solo: !!entry.solo,
        runs,
        label: entry.label || null,
        updatedAt: fb.serverTimestamp(),
      };
      jobs.push(
        fb.setDoc(ref, payload)
          .then(() => { pushed[cacheKey] = Math.max(score, prev); pushed[cacheKey + '#n'] = runs.length; })
          .catch((e) => { console.warn('[auth] could not push scope score:', cacheKey, e); }),
      );
    }
    if (jobs.length === 0) return;
    await Promise.allSettled(jobs);
    savePushedScopes(uid, pushed);
  } catch (e) {
    console.warn('[auth] could not push scope scores:', e);
  }
}

// Top N entries for a single scope, ordered by score. Returns [] on any error.
export async function getBoard(type, refId, n = 25) {
  if (!db || !fb) return [];
  try {
    const safeRef = sanitizeRefId(refId);
    const q = fb.query(
      fb.collection(db, 'boards', type, 'refs', safeRef, 'entries'),
      fb.orderBy('score', 'desc'),
      fb.limit(n),
    );
    const snap = await fb.getDocs(q);
    const rows = [];
    snap.forEach((d) => {
      const v = d.data();
      rows.push({
        uid: d.id,
        name: v.name || 'Anonymous',
        photo: v.photo || '',
        anon: !!v.anon,
        score: v.score || 0,
        cycle: v.cycle || null,
        partial: !!v.partial,
        incomplete: !!v.incomplete,
        solo: !!v.solo,
        runs: Array.isArray(v.runs) ? v.runs : [],
      });
    });
    return rows;
  } catch (e) {
    console.warn('[auth] could not load board:', e);
    return [];
  }
}

// Top N leaderboard rows by XP. Returns [] if unconfigured or on any error.
export async function getLeaderboard(n = 25) {
  if (!db || !fb) return [];
  try {
    const q = fb.query(
      fb.collection(db, 'leaderboard'),
      fb.orderBy('xp', 'desc'),
      fb.limit(n),
    );
    const snap = await fb.getDocs(q);
    const rows = [];
    snap.forEach((d) => {
      const v = d.data();
      rows.push({
        uid: d.id,
        name: v.name || 'Anonymous',
        photo: v.photo || '',
        anon: !!v.anon,
        xp: v.xp || 0,
        versesMastered: v.versesMastered || 0,
        aliyotComplete: v.aliyotComplete || 0,
        hours: Number(v.hours) || 0,
        pesukim: Number(v.pesukim) || 0,
        aliyot: Number(v.aliyot) || 0,
        parashot: Number(v.parashot) || 0,
        sefarim: Number(v.sefarim) || 0,
        perSefer: (v.perSefer && typeof v.perSefer === 'object') ? v.perSefer : {},
      });
    });
    return rows;
  } catch (e) {
    console.warn('[auth] could not load leaderboard:', e);
    return [];
  }
}
