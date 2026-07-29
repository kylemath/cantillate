// Level progression. Early levels give every aid (vowels, cantillation marks,
// modern font) and simply "hear & repeat". As the learner's scores rise, the
// unit grows (word -> phrase -> line) and aids are removed one at a time until
// the text is read from a bare scroll-style form, as in a real Torah reading.
//
// Scores are NEVER summed into a single verse number. Instead each layer keeps
// its own accuracy: every word, every phrase, and the whole verse — and the
// whole verse is tracked separately per "skill" (`skill` below) as the aids fall
// away, so removing helpers is a distinct challenge you improve independently
// (typically ~90 with aids, dropping to the high/mid 80s bare). Difficulty comes
// naturally from removing aids, not from an artificial weighting.

import { RANK } from './trope.js';

// How finely a verse is cut up, expressed as the weakest accent rank that still
// ends a unit (see splitAtRank in trope.js). The multi-word stages pick a default
// from this table, and the practice pane lets the reader slide between them so a
// long pasuk can be drilled in halves before the whole thing is attempted.
export const DIVIDE = { HALF: RANK.EMPEROR, MEASURE: RANK.KING, CLAUSE: RANK.DUKE, PHRASE: RANK.COUNT };

// The ladder of divisions offered by the "Divide" control, coarsest last, each
// with the sung unit it produces.
export const DIVISIONS = [
  { key: 'phrase', rank: DIVIDE.PHRASE, label: 'Phrases', hint: 'Every pause \u2014 the smallest musical gesture.' },
  { key: 'clause', rank: DIVIDE.CLAUSE, label: 'Clauses', hint: 'Phrases joined under each Revia / Zarqa / Pashta.' },
  { key: 'section', rank: DIVIDE.MEASURE, label: 'Sections', hint: 'The Zaqef / Tipcha measures \u2014 the verse in thirds.' },
  { key: 'half', rank: DIVIDE.HALF, label: 'Halves', hint: 'The two halves of the verse, split at the Etnachta.' },
];

export function divisionByRank(rank) {
  return DIVISIONS.find((d) => d.rank === rank) || DIVISIONS[0];
}

export const LEVELS = [
  {
    id: 1, label: 'Listen & Repeat (words)', short: 'Words',
    unit: 'word', mode: 'listen',
    aids: { showVowels: true, showTaamim: true, scroll: false },
    threshold: 55,
    desc: 'Hear each word, then sing it back. All aids shown.',
  },
  {
    id: 2, label: 'Sing the words (cued)', short: 'Words · cue',
    unit: 'word', mode: 'perform',
    aids: { showVowels: true, showTaamim: true, scroll: false },
    threshold: 60,
    desc: 'Generate each word yourself, guided by the moving cue.',
  },
  {
    id: 3, label: 'Sing the phrases', short: 'Phrases',
    unit: 'phrase', mode: 'perform', divide: DIVIDE.PHRASE,
    aids: { showVowels: true, showTaamim: true, scroll: false },
    threshold: 62,
    desc: 'Chain words into phrases (up to the next pause).',
  },
  {
    id: 4, label: 'Sing the sections', short: 'Sections',
    unit: 'section', mode: 'perform', divide: DIVIDE.MEASURE,
    aids: { showVowels: true, showTaamim: true, scroll: false },
    threshold: 63,
    desc: 'Join the phrases into the verse\u2019s own musical sections \u2014 the halves and thirds marked by the strong accents \u2014 before attempting the whole pasuk.',
  },
  {
    id: 5, label: 'Sing the whole line', short: 'Whole',
    unit: 'line', mode: 'perform', skill: 'base',
    aids: { showVowels: true, showTaamim: true, scroll: false },
    threshold: 65,
    desc: 'Perform the full verse with all aids.',
  },
  {
    id: 6, label: 'Drop the cantillation marks', short: 'No tropes',
    unit: 'line', mode: 'perform', skill: 'notaamim',
    aids: { showVowels: true, showTaamim: false, scroll: false },
    threshold: 65,
    desc: 'Same verse, but the te\u2019amim are hidden. Recall the melody.',
  },
  {
    id: 7, label: 'Drop the vowels', short: 'No vowels',
    unit: 'line', mode: 'perform', skill: 'novowels',
    aids: { showVowels: false, showTaamim: false, scroll: false },
    threshold: 68,
    desc: 'Consonants only, modern font. Recall the vowels and the tune.',
  },
  {
    id: 8, label: 'Read from the scroll', short: 'Scroll',
    unit: 'line', mode: 'perform', skill: 'scroll',
    aids: { showVowels: false, showTaamim: false, scroll: true },
    threshold: 70,
    desc: 'Torah-scroll (STA\u201dM) letters, no aids \u2014 the real thing.',
  },
  {
    id: 9, label: 'Read from a Torah column', short: 'Column',
    unit: 'line', mode: 'perform', skill: 'column',
    aids: { showVowels: false, showTaamim: false, scroll: true },
    threshold: 72,
    scrollColumn: true,
    desc: 'The whole reading as a continuous, justified Torah-scroll column \u2014 no verse numbers, no line breaks to guide you.',
  },
];

// The whole-verse "skills" — one accuracy score each, in increasing difficulty.
// `base` is the foundation full-verse score; the rest are extra handicap badges
// earned over and above it as each aid is removed.
export const VERSE_MODES = [
  { key: 'base',     label: 'Full verse',   short: 'Full',    level: 5 },
  { key: 'notaamim', label: 'No tropes',    short: 'No trope', level: 6 },
  { key: 'novowels', label: 'No vowels',    short: 'No vowel', level: 7 },
  { key: 'scroll',   label: 'Scroll script', short: 'Scroll', level: 8 },
  { key: 'column',   label: 'Torah column', short: 'Column',  level: 9 },
];

// The first whole-verse stage. Anything below it is a sub-verse drill; anything
// from here up is a full-pasuk performance under a shrinking set of aids.
export const FULL_VERSE_LEVEL = 5;

export function levelById(id) {
  return LEVELS.find((l) => l.id === id) || LEVELS[0];
}

// The verse-skill key a stage records into (null for word/phrase stages).
export function skillForLevel(level) {
  return level.skill || null;
}
