// Transliteration: pointed Hebrew -> Latin letters, for a reader who has the
// tune but not yet the alphabet.
//
// The scheme is the popular Sephardi/Israeli one a reader will recognise from a
// bencher or a siddur ("v'ahavta l'rei-akha kamokha"), NOT an academic
// romanisation (SBL's "wĕʾāhabtā" helps nobody stand up and chant). It is a
// reading aid, so where the two conflict, legibility wins over reversibility:
//
//   * a dagesh chazak is NOT written as a doubled letter — "hadvarim", not
//     "haddevarim": the doubling reads as a stumble to a beginner and changes
//     nothing about how the word is sung;
//   * silent letters (final heh, quiescent alef/ayin) are dropped rather than
//     given a placeholder, so "Moshe", not "Mosheh";
//   * a vocal sheva is an apostrophe, which is what every bencher does.
//
// This runs at render time rather than being baked into data/, because the app
// opens ANY passage of the Tanakh on demand (see js/tanakh.js) — there is no
// fixed corpus to pre-transliterate. Every result is memoised by raw token, so
// re-rendering a verse on each highlight change costs one Map lookup per word.
//
// One rule here is genuinely ambiguous without a lexicon and is decided by the
// usual positional heuristics, so it will occasionally be wrong: whether a
// sheva is na (a muttered vowel) or nach (a bare syllable break). The other
// classic ambiguity — qamats gadol vs qatan — costs us nothing, because the
// Sefaria MAM text spells the qatan with its own codepoint (U+05C7) instead of
// leaving it to be guessed.

import { splitClusters } from './hebrew.js';

// --- Codepoints -------------------------------------------------------------

const SHEVA = '\u05B0';
const HATAF_SEGOL = '\u05B1', HATAF_PATACH = '\u05B2', HATAF_QAMATS = '\u05B3';
const HIRIQ = '\u05B4', TSERE = '\u05B5', SEGOL = '\u05B6';
const PATACH = '\u05B7', QAMATS = '\u05B8', HOLAM = '\u05B9';
const QUBUTS = '\u05BB', DAGESH = '\u05BC', QAMATS_QATAN = '\u05C7';
const SHIN_DOT = '\u05C1', SIN_DOT = '\u05C2';
const MAQAF = '\u05BE';

const ALEF = '\u05D0', HEH = '\u05D4', VAV = '\u05D5', CHET = '\u05D7';
const YOD = '\u05D9', AYIN = '\u05E2', SHIN = '\u05E9';

// Vowels that make a full syllable nucleus (a sheva is deliberately absent).
const FULL_VOWELS = SEGOL + PATACH + QAMATS + HIRIQ + TSERE + HOLAM + QUBUTS
  + HATAF_SEGOL + HATAF_PATACH + HATAF_QAMATS + QAMATS_QATAN;

// Vowels long enough that a following sheva opens a new syllable (sheva na).
const LONG_VOWELS = QAMATS + TSERE + HOLAM;

const VOWEL_SOUND = {
  [PATACH]: 'a', [QAMATS]: 'a', [HATAF_PATACH]: 'a', [HATAF_QAMATS]: 'o',
  [SEGOL]: 'e', [TSERE]: 'e', [HATAF_SEGOL]: 'e',
  [HIRIQ]: 'i', [HOLAM]: 'o', [QAMATS_QATAN]: 'o', [QUBUTS]: 'u',
};

// Consonants in their default (no-dagesh) reading. Begadkefat hardening, the
// shin/sin dot and the silent letters are all handled separately below.
const CONSONANT = {
  [ALEF]: '',      // alef — carries a vowel, has no sound of its own
  '\u05D1': 'v',   // bet, soft
  '\u05D2': 'g',
  '\u05D3': 'd',
  [HEH]: 'h',
  [VAV]: 'v',
  '\u05D6': 'z',
  [CHET]: 'ch',
  '\u05D8': 't',
  [YOD]: 'y',
  '\u05DA': 'kh', '\u05DB': 'kh',  // final kaf, kaf — soft
  '\u05DC': 'l',
  '\u05DD': 'm', '\u05DE': 'm',
  '\u05DF': 'n', '\u05E0': 'n',
  '\u05E1': 's',
  [AYIN]: '',      // ayin — silent in this scheme, like alef
  '\u05E3': 'f', '\u05E4': 'f',    // final pe, pe — soft
  '\u05E5': 'tz', '\u05E6': 'tz',
  '\u05E7': 'k',
  '\u05E8': 'r',
  [SHIN]: 'sh',    // refined by the shin/sin dot
  '\u05EA': 't',
};

