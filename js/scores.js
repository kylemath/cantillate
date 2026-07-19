// Hierarchical scoring model: canonical scope ids + roll-up derivation.
//
// The PASUK (verse) is the atomic, cycle-independent unit. Aliyot and parashot
// are PARTITIONS (roll-ups) of pesukim. Leaderboards are always defined over a
// canonical partition so that per-user / per-cycle boundary differences never
// change how people are compared — everything reduces to pesukim.
//
// Two ways a higher-level (aliyah/parasha) score can exist:
//   - DIRECT: an actual continuous recording at that level (the real proof you
//     can chain the pesukim together without breaks).
//   - DERIVED FLOOR: a conservative estimate from the level below for someone
//     who has only practiced the smaller units. It is deliberately BELOW what a
//     real continuous take would earn (multiplied by CHAIN_PENALTY), so it is a
//     low-but-nonzero floor that motivates actually recording the chain.
//
// The displayed higher-level score is max(direct, derivedFloor): practising the
// parts gives you a starting floor; recording the whole thing lets you exceed it.

// How much a "derived from the parts" estimate is discounted vs a real take.
// Chaining is unproven until recorded continuously, so the floor sits clearly
// below a genuine performance.
export const CHAIN_PENALTY = 0.75;

// Make an arbitrary string safe to use as a Firestore document id / path segment.
export function sanitizeId(s) {
  return String(s == null ? '' : s)
    .replace(/[\/\s]+/g, '_')
    .replace(/[.#$\[\]]/g, '_');
}

// Canonical id for a pasuk: book + chapter:verse, so the SAME verse unifies
// across readings and across cycles. Falls back to the reading's chapter and the
// sequential index when a verse carries no explicit chapter/verse (single-chapter
// readings). `data` is state.data; `n` is the 1-based sequential verse index.
export function pasukIdFor(data, n) {
  const book = (data && data.book && data.book.en) || (data && data.slug) || 'book';
  const verse = data && data.verses && data.verses[n - 1];
  const c = verse && verse.c != null ? verse.c : (data && data.chapter) || 0;
  const v = verse && verse.v != null ? verse.v : n;
  return sanitizeId(`${book}:${c}:${v}`);
}

// Canonical id for a parashah: prefer its English name (stable across readings),
// else the reading slug.
export function parashaIdFor(parashah, slug) {
  const base = (parashah && (parashah.translit || parashah.en)) || slug || 'parashah';
  return sanitizeId(base);
}

// Canonical id for an aliyah within a parashah. Annual and triennial are
// genuinely different partitions, so the cycle (and triennial year) are part of
// the id. Uses the DEFAULT partition's aliyah number, never a user override.
export function aliyahIdFor(parashaId, cycle, year, n) {
  const y = cycle === 'triennial' ? year : 0;
  return sanitizeId(`${parashaId}:${cycle}:${y}:${n}`);
}

export function avg(list) {
  const v = (list || []).filter((x) => typeof x === 'number' && x > 0);
  if (!v.length) return 0;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

// Roll-up: the displayed score for a level = max(direct take, derived floor).
// The derived floor is the average of the child bests, discounted because
// chaining hasn't been proven with a continuous recording.
export function deriveScore(directScore, childScores) {
  const direct = Math.round(Number(directScore) || 0);
  const floor = Math.round(avg(childScores) * CHAIN_PENALTY);
  return Math.max(direct, floor);
}

// Convenience: is a higher-level score "real" (a continuous take) rather than
// only a derived floor? Useful for UI (e.g. a "chain it to improve" nudge).
export function isDerivedOnly(directScore, childScores) {
  const direct = Math.round(Number(directScore) || 0);
  const floor = Math.round(avg(childScores) * CHAIN_PENALTY);
  return floor >= direct && direct <= 0;
}
