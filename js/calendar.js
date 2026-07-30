// Which parashah is read on which Shabbat — the bridge from a date to a reading.
//
// A reader preparing for a bar/bat mitzvah knows the date of the simcha, not the
// name of the parashah, so the guided onboarding asks for the date and names the
// reading. Going the other way needs the Hebrew calendar AND the parashah
// schedule (which parshiyot are combined depends on the length of the year and
// where the festivals fall) — much more than the browser's Hebrew calendar can
// answer — so the table is built once by scripts/build_calendar.py from Hebcal
// and read here. No network at runtime beyond this one cached file.
//
// The stored records use short keys to keep the payload small; `normalize` turns
// one into the readable object the rest of the app uses.

// Resolved against this module rather than against the page, so the table is
// found from any page at any depth (scripts/smoke.html loads these modules from a
// subdirectory) and from any base path the app is deployed under.
const DATA_URL = new URL('../data/calendar.json', import.meta.url).href;

let _doc = null;
let _pending = null;
let _byDate = null;

// Hebcal appends the reason to a ref when a special Shabbat displaces the usual
// reading ("Numbers 28:9-28:15 | Shabbat Rosh Chodesh"). That reason is exactly
// what a reader needs to be told, so it is split out rather than shown inline.
function splitRef(ref) {
  if (!ref) return { ref: '', reason: '' };
  const at = ref.indexOf('|');
  if (at < 0) return { ref: ref.trim(), reason: '' };
  return { ref: ref.slice(0, at).trim(), reason: ref.slice(at + 1).trim() };
}

function bookOf(ref) {
  const m = /^(.*?)\s+\d+:\d+/.exec(ref || '');
  return m ? m[1] : '';
}

// One of the pooled seven-aliyah divisions (see scripts/build_calendar.py), with
// the book put back: the pool stores "7:12-8:10" because every ref in a reading
// names the same book, and the reader needs to be told which.
function division(i, book) {
  const pool = _doc && _doc.divisions;
  if (!pool || !Array.isArray(pool[i])) return null;
  return pool[i].map((s) => (book && /^\d/.test(s) ? `${book} ${s}` : s));
}

// One stored record as a readable object. `slugs` is always an array (a combined
// week reads two parshiyot as one long reading, and either may be the one the
// reader is preparing).
export function normalize(r) {
  if (!r) return null;
  const torah = splitRef(r.t);
  const book = bookOf(torah.ref);
  const maftir = splitRef(r.m);
  const haftarah = splitRef(r.h);
  return {
    date: r.d,
    parashah: r.p,
    hebrew: r.he,
    slug: r.s || null,
    slugs: r.c && r.c.length ? r.c.slice() : (r.s ? [r.s] : []),
    combined: !!(r.c && r.c.length > 1),
    hebrewDate: r.hd || '',
    hebrewYear: r.hy || null,
    triYear: r.ty || null,
    torahRef: torah.ref,
    maftirRef: maftir.ref,
    triMaftirRef: splitRef(r.tm).ref,
    haftarahRef: haftarah.ref,
    // Where the seven aliyot fall, both ways round, so a reader called for one of
    // them can be told which pesukim are theirs — the parashah's whole range says
    // nothing about that, and only fifteen readings ship with divisions of their
    // own. Each is a 7-element array, index 0 being the first aliyah.
    aliyot: {
      annual: division(r.aa, book),
      triennial: division(r.at, book),
    },
    // The one reason worth surfacing: on a special Shabbat the maftir and
    // haftarah are not the parashah's own, which changes what to prepare.
    special: maftir.reason || haftarah.reason || torah.reason || '',
  };
}

export async function load() {
  if (_doc) return _doc;
  if (!_pending) {
    _pending = fetch(DATA_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => {
        _doc = doc && Array.isArray(doc.shabbatot) ? doc : null;
        if (_doc) _byDate = new Map(_doc.shabbatot.map((r) => [r.d, r]));
        return _doc;
      })
      .catch(() => null);
  }
  return _pending;
}

export function isLoaded() { return !!_doc; }

