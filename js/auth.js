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
let db = null;
let currentUser = null;
let synced = false;    // true once this session's cloud progress has merged in
let pushTimer = null;

export { isConfigured };
export function getUser() { return currentUser; }

// Wire up the sync layer. Safe to call even when unconfigured — it simply
// reports that sign-in is unavailable and does nothing else.
export async function initAuth({ onUserChange, onProgressMerged } = {}) {
  if (onUserChange) stateCb.onUserChange = onUserChange;
  if (onProgressMerged) stateCb.onProgressMerged = onProgressMerged;

  // Any local write schedules a debounced push (a no-op until signed in).
  store.onSave(() => schedulePush());

  if (!isConfigured()) {
    stateCb.onUserChange(null, { configured: false });
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
    auth = authMod.getAuth(app);
    db = fsMod.getFirestore(app);
    try { await authMod.setPersistence(auth, authMod.browserLocalPersistence); } catch (e) { /* default persistence */ }

    authMod.onAuthStateChanged(auth, (user) => { handleUser(user); });
    return { configured: true };
  } catch (e) {
    console.error('[auth] Firebase failed to load:', e);
    stateCb.onUserChange(null, { configured: true, error: 'load-failed' });
    return { configured: true, error: 'load-failed' };
  }
}

async function handleUser(user) {
  currentUser = user || null;
  synced = false;
  stateCb.onUserChange(currentUser, { configured: true });
  if (!currentUser) return;
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
  stateCb.onProgressMerged();
  // Persist the merged snapshot back up (so local-only progress is saved and
  // the leaderboard summary reflects it).
  pushNow();
}

export async function signIn() {
  if (!auth || !fb) throw new Error('Sign-in is not configured.');
  const provider = new fb.GoogleAuthProvider();
  await fb.signInWithPopup(auth, provider);
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

async function pushNow() {
  if (!currentUser || !db || !fb) return;
  clearTimeout(pushTimer);
  const data = store.getAll();
  const summary = computeSummary(data);
  try {
    await fb.setDoc(fb.doc(db, 'users', currentUser.uid), {
      data,
      updatedAt: fb.serverTimestamp(),
    });
    await fb.setDoc(fb.doc(db, 'leaderboard', currentUser.uid), {
      name: currentUser.displayName || 'Anonymous',
      photo: currentUser.photoURL || '',
      ...summary,
      updatedAt: fb.serverTimestamp(),
    });
  } catch (e) {
    console.warn('[auth] could not save progress:', e);
  }
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
    const pushed = loadPushedScopes(uid);
    const jobs = [];
    for (const entry of entries) {
      if (!entry || !entry.type || !entry.refId) continue;
      const score = Number(entry.score) || 0;
      const safeRef = sanitizeRefId(entry.refId);
      const cacheKey = `${entry.type}:${safeRef}`;
      const prev = Number(pushed[cacheKey]) || 0;
      if (score <= prev) continue;
      const ref = fb.doc(db, 'boards', entry.type, 'refs', safeRef, 'entries', uid);
      const payload = {
        uid,
        name: currentUser.displayName || 'Anonymous',
        photo: currentUser.photoURL || '',
        score: Math.round(score),
        cycle: entry.cycle || null,
        partial: !!entry.partial,
        label: entry.label || null,
        updatedAt: fb.serverTimestamp(),
      };
      jobs.push(
        fb.setDoc(ref, payload)
          .then(() => { pushed[cacheKey] = score; })
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
        score: v.score || 0,
        cycle: v.cycle || null,
        partial: !!v.partial,
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
        xp: v.xp || 0,
        versesMastered: v.versesMastered || 0,
        aliyotComplete: v.aliyotComplete || 0,
      });
    });
    return rows;
  } catch (e) {
    console.warn('[auth] could not load leaderboard:', e);
    return [];
  }
}
