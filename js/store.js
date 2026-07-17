// Lightweight persistence of practice scores and progress in localStorage.
const KEY = 'cantillate.v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch (e) { return {}; }
}
function save(d) { localStorage.setItem(KEY, JSON.stringify(d)); }

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
