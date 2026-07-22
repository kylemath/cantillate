// Lightweight persistence of practice scores and progress in localStorage.
const KEY = 'cantillate.v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch (e) { return {}; }
}

// Listeners notified after every write, so an optional cloud-sync layer can
// mirror progress without any of the record*/get* helpers below having to know
// it exists. Purely additive: with no listeners registered this is a no-op.
const saveListeners = [];
export function onSave(cb) { if (typeof cb === 'function') saveListeners.push(cb); }

function save(d) {
  localStorage.setItem(KEY, JSON.stringify(d));
  for (const cb of saveListeners) { try { cb(d); } catch (e) { /* ignore listener errors */ } }
}

// The entire progress object (verses/words/phrases/modes/profiles/aliyot/levels).
// Used by the cloud-sync layer to snapshot and push; callers should treat it as
// read-only.
export function getAll() { return load(); }

// Overwrite all progress (used after signing in, once the merged cloud+local
// snapshot has been computed). Triggers save listeners like any other write.
export function replaceAll(d) { save(d || {}); }

// Deep-merge a remote snapshot into local progress, keeping the BEST of each:
// scores/levels take the max, and whole-verse profiles keep the higher-scoring
// take. This lets a signed-in user's progress from other devices combine with
// whatever they earned locally (incl. while logged out) without ever losing a
// best. Returns the merged object (and persists it).
export function mergeRemote(remote) {
  const local = load();
  const merged = mergeProgress(local, remote || {});
  save(merged);
  return merged;
}

// Buckets whose values are single "best" numbers (higher wins). `aliyaSolo` holds
// the best *continuous solo* full-aliyah take (no duet), tracked separately from
// `aliyot` (which also counts duet takes, capped) so the leaderboard can rank
// solo above duet above a derived floor.
const MAX_BUCKETS = ['verses', 'words', 'phrases', 'modes', 'aliyot', 'levels', 'aliyaSolo'];

// How many recent/best runs to keep per pasuk (for "your top-N scores").
const RUNS_CAP = 20;

// How many attempts to keep in the ordered run-log (for the leaderboard colourbar
// of score-over-runs). Larger than RUNS_CAP because these are chronological, not
// just the bests.
const RUNLOG_CAP = 50;

function mergeProgress(a, b) {
  const out = {};
  for (const bucket of MAX_BUCKETS) {
    out[bucket] = mergeMax(a[bucket], b[bucket]);
  }
  out.profiles = mergeProfiles(a.profiles, b.profiles);
  out.runs = mergeRuns(a.runs, b.runs);
  // Ordered attempt histories (for the score-over-runs colourbar): union both
  // sides in chronological order and keep the most recent RUNLOG_CAP.
  out.runlog = mergeRunLog(a.runlog, b.runlog);
  out.aliyaRunlog = mergeRunLog(a.aliyaRunlog, b.aliyaRunlog);
  // Cumulative practice seconds: max, not sum, so repeatedly syncing the same
  // progress back and forth between devices can't inflate the total.
  out.time = mergeTime(a.time, b.time);
  // Custom aliyah boundaries: prefer the most recently edited per key.
  out.aliyotCustom = mergeCustom(a.aliyotCustom, b.aliyotCustom);
  // Public identity (chosen anon name/avatar): keep the most recently edited.
  out.profile = mergeNewer(a.profile, b.profile);
  // Preserve any unknown buckets a future version might add (prefer local).
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in out)) out[k] = a[k] !== undefined ? a[k] : b[k];
  }
  return out;
}

// Per-scope ordered attempt history: union both sides, sort chronologically,
// keep the most recent RUNLOG_CAP entries. Each entry is { s, t, duet? }.
function mergeRunLog(a = {}, b = {}) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const merged = [...((a && a[k]) || []), ...((b && b[k]) || [])]
      .filter((x) => x && typeof x.s === 'number')
      .sort((x, y) => (x.t || 0) - (y.t || 0))
      .slice(-RUNLOG_CAP);
    out[k] = merged;
  }
  return out;
}

function mergeTime(a, b) {
  const as = (a && Number(a.sec)) || 0;
  const bs = (b && Number(b.sec)) || 0;
  return { sec: Math.max(as, bs) };
}

// Per-pasuk top-N run history: union both sides, keep the best RUNS_CAP.
function mergeRuns(a = {}, b = {}) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const merged = [...(a[k] || []), ...(b[k] || [])]
      .map((x) => Number(x) || 0)
      .sort((x, y) => y - x)
      .slice(0, RUNS_CAP);
    out[k] = merged;
  }
  return out;
}

