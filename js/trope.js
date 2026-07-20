// Cantillation trope motifs as pitch contours over normalized time.
//
// Each motif is an array of { t, p } control points:
//   t = normalized time within the word's syllabic span (0..1)
//   p = pitch offset in semitones relative to the reading tonic (0 = tonic)
//
// These are stylized approximations of the Ashkenazi (Lithuanian) Torah reading
// tradition, meant to convey the LINEAR SHAPE of each accent's tone over time.
// They are intentionally data-driven and easy to refine per tradition.

import { TAAM, primaryTaam, countSyllables } from './hebrew.js';

// Trope FAMILIES — one color per *disjunctive* (pause-defining) accent group.
// Conjunctive "connector" accents have no fixed tune of their own; each one is
// a pickup into the following disjunctive, so it is colored contextually (see
// buildLineMelody) by the phrase it leads into rather than a generic grey.
// Members are te'amim codepoints (plus the virtual 'sof' key for Sof Pasuk).
// Palette: eight hues spread around the wheel and tuned for legibility on the
// dark background, so adjacent families are as visually distinct as possible
// (blue · cyan · green · yellow · orange · red · magenta · violet). Connectors
// reuse their governing accent's hue, desaturated (see muteColor / buildLineMelody).
export const FAMILIES = [
  { id: 'sofpasuk', label: 'End / major pause', color: '#4d8dff',
    members: ['sof', TAAM.ETNACHTA, TAAM.ATNAH_HAFUKH] },
  { id: 'tipcha', label: 'Tipcha (pre-pause dip)', color: '#1fc8d8',
    members: [TAAM.TIPCHA, TAAM.DEHI] },
  { id: 'zaqef', label: 'Zaqef / Pashta group', color: '#b070ff',
    members: [TAAM.ZAQEF_QATAN, TAAM.ZAQEF_GADOL, TAAM.PASHTA, TAAM.YETIV] },
  { id: 'segol', label: 'Segol / Zarqa', color: '#ff8a2a',
    members: [TAAM.SEGOL, TAAM.ZARQA, TAAM.ZINOR] },
  { id: 'revia', label: 'Revia', color: '#34c94a',
    members: [TAAM.REVIA] },
  { id: 'geresh', label: 'Geresh / Gershayim', color: '#ff4fb0',
    members: [TAAM.GERESH, TAAM.GERESH_MUQDAM, TAAM.GERSHAYIM] },
  { id: 'tevir', label: 'Tevir', color: '#ffd11a',
    members: [TAAM.TEVIR] },
  { id: 'ornament', label: 'Ornamental / rare', color: '#ff5347',
    members: [TAAM.TELISHA_GEDOLA, TAAM.PAZER, TAAM.QARNEY_PARA, TAAM.SHALSHELET] },
];

const NEUTRAL = '#6b7290';
const _famByTaam = new Map();
FAMILIES.forEach((f) => f.members.forEach((m) => _famByTaam.set(m, f)));

export function familyFor(taam) {
  return _famByTaam.get(taam) || null;
}
export function colorFor(taam) {
  const f = _famByTaam.get(taam);
  return f ? f.color : NEUTRAL;
}
export function familyIdFor(taam) {
  const f = _famByTaam.get(taam);
  return f ? f.id : 'none';
}