// The letters whose sound hardens under a dagesh.
const BEGADKEFAT = {
  '\u05D1': 'b', '\u05D2': 'g', '\u05D3': 'd',
  '\u05DB': 'k', '\u05DA': 'k', '\u05E4': 'p', '\u05E3': 'p',
  '\u05EA': 't',
};

// The letters with no sound of their own, which a vowel simply rests on.
const SILENT = new Set([ALEF, AYIN]);

const isBase = (ch) => {
  const cp = ch.codePointAt(0);
  return cp >= 0x05D0 && cp <= 0x05EA;
};

// The tetragrammaton is pointed with the vowels of the word actually SAID, not
// of the letters written, so transliterating it mechanically produces nonsense
// ("Y'hovah"). It is spoken as Adonai, and that is what the reader needs to
// see. Matched on the consonants alone, so every pointing variant is caught.
const SHEM = 'Adonai';
const YHVH = YOD + HEH + VAV + HEH;

// --- Cluster model ----------------------------------------------------------

// One Hebrew consonant with everything hanging off it. Cantillation marks are
// dropped here: they carry the melody, not the pronunciation.
function clustersOf(token) {
  const out = [];
  for (const raw of splitClusters(token)) {
    const marks = raw.replace(/[\u0591-\u05AF]/g, '');
    const letter = [...marks].find(isBase);
    if (!letter) continue;
    out.push({
      letter,
      dagesh: marks.includes(DAGESH),
      sheva: marks.includes(SHEVA),
      sinDot: marks.includes(SIN_DOT),
      shinDot: marks.includes(SHIN_DOT),
      vowel: [...marks].find((c) => FULL_VOWELS.includes(c)) || '',
    });
  }
  return out;
}

// A bare letter — no vowel and no sheva of its own — is a candidate for being
// part of the PREVIOUS syllable's vowel rather than a sound in its own right.
const isBare = (cl) => !!cl && !cl.vowel && !cl.sheva;

// Is this cluster a mater lectionis: a consonant letter spelling out a vowel?
// Returns the sound it contributes (often none, because the vowel it spells has
// already been emitted by the letter before it), or null if it is a real
// consonant.
//
//   holam male   מוֹל   vav carrying a holam, nothing vowelled before it  -> "o"
//   shuruk       וּבֵין  vav carrying only a dagesh                        -> "u"
//   hiriq male   דְּבָרִים yod after a hiriq   -> silent, the hiriq already said "i"
//   tsere male   בֵּית   yod after a tsere    -> silent, see vowelSound's "ei"
//   -av ending   דְּרָכָיו the yod of the "his ..." plural suffix is not sounded
//   final -ai    אֲדֹנָי  a closing yod after an a-vowel is the "i" of "Adonai"
function materSound(cl, prev, next, last) {
  if (cl.letter === VAV && cl.vowel === HOLAM && !prev.vowel) return 'o';
  if (cl.letter === VAV && isBare(cl) && cl.dagesh) return 'u';
  if (cl.letter !== YOD || !isBare(cl) || cl.dagesh) return null;
  if (next && next.letter === VAV && isBare(next) && !next.dagesh) return '';
  if (prev.vowel === HIRIQ || prev.vowel === TSERE || prev.vowel === SEGOL) return '';
  if (last && (prev.vowel === QAMATS || prev.vowel === PATACH)) return 'i';
  return null;
}

// The consonant's own sound, before any vowel.
function consonantSound(cl) {
  const l = cl.letter;
  if (l === SHIN) return cl.sinDot ? 's' : 'sh';
  if (cl.dagesh && BEGADKEFAT[l]) return BEGADKEFAT[l];
  return CONSONANT[l] != null ? CONSONANT[l] : '';
}

