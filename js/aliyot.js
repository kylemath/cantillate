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

// Approximate current Hebrew year from a Gregorian date. Rosh Hashanah falls in
// Sept/Oct; we switch at ~Sept 15, which is close enough to pick the triennial
// year by default (the user can override).
export function currentHebrewYear(d = new Date()) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const afterRoshHashanah = m > 9 || (m === 9 && d.getDate() >= 15);
  return afterRoshHashanah ? y + 3761 : y + 3760;
}

// Which year (1–3) of the triennial cycle the given date falls in.
export function currentTriennialYear(d = new Date()) {
  const r = currentHebrewYear(d) % 3;
  return r === 0 ? 3 : r; // 1,2,0 -> 1,2,3
}