// Custom boundaries carry an `updatedAt` epoch so the newer edit wins on merge.
function mergeCustom(a = {}, b = {}) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const cur = out[k];
    if (!cur || (b[k] && (b[k].updatedAt || 0) >= (cur.updatedAt || 0))) out[k] = b[k];
  }
  return out;
}

// Keep whichever object carries the newer `updatedAt` (used for single-value
// records like the public identity profile that shouldn't be field-merged).
function mergeNewer(a, b) {
  if (!a) return b || undefined;
  if (!b) return a;
  return (b.updatedAt || 0) >= (a.updatedAt || 0) ? b : a;
}

function mergeMax(a = {}, b = {}) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = Math.max(Number(out[k]) || 0, Number(b[k]) || 0);
  }
  return out;
}

function mergeProfiles(a = {}, b = {}) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const cur = out[k];
    if (!cur || (b[k] && b[k].score >= (cur.score || 0))) out[k] = b[k];
  }
  return out;
}

// Per-verse best score (for the heatmap) keyed by slug:verseNumber.
export function recordVerseScore(slug, verseN, score) {
  const d = load();
  d.verses = d.verses || {};
  const k = `${slug}:${verseN}`;
  d.verses[k] = Math.max(d.verses[k] || 0, score);
  save(d);
  return d.verses[k];
}

export function getVerseScore(slug, verseN) {
  const d = load();
  return (d.verses && d.verses[`${slug}:${verseN}`]) || 0;
}

export function getAllVerseScores(slug) {
  const d = load();
  const out = {};
  if (d.verses) {
    for (const k of Object.keys(d.verses)) {
      const [s, v] = k.split(':');
      if (s === slug) out[+v] = d.verses[k];
    }
  }
  return out;
}

// Per-word best score within a verse (for the word-level heatmap).
export function recordWordScore(slug, verseN, wordIndex, score) {
  const d = load();
  d.words = d.words || {};
  const k = `${slug}:${verseN}:${wordIndex}`;
  d.words[k] = Math.max(d.words[k] || 0, score);
  save(d);
  return d.words[k];
}

export function getWordScores(slug, verseN) {
  const d = load();
  const out = {};
  if (d.words) {
    const prefix = `${slug}:${verseN}:`;
    for (const k of Object.keys(d.words)) {
      if (k.startsWith(prefix)) out[+k.slice(prefix.length)] = d.words[k];
    }
  }
  return out;
}

// Per-phrase best score within a verse (phrases indexed by splitPhrases order).
export function recordPhraseScore(slug, verseN, phraseIndex, score) {
  const d = load();
  d.phrases = d.phrases || {};
  const k = `${slug}:${verseN}:${phraseIndex}`;
  d.phrases[k] = Math.max(d.phrases[k] || 0, score);
  save(d);
  return d.phrases[k];
}

export function getPhraseScores(slug, verseN) {
  const d = load();
  const out = {};
  if (d.phrases) {
    const prefix = `${slug}:${verseN}:`;
    for (const k of Object.keys(d.phrases)) {
      if (k.startsWith(prefix)) out[+k.slice(prefix.length)] = d.phrases[k];
    }
  }
  return out;
}

// Per-verse whole-verse accuracy, tracked separately for each "skill" (the aid
// configuration: base / notaamim / novowels / scroll / column). These are never
// summed — each is its own score you improve over time.
export function recordVerseModeScore(slug, verseN, mode, score) {
  const d = load();
  d.modes = d.modes || {};
  const k = `${slug}:${verseN}:${mode}`;
  d.modes[k] = Math.max(d.modes[k] || 0, score);
  save(d);
  return d.modes[k];
}

export function getVerseModeScores(slug, verseN) {
  const d = load();
  const out = {};
  if (d.modes) {
    const prefix = `${slug}:${verseN}:`;
    for (const k of Object.keys(d.modes)) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = d.modes[k];
    }
  }
  return out;
}

// Per-verse accuracy PROFILE from a whole-verse take: a { globalWordIndex:score }
// map capturing the good/bad shape of that run, kept for the best-scoring take of
// each skill so the whole-verse bar can render a gradient of where it went well.
export function recordVerseProfile(slug, verseN, mode, score, profile) {
  const d = load();
  d.profiles = d.profiles || {};
  const k = `${slug}:${verseN}:${mode}`;
  const cur = d.profiles[k];
  if (!cur || score >= cur.score) { d.profiles[k] = { score, profile }; save(d); }
  return d.profiles[k];
}

