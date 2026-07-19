// Hebrew Unicode helpers: strip vowels/cantillation, tokenize verses.
// Cantillation (te'amim) live in U+0591..U+05AF.
// Vowels/points (nikud) live in U+05B0..U+05BD, plus U+05BF, U+05C7.
// Shin/Sin dots (U+05C1/U+05C2) are part of the consonant's identity.

const TAAMIM_RE = /[\u0591-\u05AF]/g;                 // cantillation accents
const NIKUD_RE = /[\u05B0-\u05BD\u05BF\u05C7]/g;      // vowels + dagesh/meteg/rafe
const SHIN_SIN_RE = /[\u05C1\u05C2]/g;               // shin/sin dots
const MAQAF = '\u05BE';                              // ־ word-joiner
const SOF_PASUK = '\u05C3';                          // ׃

// A single te'am codepoint may attach to a letter. We classify them for melody.
export const TAAM = {
  ETNACHTA: 0x0591,
  SEGOL: 0x0592,
  SHALSHELET: 0x0593,
  ZAQEF_QATAN: 0x0594,
  ZAQEF_GADOL: 0x0595,
  TIPCHA: 0x0596,
  REVIA: 0x0597,
  ZARQA: 0x0598,
  PASHTA: 0x0599,
  YETIV: 0x059A,
  TEVIR: 0x059B,
  GERESH: 0x059C,
  GERESH_MUQDAM: 0x059D,
  GERSHAYIM: 0x059E,
  QARNEY_PARA: 0x059F,
  TELISHA_GEDOLA: 0x05A0,
  PAZER: 0x05A1,
  ATNAH_HAFUKH: 0x05A2,
  MUNACH: 0x05A3,
  MAHPACH: 0x05A4,
  MERCHA: 0x05A5,
  MERCHA_KEFULA: 0x05A6,
  DARGA: 0x05A7,
  QADMA: 0x05A8, // qadma / azla
  TELISHA_QETANA: 0x05A9,
  YERACH: 0x05AA,
  OLE: 0x05AB,
  ILUY: 0x05AC,
  DEHI: 0x05AD,
  ZINOR: 0x05AE,
};

// Disjunctive accents (te'amim mafsikim) take melodic priority over conjunctives.
const DISJUNCTIVE = new Set([
  TAAM.ETNACHTA, TAAM.SEGOL, TAAM.SHALSHELET, TAAM.ZAQEF_QATAN, TAAM.ZAQEF_GADOL,
  TAAM.TIPCHA, TAAM.REVIA, TAAM.ZARQA, TAAM.PASHTA, TAAM.YETIV, TAAM.TEVIR,
  TAAM.GERESH, TAAM.GERESH_MUQDAM, TAAM.GERSHAYIM, TAAM.QARNEY_PARA,
  TAAM.TELISHA_GEDOLA, TAAM.PAZER, TAAM.DEHI, TAAM.ZINOR,
]);

export function stripTaamim(s) {
  return s.replace(TAAMIM_RE, '');
}

export function stripNikud(s) {
  return s.replace(NIKUD_RE, '');
}

export function toScroll(s) {
  // Torah-scroll form: consonants only (no vowels, te'amim, shin/sin dots), and
  // no maqaf / sof-pasuk / paseq marks (a scroll has none of these).
  return s
    .replace(TAAMIM_RE, '')
    .replace(NIKUD_RE, '')
    .replace(SHIN_SIN_RE, '')
    .replace(/[\u05BE\u05C0\u05C3\u05C6]/g, '');
}

// Render a word for display given the aids currently shown.
export function renderWord(raw, { showVowels, showTaamim, scroll }) {
  let s = raw;
  if (scroll) return toScroll(s);
  if (!showTaamim) s = stripTaamim(s);
  if (!showVowels) s = stripNikud(s);
  return s;
}

