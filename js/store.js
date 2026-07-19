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

// Buckets whose values are single "best" numbers (higher wins).
const MAX_BUCKETS = ['verses', 'words', 'phrases', 'modes', 'aliyot', 'levels'];

function mergeProgress(a, b) {
  const out = {};
  for (const bucket of MAX_BUCKETS) {
    out[bucket] = mergeMax(a[bucket], b[bucket]);
  }
  out.profiles = mergeProfiles(a.profiles, b.profiles);
  // Preserve any unknown buckets a future version might add (prefer local).
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in out)) out[k] = a[k] !== undefined ? a[k] : b[k];
  }
  return out;
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
