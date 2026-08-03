// What to practise next.
//
// Expert mode hands the reader nine stages and a verse list and lets them choose.
// Guided mode has to choose FOR them, one thing at a time, and the choice is most
// of what makes the difference between a reader who improves and one who merely
// accumulates. Two failure modes to avoid:
//
//   * marching forward only. Verse 1 gets nine stages of attention and verse 24
//     gets none, and the words that were shaky in week one are still shaky in
//     week eight because nothing ever came back to them.
//   * drilling the weakest thing forever. A reader who never reaches a new pasuk
//     has no sense of progress, and the joins between pesukim — where a long
//     reading actually falls apart — never get rehearsed at all.
//
// So the schedule alternates deliberately between three moves: ADVANCE (the next
// thing not yet done), REPAIR (something already attempted that scored badly, or
// scored well enough to pass but not well enough to stand up with), and COMBINE
// (chain what is known into longer runs, up to the whole part). The pattern is
// fixed enough to feel like a plan and jittered enough not to feel like a loop.

import * as store from './store.js';
import { LEVELS, FULL_VERSE_LEVEL, VERSE_MODES } from './levels.js';

// The nine stages, grouped into rounds. A round is a coherent thing to be told to
// do ("sing the words", "read it from the scroll"); nine numbered stages are not,
// and naming them all up front is exactly the complication guided mode exists to
// remove.
//
// The last round carries no stages, because the work it names is not a stage of a
// pasuk: it is the pesukim chanted in runs, and then the part end to end. That was
// once folded into the round above it, which meant a reader could be shown four
// full bars — the whole plan complete — with most of the joins in the reading still
// unrehearsed. It is a round of its own so that the work is counted where it is
// done.
export const ROUNDS = [
  {
    id: 1, key: 'words', label: 'Words', icon: '\u{1f524}',
    levels: [1, 2],
    goal: 'Hear each word, then sing it back',
    blurb: 'One word at a time, with the cantor to copy. Everything is shown.',
  },
  {
    id: 2, key: 'phrases', label: 'Phrases', icon: '\u{1f3b5}',
    levels: [3, 4],
    goal: 'Join the words into phrases',
    blurb: 'The accents group the words into musical phrases. Chant them whole.',
  },
  {
    id: 3, key: 'pesukim', label: 'Pesukim', icon: '\u{1f4d6}',
    levels: [5, 6, 7],
    goal: 'Chant each pasuk on your own',
    blurb: 'The whole pasuk, then again with the helps taken away one at a time.',
  },
  {
    id: 4, key: 'scroll', label: 'The scroll', icon: '\u{1f4dc}',
    levels: [8, 9],
    goal: 'Read each pasuk from the scroll',
    blurb: 'Bare scroll letters, no vowels, no accents \u2014 the real thing, a pasuk at a time.',
  },
  {
    id: 5, key: 'together', label: 'Together', icon: '\u{1f517}',
    levels: [],
    goal: 'Chant the pesukim in runs, then the whole thing',
    blurb: 'Two pesukim without stopping, then three, then four \u2014 each run with the '
      + 'vowels first and then off the bare scroll \u2014 and then the part end to end.',
  },
];

// The rounds one pasuk goes through. A single pasuk cannot be chanted "in a run",
// so the per-pasuk views — the ticks on a pasuk, the round a stage belongs to —
// count the four that name stages rather than all five.
export const VERSE_ROUNDS = ROUNDS.filter((r) => r.levels.length);

export function roundById(id) { return ROUNDS.find((r) => r.id === id) || ROUNDS[0]; }

export function roundOfLevel(level) {
  return ROUNDS.find((r) => r.levels.includes(level)) || VERSE_ROUNDS[VERSE_ROUNDS.length - 1];
}

