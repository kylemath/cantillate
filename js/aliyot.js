// Aliyah (Torah-reading section) definitions and cycle helpers.
//
// A parashah is divided into 7 aliyot (+ maftir) for the ANNUAL cycle, and into
// a different set each year of the 3-year TRIENNIAL cycle. Ranges here are given
// as inclusive verse numbers WITHIN the loaded chapter. Aliyot (or triennial
// years) that continue past the loaded text are omitted and surfaced as
// "beyond this reading" in the UI.
//
// NOTE: the app currently ships only Deuteronomy 1 (devarim1). Annual aliyot 1–3
// sit fully inside the chapter; aliyah 4 (1:39–2:1) is shown capped at 1:46.
// Triennial year 1 (1:1–2:1) sits inside the chapter; years 2–3 are elsewhere.

export const ALIYOT = {
  devarim1: {
    parashah: { he: 'דְּבָרִים', en: 'Devarim', ref: 'Deuteronomy 1:1–3:22' },
    chapterMax: 46,
    annual: [
      { n: 1, start: 1, end: 10, ref: '1:1–10' },
      { n: 2, start: 11, end: 21, ref: '1:11–21' },
      { n: 3, start: 22, end: 38, ref: '1:22–38' },
      { n: 4, start: 39, end: 46, ref: '1:39–2:1', partial: true },
    ],
    // Aliyot 5–7 + maftir of the annual cycle continue past Deuteronomy 1.
    triennial: {
      1: [
        { n: 1, start: 1, end: 3, ref: '1:1–3' },
        { n: 2, start: 4, end: 11, ref: '1:4–11' },
        { n: 3, start: 12, end: 21, ref: '1:12–21' },
        { n: 4, start: 22, end: 28, ref: '1:22–28' },
        { n: 5, start: 29, end: 33, ref: '1:29–33' },
        { n: 6, start: 34, end: 38, ref: '1:34–38' },
        { n: 7, start: 39, end: 46, ref: '1:39–2:1', partial: true },
      ],
      2: [], // Deut 2:2–… (beyond the loaded chapter)
      3: [], // Deut 3:… (beyond the loaded chapter)
    },
  },
};

export function parashahOf(slug) {
  return ALIYOT[slug] ? ALIYOT[slug].parashah : null;
}

// Aliyot for a given cycle. year is only used for the triennial cycle.
export function aliyotFor(slug, cycle, year) {
  const a = ALIYOT[slug];
  if (!a) return [];
  if (cycle === 'triennial') return a.triennial[year] || [];
  return a.annual;
}

// The Hebrew year a Gregorian date falls in. Read from the browser's own Hebrew
// calendar, so Rosh Hashanah lands on the day it actually does; the old ~Sept 15
// approximation is kept as the fallback for anywhere Intl has no Hebrew calendar.
export function currentHebrewYear(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US-u-ca-hebrew', { year: 'numeric' })
      .formatToParts(d);
    const year = parseInt((parts.find((p) => p.type === 'year') || {}).value, 10);
    if (Number.isFinite(year)) return year;
  } catch (e) { /* no Hebrew calendar in this engine */ }
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const afterRoshHashanah = m > 9 || (m === 9 && d.getDate() >= 15);
  return afterRoshHashanah ? y + 3761 : y + 3760;
}

// Which year (1–3) of the triennial cycle the given date falls in. The CJLS cycle
// is anchored at 5756, NOT at a multiple of three, so `hebrewYear % 3` — what
// this used to do — named the wrong third of every parashah.
// scripts/build_calendar.py checks this formula against the year Hebcal actually
// schedules for every Shabbat it builds (741 of them agree, none disagree).
export const TRIENNIAL_EPOCH = 5756;

export function currentTriennialYear(d = new Date()) {
  const hy = currentHebrewYear(d);
  return ((((hy - TRIENNIAL_EPOCH) % 3) + 3) % 3) + 1;
}