// Is the sheva on cluster `i` vocal (a muttered "e") or silent (a syllable
// break)? The classical rules, in the order they apply. AMBIGUOUS: a handful of
// words break these — notably some segolates — and only a lexicon settles them.
function shevaIsVocal(cls, i) {
  const cl = cls[i];
  if (!cl.sheva) return false;
  // A word-final sheva is always silent (a final kaf keeps a written one).
  if (i === cls.length - 1) return false;
  // A word-initial sheva is vocal.
  if (i === 0) return true;
  const prev = cls[i - 1];
  // Two in a row: the first closes a syllable, the second opens the next.
  if (prev.sheva) return true;
  // After a long vowel the syllable is open, so the sheva must start the next.
  if (prev.vowel && LONG_VOWELS.includes(prev.vowel)) return true;
  // A dagesh chazak splits its letter across two syllables, so the sheva under
  // it is vocal. A dagesh kal in a begadkefat after a closed syllable is not.
  if (cl.dagesh && !BEGADKEFAT[cl.letter]) return true;
  return false;
}

// A furtive patach: a patach written UNDER a final ח / ע / ה sounds BEFORE that
// letter rather than after it — רוּחַ is "ruach", not "rucha".
function isFurtive(cls, i) {
  const cl = cls[i];
  if (i !== cls.length - 1 || cl.vowel !== PATACH) return false;
  return cl.letter === CHET || cl.letter === AYIN || cl.letter === HEH;
}

// A tsere spelled with a following yod is the "ei" of "beit"; a bare one is the
// "e" of "Yisrael". Everything else reads straight off the table.
function vowelSound(cls, i) {
  const cl = cls[i];
  const next = cls[i + 1];
  if (cl.vowel === TSERE && next && next.letter === YOD && isBare(next)) return 'ei';
  return VOWEL_SOUND[cl.vowel] || '';
}

// --- The transliterator -----------------------------------------------------

function build(token) {
  // The tokenizer keeps the maqaf on the leading word and the sof-pasuk on the
  // last, so the punctuation is peeled off here and the joiner re-attached.
  const joiner = token.includes(MAQAF) ? '-' : '';
  const cls = clustersOf(token.replace(/[\u05BE\u05C0\u05C3\u05C6]/g, ''));
  if (!cls.length) return '';

  // The Name, bare or under a one-letter prefix (לַיהוָה, וַיהוָה): the prefix
  // is sounded, the four letters that follow are read as Adonai.
  const letters = cls.map((c) => c.letter).join('');
  const shemAt = letters === YHVH ? 0 : (cls.length === 5 && letters.slice(1) === YHVH ? 1 : -1);

  let out = '';
  for (let i = 0; i < cls.length; i++) {
    // A prefix ending in its own vowel would run straight into the capital A
    // ("laAdonai"), so the join is marked the way every other swallowed seam is.
    if (i === shemAt) { out += (out && !out.endsWith("'") ? "'" : '') + SHEM; break; }
    const cl = cls[i];
    const prev = cls[i - 1] || {};

    const mater = materSound(cl, prev, cls[i + 1], i === cls.length - 1);
    if (mater !== null) { out += mater; continue; }

    // A final heh with no vowel and no mappiq is silent: it is only there to
    // spell the vowel before it (מֹשֶׁה is "Moshe").
    if (cl.letter === HEH && i === cls.length - 1 && isBare(cl) && !cl.dagesh) continue;

    if (isFurtive(cls, i)) { out += 'a' + consonantSound(cl); continue; }

    // Two vowels meeting across a silent alef/ayin would run together into one
    // unreadable blur ("baarava"), so the swallowed letter leaves an apostrophe
    // where the reader's glottis actually does something: "ba'arava".
    if (SILENT.has(cl.letter) && cl.vowel && prev.vowel && out && !out.endsWith("'")) out += "'";

    out += consonantSound(cl);

    if (cl.vowel) out += vowelSound(cls, i);
    else if (shevaIsVocal(cls, i)) out += SILENT.has(cl.letter) ? 'e' : "'";
  }

  // An apostrophe can neither open nor close a word, and a doubled one is noise.
  out = out.replace(/'{2,}/g, "'").replace(/^'+/, '').replace(/'+$/, '');
  return out ? out + joiner : '';
}

const cache = new Map();
const CACHE_MAX = 20000; // a whole parashah is a few thousand distinct tokens

// Transliterate one Masoretic token. Memoised, so it is safe to call once per
// word on every re-render.
export function transliterate(token) {
  if (!token) return '';
  const hit = cache.get(token);
  if (hit !== undefined) return hit;
  let out = '';
  try { out = build(token); } catch (e) { out = ''; }
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(token, out);
  return out;
}