// Has this pasuk finished with this round?
//
// Passing a stage unlocks the next one, so for every round but the last "cleared"
// is simply "unlocked past its final stage". The ninth stage has nothing above it
// to unlock — the store caps at LEVELS.length — so the top round is judged on the
// score that stage actually recorded instead. Without that, round 4 could never
// complete and the reader would be told they were three quarters done forever.
function clearedRound(ctx, verse, round) {
  const last = round.levels[round.levels.length - 1];
  if (levelOf(ctx, verse) > last) return true;
  if (last < LEVELS.length) return false;
  const mode = VERSE_MODES.find((m) => m.level === last);
  const level = LEVELS.find((l) => l.id === last);
  if (!mode || !level) return false;
  const best = store.getVerseModeScores(ctx.slug, verse)[mode.key] || 0;
  return best >= level.threshold;
}

// Below this, a stored best is a weakness worth going back to before anything
// else. Above REPAIR_POLISH it is good enough that repeating it teaches little.
const REPAIR_WEAK = 70;
const REPAIR_POLISH = 88;

// Chains (runs of consecutive pesukim) become available once this many adjacent
// pesukim can each be chanted whole, and are worth revisiting below this score.
const CHAIN_MIN = 2;
const CHAIN_MAX = 4;
const CHAIN_GOOD = 80;

// Every run is asked for twice, from an easier surface and then from the real
// one. Chaining is where two hard things arrive at once: the joins between
// pesukim, which is the work of this round, and reading unpointed letters at
// speed across a verse boundary, which is the work of the round below. Asked to
// do both in the same take a reader loses the joins to the letters. So the run
// is first chanted from the pointed text — vowels and accents in front of them,
// nothing to decode, all the attention on not stopping at the seam — and only
// once that run is solid is the same run asked for again off the bare scroll.
//
// A scroll run implies the pointed one (it is the same pesukim, read harder),
// so passing the scroll tier never sends the reader back down to the pointed
// one — which is also what keeps a reader who chained before this ramp existed
// from watching their fifth round go backwards.
export const CHAIN_SURFACES = [
  { key: 'pointed', label: 'with the vowels', text: 'pointed' },
  { key: 'stam', label: 'from the scroll', text: 'stam' },
];

// Every run of consecutive pesukim the chaining round is asking for: each length
// from CHAIN_MIN to CHAIN_MAX, at every position it will fit. Runs overlap, which
// is the point — the join between two pesukim is a thing to be practised, and
// cutting the reading into fixed runs instead would leave most of the joins inside
// no run at all. `list` is verse numbers in order; a gap in them ends a run,
// so a caller can pass the pesukim that are ready rather than all of them.
function chainWindows(list) {
  const out = [];
  let block = [];
  const flush = () => {
    for (let size = CHAIN_MIN; size <= CHAIN_MAX; size++) {
      for (let i = 0; i + size <= block.length; i++) {
        out.push({ start: block[i], end: block[i + size - 1], size });
      }
    }
    block = [];
  };
  for (const n of list) {
    if (!block.length || n === block[block.length - 1] + 1) block.push(n);
    else { flush(); block = [n]; }
  }
  flush();
  return out;
}

// The best score that counts towards one tier of one run. The scroll tier counts
// only scroll takes; the pointed tier counts either, since a run read off the
// scroll is the pointed run and more.
function chainBest(ctx, start, end, surface) {
  const stam = store.getChainScore(ctx.slug, start, end, 'stam');
  if (surface === 'stam') return stam;
  return Math.max(stam, store.getChainScore(ctx.slug, start, end, surface));
}

// The rotation. Read left to right, wrapping; the first move with something to
// offer wins, so early on (nothing yet attempted, nothing to chain) it collapses
// to pure advance, and it fills out on its own as the reader accumulates work.
const PATTERN = ['advance', 'advance', 'repair', 'advance', 'combine',
  'advance', 'repair', 'advance', 'combine', 'repair'];

// --- Context ----------------------------------------------------------------
// Everything the scheduler needs about the part being learned. `chunk` is the
// whole-part challenge (an aliyah/maftir/haftarah descriptor as app.js builds
// them); `unitCount(verse, level)` reports how many words/phrases/sections a
// stage cuts that pasuk into, which only the caller can compute (it needs the
// text), and may return 1 when unknown.

