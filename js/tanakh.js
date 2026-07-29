// Any passage, any book. The shipped readings (data/readings.json) are the ones
// with a recording behind them; this module is the rest of the canon — all 39
// books of the Tanakh as plain text, so a reader can open an arbitrary run of
// pesukim (Isaiah 40:1–26, Esther 3:1–15, Psalms 23) and work it up like any
// other reading.
//
// The corpus is built by scripts/build_tanakh.py into one file per book, fetched
// only when that book is picked:
//
//   data/tanakh/index.json     every book: names, chapter lengths, parashiyot
//   data/tanakh/<slug>.json    the Hebrew (MAM, with te'amim), by chapter
//   data/tanakh/<slug>.en.json the English (Koren), by chapter
//
// A chapter is a bare array of verse strings, so verse v of chapter c is
// chapters[c-1][v-1]; the index's per-chapter counts are enough to populate a
// picker and validate a range without loading any text at all.
//
// A custom range has no recorded chant, so it is taught in the haftarah melody
// from the measured shapes (data/haftarah-shapes.json) — the same treatment the
// trope drills get. The three poetic books (Psalms, Proverbs, Job) use the other
// Masoretic accent system, which neither melody describes; `accents` says so and
// the app passes the warning on rather than teaching a tune that doesn't exist.

const INDEX_URL = 'data/tanakh/index.json';

// Which melody a passage picked out of a book is taught in. A haftarah is the
// canonical "read from a book, not from the scroll" chant, so it is the right
// default for anything outside the Torah reading itself.
export const CUSTOM_TROPE_STYLE = 'haftarah';

let _index = null;
let _indexPromise = null;
const _books = new Map();      // slug -> Hebrew doc
const _english = new Map();    // slug -> English doc

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// The book list. Cached, and the in-flight promise is shared so a picker opening
// twice in quick succession still only fetches it once.
export function loadIndex() {
  if (_index) return Promise.resolve(_index);
  if (!_indexPromise) {
    _indexPromise = getJson(INDEX_URL)
      .then((doc) => { _index = doc; return doc; })
      .catch((e) => { _indexPromise = null; throw e; });
  }
  return _indexPromise;
}

export function indexIfLoaded() { return _index; }

export function bookEntry(slug) {
  return (_index && _index.books.find((b) => b.slug === slug)) || null;
}

export async function loadBook(slug) {
  if (_books.has(slug)) return _books.get(slug);
  await loadIndex();
  const entry = bookEntry(slug);
  if (!entry) throw new Error(`unknown book: ${slug}`);
  const doc = await getJson(entry.file);
  _books.set(slug, doc);
  return doc;
}

export function bookIfLoaded(slug) { return _books.get(slug) || null; }

export async function loadEnglish(slug) {
  if (_english.has(slug)) return _english.get(slug);
  await loadIndex();
  const entry = bookEntry(slug);
  if (!entry || !entry.enFile) return null;
  const doc = await getJson(entry.enFile);
  _english.set(slug, doc);
  return doc;
}

export function englishIfLoaded(slug) { return _english.get(slug) || null; }

// --- References -------------------------------------------------------------
// Same shape as the built readings' `ref` / `heRef`, so a custom passage cites
// itself the way a haftarah does.

const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת'];
const GERESH = '\u05f3';
const GERSHAYIM = '\u05f4';

// Gematria letters for n. 15 and 16 are written tet-vav / tet-zayin rather than
// spelling a divine name; 500 and up repeat tav.
export function heLetters(n) {
  if (!(n > 0)) return String(n);
  let out = '';
  let h = Math.floor(n / 100);
  const rest = n % 100;
  while (h > 4) { out += HUNDREDS[4]; h -= 4; }
  out += HUNDREDS[h] || '';
  if (rest === 15 || rest === 16) return out + 'ט' + ONES[rest - 9];
  out += TENS[Math.floor(rest / 10)] || '';
  out += ONES[rest % 10] || '';
  return out;
}

// A chapter carries the geresh (מ׳); a single-letter verse is written bare, since
// the mark is what tells the two halves of a reference apart.
export function heNum(n) {
  const l = heLetters(n);
  if (l.length === 1) return l + GERESH;
  return l.slice(0, -1) + GERSHAYIM + l.slice(-1);
}

export function heVerse(n) {
  const l = heLetters(n);
  if (l.length === 1) return l;
  return l.slice(0, -1) + GERSHAYIM + l.slice(-1);
}

export function refFor(bookEn, from, to) {
  const [c0, v0] = from;
  const [c1, v1] = to;
  if (c0 === c1) return `${bookEn} ${c0}:${v0}${v0 === v1 ? '' : `-${v1}`}`;
  return `${bookEn} ${c0}:${v0}-${c1}:${v1}`;
}

export function heRefFor(bookHe, from, to) {
  const [c0, v0] = from;
  const [c1, v1] = to;
  if (c0 === c1) {
    return `${bookHe} ${heNum(c0)}:${heVerse(v0)}${v0 === v1 ? '' : `-${heVerse(v1)}`}`;
  }
  return `${bookHe} ${heNum(c0)}:${heVerse(v0)}-${heNum(c1)}:${heVerse(v1)}`;
}

// --- Ranges -----------------------------------------------------------------

// A book-absolute 1-based verse index, so two ranges can be compared and a
// range's length is known before any text is loaded. `chapters` is the index
// entry's per-chapter verse counts.
export function absIndex(chapters, c, v) {
  let n = 0;
  for (let i = 0; i < c - 1; i++) n += chapters[i] || 0;
  return n + v;
}