// Split a verse into individual Masoretic words. Maqaf-joined units are split
// into separate words (the maqaf stays on the leading word as a visual joiner),
// so each word is navigable on its own and aligns 1:1 with the audio word
// onsets. The closing sof-pasuk ׃ stays on the final word.
// Source text (Sefaria MAM) carries a few non-letter artifacts that must not
// leak into or distort word tokenization:
//  - inline HTML around punctuation, e.g. a paseq as `&thinsp;<b>׀</b>`;
//  - Masoretic section markers `{ס}` / `{פ}` / `{ר}` (petucha/setuma);
//  - the paseq `׀` (U+05C0), which SEPARATES two words (it counts as a word
//    boundary in the Masoretic word count / audio onsets) but is often glued
//    to its neighbors with no surrounding space.
const MARKUP = /<[^>]*>|&[#a-zA-Z0-9]+;/g;
const SECTION = /\{[^}]*\}/g;                   // {ס} {פ} section markers
const PASEQ = '\u05C0';                          // ׀ word separator
const SPLIT_RE = /([\u05BE\u05C0])/;             // maqaf or paseq (kept on leader)

export function tokenize(verseText) {
  const cleaned = verseText.replace(MARKUP, '').replace(SECTION, ' ');
  const out = [];
  for (const w of cleaned.trim().split(/\s+/)) {
    if (!w) continue;
    // Split on maqaf/paseq, keeping the joiner attached to the leading word, so
    // each Masoretic word is its own token (1:1 with the audio onsets).
    let cur = '';
    for (const s of w.split(SPLIT_RE)) {
      if (s === '') continue;
      if (s === MAQAF || s === PASEQ) {
        if (cur !== '') { out.push(cur + s); cur = ''; }
      } else {
        if (cur !== '') out.push(cur);
        cur = s;
      }
    }
    if (cur !== '') out.push(cur);
  }
  return out;
}

// Each token is now a single Masoretic word.
export function wlcWordCount() {
  return 1;
}

// Split a token into letter clusters (a base consonant plus its vowels /
// cantillation marks), so letters can be positioned over their notes.
export function splitClusters(token) {
  const clusters = [];
  for (const ch of token) {
    const cp = ch.codePointAt(0);
    const isBase = cp >= 0x05D0 && cp <= 0x05EA; // Hebrew consonants
    if (isBase || clusters.length === 0) clusters.push(ch);
    else clusters[clusters.length - 1] += ch;
  }
  return clusters;
}

// Split a token into syllables (each carrying one full vowel), tracking which
// syllable holds the cantillation accent. Vowel-less trailing consonants merge
// into the previous syllable. Used to align letters to sung note steps.
export function splitSyllables(token) {
  const hasVowel = (s) => /[\u05B1-\u05BB]/.test(s); // any vowel except plain sheva
  const hasAccent = (s) => /[\u0591-\u05AE]/.test(s);
  const clusters = splitClusters(token);
  const sylls = [];
  let buf = '', acc = false;
  for (const c of clusters) {
    buf += c;
    if (hasAccent(c)) acc = true;
    if (hasVowel(c)) { sylls.push({ text: buf, accent: acc }); buf = ''; acc = false; }
  }
  if (buf) {
    if (sylls.length) {
      sylls[sylls.length - 1].text += buf;
      if (acc) sylls[sylls.length - 1].accent = true;
    } else {
      sylls.push({ text: buf, accent: acc });
    }
  }
  return sylls.length ? sylls : [{ text: token, accent: hasAccent(token) }];
}

// Return the codepoints of te'amim present in a token, in order of appearance.
export function taamimIn(token) {
  const out = [];
  for (const ch of token) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x0591 && cp <= 0x05AE) out.push(cp);
  }
  return out;
}

// Pick the melody-defining accent for a token: prefer a disjunctive, else the
// first conjunctive found, else null.
export function primaryTaam(token) {
  const marks = taamimIn(token);
  if (!marks.length) return null;
  const disj = marks.find((cp) => DISJUNCTIVE.has(cp));
  return disj != null ? disj : marks[0];
}

// Approximate the number of sung syllables in a token by counting vowel nuclei
// (all niqqud vowels except the usually-silent sheva). Used to articulate the
// synthesized chant into syllabic pulses. Minimum of 1.
export function countSyllables(token) {
  const m = token.match(/[\u05B1-\u05BB]/g);
  return Math.max(1, m ? m.length : 1);
}

export const PUNCT = { MAQAF, SOF_PASUK };