export function getVerseProfile(slug, verseN, mode) {
  const d = load();
  return (d.profiles && d.profiles[`${slug}:${verseN}:${mode}`]) || null;
}

// All stored whole-verse profiles for a verse, keyed by skill/mode.
export function getVerseProfiles(slug, verseN) {
  const d = load();
  const out = {};
  if (d.profiles) {
    const prefix = `${slug}:${verseN}:`;
    for (const k of Object.keys(d.profiles)) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = d.profiles[k];
    }
  }
  return out;
}

// Per-aliyah best chant score, keyed by slug:cycle:year:aliyahNumber. Year is
// only meaningful for the triennial cycle (use 0 for annual).
function aliyahKey(slug, cycle, year, n) {
  return `${slug}:${cycle}:${cycle === 'triennial' ? year : 0}:${n}`;
}

export function recordAliyahScore(slug, cycle, year, n, score) {
  const d = load();
  d.aliyot = d.aliyot || {};
  const k = aliyahKey(slug, cycle, year, n);
  d.aliyot[k] = Math.max(d.aliyot[k] || 0, score);
  save(d);
  return d.aliyot[k];
}

export function getAliyahScore(slug, cycle, year, n) {
  const d = load();
  return (d.aliyot && d.aliyot[aliyahKey(slug, cycle, year, n)]) || 0;
}

// Per-verse highest unlocked level.
export function recordVerseLevel(slug, verseN, level) {
  const d = load();
  d.levels = d.levels || {};
  const k = `${slug}:${verseN}`;
  d.levels[k] = Math.max(d.levels[k] || 1, level);
  save(d);
  return d.levels[k];
}

export function getVerseLevel(slug, verseN) {
  const d = load();
  return (d.levels && d.levels[`${slug}:${verseN}`]) || 1;
}

// --- Per-pasuk run history (top-N) ------------------------------------------
// Keeps the best RUNS_CAP whole-verse scores for a pasuk, so the leaderboard can
// show "your top N scores" for that verse (not just the single best). Keyed by
// slug:verseN.
export function recordVerseRun(slug, verseN, score) {
  const s = Number(score) || 0;
  if (s <= 0) return;
  const d = load();
  d.runs = d.runs || {};
  const k = `${slug}:${verseN}`;
  const arr = (d.runs[k] || []).concat(s).sort((a, b) => b - a).slice(0, RUNS_CAP);
  d.runs[k] = arr;
  save(d);
  return arr;
}

export function getVerseRuns(slug, verseN) {
  const d = load();
  return (d.runs && d.runs[`${slug}:${verseN}`]) || [];
}

// --- Ordered attempt log (for the score-over-runs colourbar) ----------------
// Unlike `runs` (top-N bests, numbers only), `runlog` keeps attempts in the
// order they happened with a timestamp, so the leaderboard can draw a strip of
// score-per-attempt. Keyed slug:verseN, capped at RUNLOG_CAP.
export function recordVerseRunLog(slug, verseN, score, ts) {
  const s = Number(score) || 0;
  if (s <= 0) return;
  const d = load();
  d.runlog = d.runlog || {};
  const k = `${slug}:${verseN}`;
  const arr = (d.runlog[k] || []).concat({ s: Math.round(s), t: ts || Date.now() });
  arr.sort((a, b) => (a.t || 0) - (b.t || 0));
  d.runlog[k] = arr.slice(-RUNLOG_CAP);
  save(d);
  return d.runlog[k];
}

export function getVerseRunLog(slug, verseN) {
  const d = load();
  return (d.runlog && d.runlog[`${slug}:${verseN}`]) || [];
}

// Per-aliyah ordered attempt log. Each entry carries the `duet` flag so the
// colourbar can distinguish solo takes from assisted (sing-along) ones.
export function recordAliyahRunLog(slug, cycle, year, n, score, duet, ts) {
  const s = Number(score) || 0;
  if (s <= 0) return;
  const d = load();
  d.aliyaRunlog = d.aliyaRunlog || {};
  const k = aliyahKey(slug, cycle, year, n);
  const arr = (d.aliyaRunlog[k] || []).concat({ s: Math.round(s), t: ts || Date.now(), duet: !!duet });
  arr.sort((a, b) => (a.t || 0) - (b.t || 0));
  d.aliyaRunlog[k] = arr.slice(-RUNLOG_CAP);
  save(d);
  return d.aliyaRunlog[k];
}