export function fromAbs(chapters, abs) {
  let n = abs;
  for (let i = 0; i < chapters.length; i++) {
    if (n <= chapters[i]) return [i + 1, n];
    n -= chapters[i];
  }
  const last = chapters.length;
  return [last, chapters[last - 1]];
}

export function clampRef(entry, c, v) {
  const chapters = entry.chapters;
  const cc = Math.min(Math.max(1, c | 0), chapters.length);
  const vv = Math.min(Math.max(1, v | 0), chapters[cc - 1]);
  return [cc, vv];
}

// [from, to] put in order and clamped to the book, plus how many pesukim it is.
export function normalizeRange(entry, from, to) {
  const a = clampRef(entry, from[0], from[1]);
  const b = clampRef(entry, to[0], to[1]);
  const ia = absIndex(entry.chapters, a[0], a[1]);
  const ib = absIndex(entry.chapters, b[0], b[1]);
  const [lo, hi] = ia <= ib ? [a, b] : [b, a];
  return { from: lo, to: hi, count: Math.abs(ib - ia) + 1 };
}

// How long a passage may be. Long enough for any haftarah or a whole chapter of
// Psalms; short of "the reader accidentally opened all of Jeremiah", which would
// build tens of thousands of melodies on the main thread.
export const MAX_VERSES = 200;

// --- Building a reading -----------------------------------------------------

// Local progress is filed under the slug, and a verse's number within a reading
// is its key — so the slug names the book AND where the passage starts, and any
// two ranges that begin at the same pasuk share their progress however far they
// run. (The leaderboard is keyed by book:chapter:verse in js/scores.js, so a
// pasuk practiced here and in its parashah counts as the same pasuk there.)
export function progressSlug(bookSlug, from) {
  return `tanakh:${bookSlug}:${from[0]}.${from[1]}`;
}

// The menu entry's id: one per distinct passage, so re-picking the same range
// reuses its entry instead of stacking duplicates in the Reading selector.
export function readingId(bookSlug, from, to) {
  return `custom:${bookSlug}:${from[0]}.${from[1]}-${to[0]}.${to[1]}`;
}

// Which parashah a Torah reference falls in (the picker's scope selector), or
// null outside the Torah.
export function parashahAt(entry, c, v) {
  if (!entry.parashiyot) return null;
  const abs = absIndex(entry.chapters, c, v);
  return entry.parashiyot.find((p) => {
    const s = absIndex(entry.chapters, p.start[0], p.start[1]);
    const e = absIndex(entry.chapters, p.end[0], p.end[1]);
    return abs >= s && abs <= e;
  }) || null;
}

// Assemble the reading document the app renders: the same schema as a built
// data/<slug>.json, so every downstream view (pesukim list, scroll pane, aliyah
// reader, scoring) works on a custom passage with no special cases.
export function buildReading(entry, heDoc, from, to, enDoc = null, name = '') {
  const { from: lo, to: hi, count } = normalizeRange(entry, from, to);
  const verses = [];
  let [c, v] = lo;
  for (let n = 1; n <= count; n++) {
    const chapter = heDoc.chapters[c - 1] || [];
    const enChapter = (enDoc && enDoc.chapters[c - 1]) || [];
    verses.push({
      n,
      c,
      v,
      ref: `${c}:${v}`,
      text: chapter[v - 1] || '',
      en: enChapter[v - 1] || '',
    });
    v += 1;
    if (v > (entry.chapters[c - 1] || 0)) { c += 1; v = 1; }
  }
  const ref = refFor(entry.en, lo, hi);
  const heRef = heRefFor(entry.he, lo, hi);
  const par = parashahAt(entry, lo[0], lo[1]);
  return {
    slug: progressSlug(entry.slug, lo),
    book: { en: entry.en, he: entry.he, translit: entry.translit },
    multiChapter: true,
    ref,
    heRef,
    versionTitle: heDoc.versionTitle,
    heVersionTitle: heDoc.heVersionTitle || heDoc.versionTitle,
    enVersionTitle: enDoc ? enDoc.enVersionTitle : heDoc.enVersionTitle,
    license: heDoc.license,
    source: heDoc.source,
    kind: 'custom',
    tropeStyle: CUSTOM_TROPE_STYLE,
    accents: entry.accents,
    custom: {
      book: entry.slug,
      section: entry.section,
      sectionLabel: entry.sectionLabel,
      accents: entry.accents,
      from: lo,
      to: hi,
      count,
      name,
      parashah: par ? { en: par.en, he: par.he } : null,
    },
    // What this passage is called, shown wherever a parashah's name would be —
    // including the leaderboard, so a named passage is listed by its name and an
    // unnamed one by its reference, which is the only name it has.
    parashah: { en: name || ref, translit: name || ref, he: heRef },
    verses,
    // One chunk over the whole passage, so "chant the whole thing" works here as
    // it does for an aliyah or a haftarah. Explicitly kinded so the UI can call
    // it a passage rather than an aliyah number.
    aliyot: {
      annual: [{ n: 'C', kind: 'passage', start: 1, end: count,
        ref: `${lo[0]}:${lo[1]}\u2013${hi[0]}:${hi[1]}` }],
      triennial: {},
    },
  };
}

// Fill in the English column of an already-built custom reading, once the
// translation for its book has been fetched (it is not on the critical path).
export function fillEnglish(doc, enDoc) {
  if (!doc || !enDoc) return doc;
  for (const row of doc.verses) {
    const ch = enDoc.chapters[row.c - 1] || [];
    row.en = ch[row.v - 1] || '';
  }
  doc.enVersionTitle = enDoc.enVersionTitle || doc.enVersionTitle;
  return doc;
}