export function makeContext({ slug, verses, cycle = 'annual', triYear = 1,
  chunk = null, unitCount = null }) {
  return {
    slug,
    verses: (verses || []).slice(),
    cycle,
    triYear,
    chunk,
    unitCount: unitCount || (() => 1),
  };
}

// --- Reading the state ------------------------------------------------------

export function levelOf(ctx, verse) {
  return store.getVerseLevel(ctx.slug, verse);
}

// How far through the whole part each round is: how many of its pesukim have
// cleared the round, out of all of them.
export function roundProgress(ctx, round) {
  if (!round.levels.length) return chainProgress(ctx, round);
  const total = ctx.verses.length;
  const done = ctx.verses.filter((n) => clearedRound(ctx, n, round)).length;
  return { round, done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// The chaining round, counted in the units it is actually made of: every run of
// pesukim in the part at both surfaces, plus the part chanted through in one go
// as the last box on the whole plan. Pesukim not yet chantable whole are counted
// in the total anyway — their runs are work the reader still has coming, and a
// denominator that grew as they became ready would make the bar go backwards.
function chainProgress(ctx, round) {
  const windows = chainWindows(ctx.verses);
  const score = wholeScore(ctx);
  const wholeDone = score >= CHAIN_GOOD;
  const total = windows.length * CHAIN_SURFACES.length + (ctx.chunk ? 1 : 0);
  let done = ctx.chunk && wholeDone ? 1 : 0;
  for (const w of windows) {
    for (const s of CHAIN_SURFACES) {
      if (chainBest(ctx, w.start, w.end, s.key) >= CHAIN_GOOD) done += 1;
    }
  }
  return {
    round, done, total, wholeScore: score, wholeDone,
    // A part with nothing to chain (one pasuk, no whole-part challenge) has
    // nothing outstanding either, and must not hold the plan at 80% forever.
    pct: total ? Math.round((done / total) * 100) : 100,
  };
}

// How far ONE pasuk has got, round by round. The part-level bars answer "how much
// is done"; a reader whose first pasuk was passed over asks the narrower question —
// what about that one — and has to be able to see the answer and act on it.
export function verseProgress(ctx, verse) {
  const cleared = VERSE_ROUNDS.map((r) => clearedRound(ctx, verse, r));
  const done = cleared.filter(Boolean).length;
  return {
    verse,
    cleared,
    done,
    total: VERSE_ROUNDS.length,
    pct: Math.round((done / VERSE_ROUNDS.length) * 100),
    round: VERSE_ROUNDS[Math.min(done, VERSE_ROUNDS.length - 1)],
    started: levelOf(ctx, verse) > 1,
  };
}

// The work a pasuk is up to, for a reader who asks for it by name instead of being
// handed the next thing. At its OWN frontier rather than the part's: a pasuk two
// rounds ahead of its neighbours should carry on from where it got to, and one left
// behind should pick up where it stopped.
export function taskForVerse(ctx, verse) {
  const level = Math.min(Math.max(levelOf(ctx, verse), 1), LEVELS.length);
  return { kind: 'verse', verse, level, reason: 'chosen', round: roundOfLevel(level).id };
}

// The task a part OPENS with: its first pasuk, at the round the part is working.
//
// "The next thing not yet done" is the right choice for every task after this one
// and the wrong one for this one. A reader who has just chosen an aliyah is asking
// to sing that aliyah; being dropped three pesukim in because the earlier ones are
// already on record reads as the app having mislaid their place, and it is no answer
// that the pesukim it skipped were finished ones.
//
// Clamped to the current round, so opening a part is never harder than the round the
// reader is in: a first pasuk that has run ahead of its neighbours comes back at
// this round's work rather than handing them a Torah column to read cold. In the
// chaining round there is no stage to clamp to and no need for one — every pasuk has
// been through all nine by then — so the pasuk opens at its own.
export function openingTask(ctx) {
  const verse = (ctx.verses || [])[0];
  if (verse == null || finished(ctx)) return null;
  const round = currentRound(ctx);
  const own = Math.min(Math.max(levelOf(ctx, verse), 1), LEVELS.length);
  const level = round.levels.length
    ? Math.min(Math.max(own, round.levels[0]), round.levels[round.levels.length - 1])
    : own;
  return { kind: 'verse', verse, level, reason: 'start', round: roundOfLevel(level).id };
}

// Whether there is anything left to hand out at all, under any move. Asked before
// forcing a part open at its first pasuk, so a finished part still says it is
// finished instead of starting over.
export function finished(ctx) {
  return nextTask(ctx, { session: 0 }) === null;
}

export function wholeScore(ctx) {
  if (!ctx.chunk) return 0;
  return store.getAliyahScore(ctx.slug, ctx.cycle, ctx.triYear, ctx.chunk.n);
}

// The round the reader is on: the first one not yet finished. Once everything is
// finished it stays on the last, where the work becomes polishing.
export function currentRound(ctx) {
  for (const r of ROUNDS) {
    const p = roundProgress(ctx, r);
    if (p.pct < 100) return r;
  }
  return ROUNDS[ROUNDS.length - 1];
}

// Overall completion of the part, evenly across the rounds so the bar moves
// early (a reader who has sung every word of every pasuk is genuinely a quarter
// of the way, and should be shown as such).
export function overallProgress(ctx) {
  const rounds = ROUNDS.map((r) => roundProgress(ctx, r));
  const pct = Math.round(rounds.reduce((a, r) => a + r.pct, 0) / rounds.length);
  return { rounds, pct, round: currentRound(ctx) };
}

// --- Candidate moves --------------------------------------------------------

// ADVANCE: the next stage not yet cleared, taken in verse order so the reading is
// learned front to back. Confined to the current round, which is what keeps the
// reader from being handed stage 8 on pasuk 1 while pasuk 2 is untouched.
function advanceCandidates(ctx, round) {
  // The chaining round names no stages, so it has no next stage to offer: all of
  // its work is combine's.
  if (!round.levels.length) return [];
  const out = [];
  for (const n of ctx.verses) {
    if (clearedRound(ctx, n, round)) continue;
    const lvl = levelOf(ctx, n);
    // Work at the verse's own frontier, but never below the round's first stage.
    const level = Math.max(lvl, round.levels[0]);
    out.push({ kind: 'verse', verse: n, level, reason: 'advance' });
    if (out.length >= 4) break;
  }
  return out;
}

// REPAIR: something already attempted that isn't solid. Words first (they are the
// smallest fixable unit and the fastest win), then whole pesukim whose best under
// the current aids is weak. Weakness is the sort key, so the worst thing the
// reader owns is what comes back.
function repairCandidates(ctx, round, threshold) {
  const out = [];
  for (const n of ctx.verses) {
    const lvl = levelOf(ctx, n);
    if (lvl <= 1) continue; // never attempted; that's advance's job, not repair's
    const words = store.getWordScores(ctx.slug, n);
    for (const gi of Object.keys(words)) {
      const score = words[gi];
      if (score > 0 && score < threshold) {
        out.push({
          kind: 'verse', verse: n, level: 1, word: Number(gi), score,
          reason: 'repair', what: 'word',
        });
      }
    }
    // A whole-pasuk score that passed but only just: worth another take at the
    // hardest aids configuration this verse has reached.
    const modes = store.getVerseModeScores(ctx.slug, n);
    for (const md of VERSE_MODES) {
      const score = modes[md.key];
      if (score > 0 && score < threshold && md.level <= lvl) {
        out.push({
          kind: 'verse', verse: n, level: md.level, score,
          reason: 'repair', what: 'verse',
        });
      }
    }
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}

// The rung directly above a run that has just been passed: the same pesukim, read
// from the next surface up. Null when there isn't one — the run was already the
// scroll take, or the scroll take is on record too. Handed out the moment the
// pointed take passes rather than left for the rotation to come back to, because
// the pesukim are in the reader's ear right then and that is when reading them
// off the bare scroll is worth most.
export function nextChainTier(ctx, task) {
  if (!ctx || !task || task.kind !== 'chain') return null;
  const at = CHAIN_SURFACES.findIndex((s) => s.key === chainSurface(task));
  const up = CHAIN_SURFACES[at + 1];
  if (!up) return null;
  const score = chainBest(ctx, task.start, task.end, up.key);
  if (score >= CHAIN_GOOD) return null;
  return {
    kind: 'chain', start: task.start, end: task.end, size: task.size,
    surface: up.key, tier: at + 1, score, reason: 'combine',
    round: task.round || currentRound(ctx).id,
  };
}

// COMBINE: runs of consecutive pesukim that can each be chanted whole, and
// finally the whole part. This is the rung a reader most often skips and most
// often needs — knowing every pasuk cold still leaves the joins unrehearsed.
function combineCandidates(ctx, rand = Math.random) {
  // Only runs whose every pasuk can already be chanted whole: a run is for
  // practising the joins, and a pasuk that isn't there yet needs the pasuk.
  const ready = ctx.verses.filter((n) => levelOf(ctx, n) >= FULL_VERSE_LEVEL);
  const runs = [];
  for (const w of chainWindows(ready)) {
    // The lowest tier this run has not passed, and only that one: the scroll take
    // is not offered until the pointed take is solid, which is the whole point of
    // there being two of them.
    const tier = CHAIN_SURFACES.findIndex((s) => chainBest(ctx, w.start, w.end, s.key) < CHAIN_GOOD);
    if (tier < 0) continue;
    const surface = CHAIN_SURFACES[tier].key;
    runs.push({
      kind: 'chain', ...w, surface, tier,
      score: chainBest(ctx, w.start, w.end, surface), reason: 'combine',
    });
  }
  // Shortest first, then the pointed take before the scroll one, then unpractised
  // before merely weak: pairs with the vowels, pairs from the scroll, then triples
  // the same way is the order the joins are actually learned in.
  // Shuffled first so that runs which are equally short and equally unpractised —
  // which, before any chaining has been done, is all of them — come out in no
  // particular order rather than front to back. The sort is stable, so this is
  // what decides between ties, and it is what keeps the reader from being handed
  // the top of the aliyah every time a chain comes up.
  shuffle(runs, rand);
  runs.sort((a, b) => (a.size - b.size) || (a.tier - b.tier) || (a.score - b.score));
  // The whole part, once every pasuk in it is ready — the same gate the aliyah
  // challenge uses in expert mode.
  if (ctx.chunk && ctx.verses.length && ready.length === ctx.verses.length) {
    const score = wholeScore(ctx);
    if (score < CHAIN_GOOD) {
      runs.push({ kind: 'whole', score, reason: 'combine' });
    }
  }
  return runs;
}

// --- Picking ----------------------------------------------------------------

// In place, so that a later stable sort keeps this order between candidates it
// considers equally worth doing.
function shuffle(list, rand) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// One of the worst few, rather than always the very worst, so a stubborn word
// doesn't become the only thing the app ever asks for.
function pickWeak(list, rand) {
  if (!list.length) return null;
  const pool = list.slice(0, Math.min(3, list.length));
  return pool[Math.floor(rand() * pool.length)];
}

// The next thing to practise, or null when the part is finished to the standard
// the schedule cares about. `session` counts tasks handed out, and is what walks
// the pattern; pass it back in (see guided.js) so a sitting keeps its rhythm.
export function nextTask(ctx, { session = 0, rand = Math.random, avoid = null } = {}) {
  const round = currentRound(ctx);
  const moves = {
    advance: () => advanceCandidates(ctx, round),
    repair: () => {
      // Genuine weaknesses first; with none, polish what merely passed. This is
      // the "improve, don't just advance" move, and it is why a reader who has
      // cleared everything still has something worthwhile offered to them.
      const weak = repairCandidates(ctx, round, REPAIR_WEAK);
      return weak.length ? weak : repairCandidates(ctx, round, REPAIR_POLISH);
    },
    combine: () => combineCandidates(ctx, rand),
  };

  // Walk the pattern from wherever this session is, taking the first move with
  // something to offer.
  const tried = new Set();
  for (let i = 0; i < PATTERN.length; i++) {
    const move = PATTERN[(session + i) % PATTERN.length];
    if (tried.has(move)) continue;
    tried.add(move);
    const list = moves[move]().filter((t) => !sameTask(t, avoid));
    if (!list.length) continue;
    const task = move === 'advance' ? list[0] : pickWeak(list, rand);
    if (task) return { ...task, round: round.id };
  }
  // Nothing left under any move: allow the thing we were told to avoid rather
  // than handing back nothing at all.
  for (const move of ['advance', 'repair', 'combine']) {
    const list = moves[move]();
    if (list.length) {
      const task = move === 'advance' ? list[0] : pickWeak(list, rand);
      if (task) return { ...task, round: round.id };
    }
  }
  return null;
}

// Two tasks are the same piece of work (used to avoid handing back what was just
// finished, and to spot when a task is already done).
export function sameTask(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'whole') return true;
  if (a.kind === 'chain') {
    return a.start === b.start && a.end === b.end && chainSurface(a) === chainSurface(b);
  }
  return a.verse === b.verse && a.level === b.level && (a.word ?? null) === (b.word ?? null);
}

// --- Describing a task ------------------------------------------------------

// What the reader is told to do. Deliberately about the WORK, not the mechanism:
// "Sing this phrase" rather than "stage 3 of 9, unit 2 of 5".
// Which surface a chain task is to be chanted from. A task from before the two
// tiers existed (or one restored from an older session) means the scroll, which
// is what a chain used to be.
export function chainSurface(task) {
  const key = task && task.surface;
  return CHAIN_SURFACES.some((s) => s.key === key) ? key : 'stam';
}

export function taskTitle(task) {
  if (!task) return '';
  if (task.kind === 'whole') return 'Chant the whole thing';
  if (task.kind === 'chain') {
    return chainSurface(task) === 'pointed'
      ? `Chant ${task.size} pesukim without stopping`
      : `Chant ${task.size} pesukim from the scroll`;
  }
  const level = LEVELS.find((l) => l.id === task.level);
  if (task.what === 'word') return 'Come back to a tricky word';
  if (!level) return 'Practise';
  if (level.unit === 'word') return task.level === 1 ? 'Listen, then sing it back' : 'Sing the words';
  if (level.unit === 'phrase') return 'Sing the phrases';
  if (level.unit === 'section') return 'Sing the longer sections';
  if (task.level === 6) return 'Sing it with the accents hidden';
  if (task.level === 7) return 'Sing it with no vowels';
  if (task.level === 8) return 'Read it in scroll letters';
  if (task.level === 9) return 'Read it from a Torah column';
  return 'Sing the whole pasuk';
}

// Why this task, in the reader's terms. The honesty matters: being told "this one
// scored 61 last time" is motivating in a way that an unexplained repeat is not.
export function taskWhy(task) {
  if (!task) return '';
  if (task.reason === 'advance') return 'Something new';
  if (task.reason === 'start') return 'From the beginning';
  if (task.reason === 'chosen') return 'You asked for this one';
  if (task.reason === 'combine') {
    if (task.kind === 'whole') return 'Everything you have learned, in one go';
    return chainSurface(task) === 'pointed'
      ? 'Practise the joins'
      : 'The same run, now off the bare scroll';
  }
  if (task.score != null) {
    return task.score < REPAIR_WEAK
      ? `Back to this \u2014 it scored ${task.score}`
      : `Polishing \u2014 your best here is ${task.score}`;
  }
  return 'Back to something earlier';
}

export const THRESHOLDS = { weak: REPAIR_WEAK, polish: REPAIR_POLISH, good: CHAIN_GOOD };