export function getAliyahRunLog(slug, cycle, year, n) {
  const d = load();
  return (d.aliyaRunlog && d.aliyaRunlog[aliyahKey(slug, cycle, year, n)]) || [];
}

// --- Solo full-aliyah best --------------------------------------------------
// The best *continuous solo* full-aliyah take (no duet), tracked apart from the
// combined `aliyot` best so the aliyah leaderboard can rank a genuine solo chain
// above a duet (capped) above a derived-from-pesukim floor.
export function recordAliyahSolo(slug, cycle, year, n, score) {
  const d = load();
  d.aliyaSolo = d.aliyaSolo || {};
  const k = aliyahKey(slug, cycle, year, n);
  d.aliyaSolo[k] = Math.max(d.aliyaSolo[k] || 0, Number(score) || 0);
  save(d);
  return d.aliyaSolo[k];
}

export function getAliyahSolo(slug, cycle, year, n) {
  const d = load();
  return (d.aliyaSolo && d.aliyaSolo[aliyahKey(slug, cycle, year, n)]) || 0;
}

// --- Practice time ----------------------------------------------------------
// Rough estimate, in seconds, of how long the reader has spent practicing.
// Tracked accurately going forward (each recorded take adds its window's
// duration); for progress made before tracking existed, we fall back to an
// estimate derived from how many attempts are on record.
const AVG_VERSE_SEC = 8;    // a single whole-verse/word take
const AVG_ALIYAH_SEC = 90;  // a continuous aliyah take

export function addPracticeSeconds(sec) {
  const s = Number(sec) || 0;
  if (s <= 0) return;
  const d = load();
  d.time = d.time || { sec: 0 };
  d.time.sec = (Number(d.time.sec) || 0) + Math.round(s);
  save(d);
  return d.time.sec;
}

// Total practice seconds: the greater of the accurately-tracked total and an
// estimate backfilled from attempt counts (so existing users aren't shown ~0).
export function getPracticeSeconds() {
  const d = load();
  const tracked = (d.time && Number(d.time.sec)) || 0;
  let verseAttempts = 0;
  const runlog = d.runlog || {};
  const runs = d.runs || {};
  for (const k of new Set([...Object.keys(runlog), ...Object.keys(runs)])) {
    verseAttempts += Math.max((runlog[k] || []).length, (runs[k] || []).length);
  }
  let aliyahAttempts = 0;
  const alog = d.aliyaRunlog || {};
  const aliyot = d.aliyot || {};
  for (const k of new Set([...Object.keys(alog), ...Object.keys(aliyot)])) {
    aliyahAttempts += Math.max((alog[k] || []).length, (aliyot[k] || 0) > 0 ? 1 : 0);
  }
  const estimate = verseAttempts * AVG_VERSE_SEC + aliyahAttempts * AVG_ALIYAH_SEC;
  return Math.max(tracked, estimate);
}

// --- Per-user custom aliyah boundaries -------------------------------------
// Overrides the default aliyah partition for one user, per slug+cycle. Value is
// { list: [{ n, start, end }], updatedAt }. Leaderboards ignore these overrides
// (they roll up from pesukim onto the canonical default partition); this only
// changes what the user practices as a single aliyah take.
function customKey(slug, cycle) { return `${slug}:${cycle}`; }

export function getAliyotCustom(slug, cycle) {
  const d = load();
  const rec = d.aliyotCustom && d.aliyotCustom[customKey(slug, cycle)];
  return rec && Array.isArray(rec.list) ? rec.list : null;
}

export function setAliyotCustom(slug, cycle, list) {
  const d = load();
  d.aliyotCustom = d.aliyotCustom || {};
  const k = customKey(slug, cycle);
  if (!list) delete d.aliyotCustom[k];
  else d.aliyotCustom[k] = { list, updatedAt: Date.now() };
  save(d);
  return list;
}

// --- Public identity (optional anonymous name + avatar) --------------------
// How a signed-in user chooses to appear on the shared leaderboard, instead of
// their Google display name/photo. `{ chosen, name, photo, updatedAt }` where
// `photo` may be a data-URL (generated cartoon/solid-colour avatar), a remote
// URL, or '' (fall back to an initial). Synced like the rest of progress.
export function getProfile() {
  const d = load();
  return d.profile || null;
}

export function setProfile(profile) {
  const d = load();
  d.profile = { chosen: true, name: '', photo: '', ...(profile || {}), updatedAt: Date.now() };
  save(d);
  return d.profile;
}