// Desaturate a hex color while keeping its hue, used to render connectors as a
// muted version of the disjunctive they lead into.
export function muteColor(hex) {
  const h = hex.replace('#', '');
  let r = parseInt(h.substring(0, 2), 16) / 255;
  let g = parseInt(h.substring(2, 4), 16) / 255;
  let b = parseInt(h.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hh = 0, s = 0; const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60; if (hh < 0) hh += 360;
  }
  s *= 0.4; // less saturated, same hue
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hh / 60) % 2 - 1));
  const m = l - c / 2;
  let rr = 0, gg = 0, bb = 0;
  if (hh < 60) [rr, gg, bb] = [c, x, 0];
  else if (hh < 120) [rr, gg, bb] = [x, c, 0];
  else if (hh < 180) [rr, gg, bb] = [0, c, x];
  else if (hh < 240) [rr, gg, bb] = [0, x, c];
  else if (hh < 300) [rr, gg, bb] = [x, 0, c];
  else [rr, gg, bb] = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(rr)}${to(gg)}${to(bb)}`;
}

// Render a cantillation mark in isolation (combining accent placed on a base
// letter) so it can be shown as an icon. Sof pasuk shows its ׃ punctuation.
export function markGlyph(taam) {
  if (taam === 'sof') return '\u05C3';
  if (typeof taam !== 'number') return '';
  return '\u05D0' + String.fromCodePoint(taam); // aleph + accent
}
export function familyGlyphs(family) {
  return family.members.map(markGlyph);
}

const M = {
  // Conjunctives (meshartim) — short connectives, mostly rising into the next.
  [TAAM.MUNACH]:        [{ t: 0, p: -2 }, { t: 1, p: 0 }],
  [TAAM.MERCHA]:        [{ t: 0, p: -3 }, { t: 1, p: 0 }],
  [TAAM.MAHPACH]:       [{ t: 0, p: 0 }, { t: 0.5, p: 2 }, { t: 1, p: 0 }],
  [TAAM.DARGA]:         [{ t: 0, p: -3 }, { t: 0.5, p: -1 }, { t: 1, p: 1 }],
  [TAAM.QADMA]:         [{ t: 0, p: 0 }, { t: 1, p: 3 }],
  [TAAM.MERCHA_KEFULA]: [{ t: 0, p: -3 }, { t: 0.4, p: 0 }, { t: 0.6, p: -3 }, { t: 1, p: 0 }],
  [TAAM.TELISHA_QETANA]:[{ t: 0, p: 2 }, { t: 0.5, p: 4 }, { t: 1, p: 2 }],
  [TAAM.YERACH]:        [{ t: 0, p: -3 }, { t: 1, p: -1 }],

  // Disjunctives (mafsikim) — pauses of increasing weight.
  [TAAM.TIPCHA]:        [{ t: 0, p: 2 }, { t: 0.6, p: 0 }, { t: 1, p: -2 }],
  [TAAM.ETNACHTA]:      [{ t: 0, p: 1 }, { t: 0.5, p: -1 }, { t: 1, p: -4 }],
  [TAAM.ZAQEF_QATAN]:   [{ t: 0, p: 0 }, { t: 0.5, p: 4 }, { t: 1, p: 2 }],
  [TAAM.ZAQEF_GADOL]:   [{ t: 0, p: 0 }, { t: 0.3, p: 4 }, { t: 0.6, p: 2 }, { t: 1, p: 5 }],
  [TAAM.REVIA]:         [{ t: 0, p: 1 }, { t: 0.5, p: 3 }, { t: 1, p: 2 }],
  [TAAM.PASHTA]:        [{ t: 0, p: 0 }, { t: 0.6, p: 2 }, { t: 1, p: 4 }],
  [TAAM.YETIV]:         [{ t: 0, p: 3 }, { t: 0.5, p: 1 }, { t: 1, p: 2 }],
  [TAAM.TEVIR]:         [{ t: 0, p: 2 }, { t: 0.5, p: 0 }, { t: 1, p: -2 }],
  [TAAM.GERESH]:        [{ t: 0, p: 1 }, { t: 0.5, p: 4 }, { t: 1, p: 3 }],
  [TAAM.GERESH_MUQDAM]: [{ t: 0, p: 1 }, { t: 0.5, p: 4 }, { t: 1, p: 3 }],
  [TAAM.GERSHAYIM]:     [{ t: 0, p: 1 }, { t: 0.3, p: 4 }, { t: 0.6, p: 2 }, { t: 1, p: 4 }],
  [TAAM.ZARQA]:         [{ t: 0, p: 0 }, { t: 0.25, p: 3 }, { t: 0.5, p: 1 }, { t: 0.75, p: 5 }, { t: 1, p: 3 }],
  [TAAM.ZINOR]:         [{ t: 0, p: 0 }, { t: 0.25, p: 3 }, { t: 0.5, p: 1 }, { t: 0.75, p: 5 }, { t: 1, p: 3 }],
  [TAAM.SEGOL]:         [{ t: 0, p: 2 }, { t: 0.5, p: 5 }, { t: 1, p: 3 }],
  [TAAM.SHALSHELET]:    [{ t: 0, p: 0 }, { t: 0.2, p: 4 }, { t: 0.4, p: 1 }, { t: 0.6, p: 5 }, { t: 0.8, p: 2 }, { t: 1, p: 6 }],
  [TAAM.PAZER]:         [{ t: 0, p: 0 }, { t: 0.2, p: 2 }, { t: 0.4, p: 4 }, { t: 0.6, p: 3 }, { t: 0.8, p: 5 }, { t: 1, p: 4 }],
  [TAAM.QARNEY_PARA]:   [{ t: 0, p: 0 }, { t: 0.15, p: 3 }, { t: 0.35, p: 1 }, { t: 0.55, p: 4 }, { t: 0.75, p: 2 }, { t: 1, p: 6 }],
  [TAAM.TELISHA_GEDOLA]:[{ t: 0, p: 4 }, { t: 0.5, p: 6 }, { t: 1, p: 4 }],
  [TAAM.DEHI]:          [{ t: 0, p: 2 }, { t: 0.6, p: 0 }, { t: 1, p: -2 }],
  [TAAM.OLE]:           [{ t: 0, p: 0 }, { t: 1, p: 3 }],
  [TAAM.ILUY]:          [{ t: 0, p: 0 }, { t: 1, p: 3 }],
  [TAAM.ATNAH_HAFUKH]:  [{ t: 0, p: 1 }, { t: 0.5, p: -1 }, { t: 1, p: -4 }],
};

// Human-readable names for teaching / labels. `meaning` is the literal English
// translation of the Hebrew/Aramaic name; `note` describes the melodic shape.
export const NAMES = {
  [TAAM.ETNACHTA]:      { he: 'אֶתְנַחְתָּא', en: 'Etnachta', meaning: 'resting / pause', role: 'disjunctive', note: 'Major mid-verse pause; melody sinks below the tonic to signal rest.' },
  [TAAM.SEGOL]:         { he: 'סֶגּוֹל', en: 'Segol', meaning: 'cluster (bunch of grapes)', role: 'disjunctive', note: 'A rise, peak, and settle.' },
  [TAAM.SHALSHELET]:    { he: 'שַׁלְשֶׁלֶת', en: 'Shalshelet', meaning: 'chain', role: 'disjunctive', note: 'Rare, long triple-wave chain climbing upward.' },
  [TAAM.ZAQEF_QATAN]:   { he: 'זָקֵף קָטָן', en: 'Zaqef Qatan', meaning: 'small upright', role: 'disjunctive', note: 'Up to a peak, then a small step down.' },
  [TAAM.ZAQEF_GADOL]:   { he: 'זָקֵף גָּדוֹל', en: 'Zaqef Gadol', meaning: 'large upright', role: 'disjunctive', note: 'A bigger, more ornamented Zaqef.' },
  [TAAM.TIPCHA]:        { he: 'טִפְחָא', en: 'Tipcha', meaning: 'handbreadth / diagonal', role: 'disjunctive', note: 'Gentle descent; often precedes Etnachta / Sof Pasuk.' },
  [TAAM.REVIA]:         { he: 'רְבִיעַ', en: 'Revia', meaning: 'resting / crouching (a fourth)', role: 'disjunctive', note: 'Rise and hover, a medium pause.' },
  [TAAM.ZARQA]:         { he: 'זַרְקָא', en: 'Zarqa', meaning: 'scatterer / sprinkler', role: 'disjunctive', note: 'A scattering zig-zag that leaps up and back.' },
  [TAAM.ZINOR]:         { he: 'צִנּוֹר', en: 'Zinor', meaning: 'pipe / channel', role: 'disjunctive', note: 'Zarqa-shaped accent.' },
  [TAAM.PASHTA]:        { he: 'פַּשְׁטָא', en: 'Pashta', meaning: 'stretching forward', role: 'disjunctive', note: 'A rising accent on the stressed syllable.' },
  [TAAM.YETIV]:         { he: 'יְתִיב', en: 'Yetiv', meaning: 'resting / sitting', role: 'disjunctive', note: 'A pre-positioned turn, dip and rise.' },
  [TAAM.TEVIR]:         { he: 'תְּבִיר', en: 'Tevir', meaning: 'broken', role: 'disjunctive', note: 'A descending break.' },
  [TAAM.GERESH]:        { he: 'גֶּרֶשׁ', en: 'Geresh (Azla)', meaning: 'expulsion / driving out', role: 'disjunctive', note: 'A quick climb and slight fall.' },
  [TAAM.GERESH_MUQDAM]: { he: 'גֶּרֶשׁ מֻקְדָּם', en: 'Geresh Muqdam', meaning: 'early geresh', role: 'disjunctive', note: 'Geresh variant.' },
  [TAAM.GERSHAYIM]:     { he: 'גֵּרְשַׁיִם', en: 'Gershayim', meaning: 'double geresh', role: 'disjunctive', note: 'A double geresh, two peaks.' },
  [TAAM.QARNEY_PARA]:   { he: 'קַרְנֵי פָרָה', en: 'Qarney Para', meaning: 'horns of a cow', role: 'disjunctive', note: 'Long rare flourish (Pazer Gadol).' },
  [TAAM.TELISHA_GEDOLA]:{ he: 'תְּלִישָׁא גְדוֹלָה', en: 'Telisha Gedola', meaning: 'great detached / plucked-off', role: 'disjunctive', note: 'High ornament at the head of a phrase.' },
  [TAAM.PAZER]:         { he: 'פָּזֵר', en: 'Pazer', meaning: 'scatter / lavish', role: 'disjunctive', note: 'A long scattering run upward.' },
  [TAAM.DEHI]:          { he: 'דֶּחִי', en: 'Dehi', meaning: 'thrust / pushed away', role: 'disjunctive', note: 'Descending accent (poetic books).' },
  [TAAM.MUNACH]:        { he: 'מוּנַח', en: 'Munach', meaning: 'resting / set down', role: 'conjunctive', note: 'A low connective rising into the next word.' },
  [TAAM.MAHPACH]:       { he: 'מַהְפַּךְ', en: 'Mahpach', meaning: 'turning around / reversed', role: 'conjunctive', note: 'A small turn, up and back.' },
  [TAAM.MERCHA]:        { he: 'מֵרְכָא', en: 'Mercha', meaning: 'lengthener / prolonger', role: 'conjunctive', note: 'A rising connective, "lengthener".' },
  [TAAM.MERCHA_KEFULA]: { he: 'מֵרְכָא כְפוּלָה', en: 'Mercha Kefula', meaning: 'double lengthener', role: 'conjunctive', note: 'A double mercha.' },
  [TAAM.DARGA]:         { he: 'דַּרְגָּא', en: 'Darga', meaning: 'step / staircase', role: 'conjunctive', note: 'A rising run, "staircase".' },
  [TAAM.QADMA]:         { he: 'קַדְמָא', en: 'Qadma (Azla)', meaning: 'advancing / going before', role: 'conjunctive', note: 'A quick rise forward.' },
  [TAAM.TELISHA_QETANA]:{ he: 'תְּלִישָׁא קְטַנָּה', en: 'Telisha Qetana', meaning: 'small detached / plucked-off', role: 'conjunctive', note: 'A small high ornament at a phrase end.' },
  [TAAM.YERACH]:        { he: 'יֶרַח בֶּן יוֹמוֹ', en: 'Yerach ben Yomo', meaning: 'moon a day old (crescent)', role: 'conjunctive', note: 'A low connective (rare).' },
  [TAAM.OLE]:           { he: 'עוֹלֶה', en: 'Ole', meaning: 'ascending / rising', role: 'conjunctive', note: 'Ascending accent.' },
  [TAAM.ILUY]:          { he: 'עִלּוּי', en: 'Iluy', meaning: 'elevation / ascending', role: 'conjunctive', note: 'Ascending accent.' },
  [TAAM.ATNAH_HAFUKH]:  { he: 'אתנח הפוך', en: 'Atnah Hafukh', meaning: 'inverted etnachta (pause)', role: 'disjunctive', note: 'Etnachta-like pause (poetic books).' },
};

// Special virtual motif for the final word of a verse (silluq / sof pasuk):
// a descent to rest firmly on the tonic.
export const SOF_PASUK_MOTIF = [{ t: 0, p: 3 }, { t: 0.4, p: 1 }, { t: 0.7, p: -1 }, { t: 1, p: -3 }];
export const SOF_PASUK_NAME = { he: 'סוֹף פָּסוּק', en: 'Sof Pasuk (Silluq)', meaning: 'end of the verse (Silluq: removal)', role: 'disjunctive', note: 'End of verse; the melody comes to rest on the tonic.' };

// Default motif when a word carries no detectable accent (e.g., maqaf-joined).
const DEFAULT_MOTIF = [{ t: 0, p: 0 }, { t: 1, p: 0 }];

export function motifFor(taamCp) {
  return M[taamCp] || DEFAULT_MOTIF;
}

export function nameFor(taamCp) {
  return NAMES[taamCp] || { he: '—', en: 'Unaccented', meaning: '', role: 'none', note: 'No cantillation mark; sustain the tone.' };
}

// Build the melody for a line (array of word tokens). Returns an array of
// segments: { token, index, taam, name, contour, isSofPasuk }.
export function buildLineMelody(tokens) {
  const segs = [];
  tokens.forEach((token, i) => {
    const isLast = i === tokens.length - 1;
    let taam = primaryTaam(token);
    let contour, name;
    if (isLast) {
      contour = SOF_PASUK_MOTIF;
      name = SOF_PASUK_NAME;
      taam = 'sof';
    } else if (taam != null) {
      contour = motifFor(taam);
      name = nameFor(taam);
    } else {
      contour = DEFAULT_MOTIF;
      name = nameFor(null);
    }
    segs.push({
      token, index: i, taam, name, contour, isSofPasuk: isLast,
      color: NEUTRAL, familyId: 'none',
      syllables: countSyllables(token),
    });
  });

  // Contextual coloring: walk right-to-left so each connector (conjunctive or
  // unaccented word) inherits the color/family of the disjunctive it leads into,
  // visually pairing connectors with their governing accent.
  let nextColor = NEUTRAL, nextFam = 'none';
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    const isDisj = seg.isSofPasuk || seg.name.role === 'disjunctive';
    if (isDisj) {
      seg.color = colorFor(seg.taam);
      seg.familyId = familyIdFor(seg.taam);
      seg.isConnector = false;
      nextColor = seg.color;
      nextFam = seg.familyId;
    } else {
      // Connector: same hue as its governing disjunctive, but muted.
      seg.color = muteColor(nextColor);
      seg.familyId = nextFam;
      seg.isConnector = true;
    }
  }
  return segs;
}

// Flatten line segments into a single time-normalized contour (0..1 over the
// whole line) of { t, p } points, giving each word an equal time slice.
export function flattenMelody(segs) {
  const n = segs.length || 1;
  const pts = [];
  segs.forEach((seg, i) => {
    const t0 = i / n;
    const w = 1 / n;
    seg.contour.forEach((c) => {
      pts.push({ t: t0 + c.t * w, p: c.p, word: i });
    });
  });
  return pts;
}

// Convert a semitone offset to frequency given a tonic in Hz.
export function semitoneToFreq(tonicHz, semitones) {
  return tonicHz * Math.pow(2, semitones / 12);
}

// Split line segments into phrases, breaking after each disjunctive accent
// (a pause) or the end of the verse.
export function splitPhrases(segs) {
  const phrases = [];
  let cur = [];
  segs.forEach((seg) => {
    cur.push(seg);
    if (seg.name.role === 'disjunctive' || seg.isSofPasuk) {
      phrases.push(cur);
      cur = [];
    }
  });
  if (cur.length) phrases.push(cur);
  return phrases;
}

// Flatten an arbitrary list of segments (a word, phrase, or whole line) into a
// contour normalized to 0..1 across just those segments.
export function contourOf(segs) {
  return flattenMelody(segs);
}