// The span of dates the table covers, so the UI can say so instead of failing
// silently on a date outside it.
export function coverage() {
  if (!_doc) return null;
  return { from: _doc.from, to: _doc.to, count: _doc.shabbatot.length };
}

export function source() { return _doc ? _doc.source : ''; }

// The compact records as they sit in the file (`d`, `p`, `s`, `ty`…). Internal:
// the lookups below walk them by the thousand, so they are not normalized until a
// single answer is being handed out.
function rows() { return _doc ? _doc.shabbatot : []; }

// Every Shabbat in the table, in date order, in the readable shape every other
// export here returns. Nothing outside this module should have to know that the
// file is stored with one-letter keys.
export function all() { return rows().map(normalize); }

// YYYY-MM-DD for a Date, in LOCAL time. Deliberately not toISOString(), which
// shifts to UTC and can hand back the previous day west of Greenwich — a date
// picker's value is a civil date, not an instant.
export function isoOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function today() { return isoOf(new Date()); }

// The Shabbat falling exactly on this date, or null.
export function on(iso) {
  if (!_byDate) return null;
  return normalize(_byDate.get(iso) || null);
}

// The reading for a date: that Shabbat if the date IS one, else the next Shabbat
// on which a parashah is read. A bar mitzvah is generally called on a Shabbat,
// but readers type the birthday, the Sunday of the party, or a weekday aufruf —
// all of which should resolve to a reading rather than an error.
export function forDate(iso) {
  const list = rows();
  if (!list.length || !iso) return null;
  const exact = on(iso);
  if (exact) return exact;
  const next = list.find((r) => r.d >= iso);
  return normalize(next || list[list.length - 1]);
}

// Whether a date sits inside the built table at all.
export function covers(iso) {
  const c = coverage();
  return !!(c && iso && iso >= c.from && iso <= c.to);
}

// The upcoming Shabbat's reading (today included, if today is one).
export function upcoming(from = today()) { return forDate(from); }

// `n` Shabbatot either side of a date, for a "not this one?" browse-by-week list.
export function around(iso, n = 3) {
  const list = rows();
  if (!list.length) return [];
  let at = list.findIndex((r) => r.d >= iso);
  if (at < 0) at = list.length - 1;
  return list.slice(Math.max(0, at - n), at + n + 1).map(normalize);
}

// One entry per distinct parashah, in the order of the reading year, each with
// the next date it is read on or after `from`. This is the "pick it from a list"
// fallback for a reader who doesn't know the date.
export function parashiyot(from = today()) {
  const list = rows();
  const bySlug = new Map();
  // Walk forward first so each parashah gets its NEXT occurrence, then fill in
  // any that don't come round again inside the table from the earlier rows.
  for (const r of list) {
    if (r.d < from || !r.s) continue;
    if (!bySlug.has(r.s)) bySlug.set(r.s, r);
  }
  for (const r of list) {
    if (!r.s || bySlug.has(r.s)) continue;
    bySlug.set(r.s, r);
  }
  const out = [...bySlug.values()].map(normalize);
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// Which year of the triennial cycle a Hebrew year is. Anchored at 5756, the start
// of the CJLS cycle; scripts/build_calendar.py verifies this against what Hebcal
// actually schedules for every Shabbat in the table.
const TRIENNIAL_EPOCH = 5756;

export function triennialYearOfHebrewYear(hy) {
  if (!hy) return null;
  return (((hy - TRIENNIAL_EPOCH) % 3) + 3) % 3 + 1;
}

// The triennial year in force on a given date, from the table (falling back to
// the closed form for dates outside it).
// The ref of a single aliyah (1-7) of a Shabbat's reading, on a cycle.
export function aliyahRef(rec, n, cycle = 'annual') {
  const set = rec && rec.aliyot
    ? (cycle === 'triennial' ? rec.aliyot.triennial : rec.aliyot.annual)
    : null;
  const i = Number(n) - 1;
  return (set && i >= 0 && set[i]) || '';
}

export function triennialYearOn(iso) {
  const rec = forDate(iso);
  if (rec && rec.triYear) return rec.triYear;
  return null;
}
