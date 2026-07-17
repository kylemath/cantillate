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

export const LEVELS = [
  {
    id: 1, label: 'Listen & Repeat (words)',
    unit: 'word', mode: 'listen',
    aids: { showVowels: true, showTaamim: true, scroll: false },
    threshold: 55,
    desc: 'Hear each word, then sing it back. All aids shown.',
  },
  {
    id: 2, label: 'Sing the words (cued)',
    unit: 'word', mode: 'perform',
    aids: { showVowels: true, showTaamim: true, scroll: false },
    threshold: 60,
    desc: 'Generate each word yourself, guided by the moving cue.',
  },
  {
    id: 3, label: 'Sing the phrases',
    unit: 'phrase', mode: 'perform',
    aids: { showVowels: true, showTaamim: true, scroll: false },
    threshold: 62,
    desc: 'Chain words into phrases (up to the next pause).',
  },
  {
    id: 4, label: 'Sing the whole line',
    unit: 'line', mode: 'perform', skill: 'base',
    aids: { showVowels: true, showTaamim: true, scroll: false },
    threshold: 65,
    desc: 'Perform the full verse with all aids.',
  },
  {
    id: 5, label: 'Drop the cantillation marks',
    unit: 'line', mode: 'perform', skill: 'notaamim',
    aids: { showVowels: true, showTaamim: false, scroll: false },
    threshold: 65,
    desc: 'Same verse, but the te\u2019amim are hidden. Recall the melody.',
  },
  {
    id: 6, label: 'Drop the vowels',
    unit: 'line', mode: 'perform', skill: 'novowels',
    aids: { showVowels: false, showTaamim: false, scroll: false },
    threshold: 68,
    desc: 'Consonants only, modern font. Recall the vowels and the tune.',
  },
  {
    id: 7, label: 'Read from the scroll',
    unit: 'line', mode: 'perform', skill: 'scroll',
    aids: { showVowels: false, showTaamim: false, scroll: true },
    threshold: 70,
    desc: 'Torah-scroll (STA\u201dM) letters, no aids \u2014 the real thing.',
  },
  {
    id: 8, label: 'Read from a Torah column',
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
  { key: 'base',     label: 'Full verse',   short: 'Full',    level: 4 },
  { key: 'notaamim', label: 'No tropes',    short: 'No trope', level: 5 },
  { key: 'novowels', label: 'No vowels',    short: 'No vowel', level: 6 },
  { key: 'scroll',   label: 'Scroll script', short: 'Scroll', level: 7 },
  { key: 'column',   label: 'Torah column', short: 'Column',  level: 8 },
];

export function levelById(id) {
  return LEVELS.find((l) => l.id === id) || LEVELS[0];
}

// The verse-skill key a stage records into (null for word/phrase stages).
export function skillForLevel(level) {
  return level.skill || null;
}
