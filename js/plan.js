// "Currently learning" — the one reading a reader is actually preparing.
//
// This is deliberately NOT the reading that happens to be open, and NOT the
// parashah of the upcoming Shabbat. A boy learning for his bar mitzvah in eight
// months opens the app on a hundred different Saturdays; every one of them has
// its own parashah, and none of them is his. So the plan is stored (in the
// reader's progress, so it follows them across devices — see store.getPlan) and
// everything in guided mode is oriented around it: what to practice next, what
// the progress bars are measuring, and where the ★ in the reading menu points.
//
// A plan names WHO is learning, WHEN (which fixes the parashah, the triennial
// year and the haftarah — see js/calendar.js), HOW MUCH of the reading is being
// used (annual vs triennial), and WHICH PARTS of it they will actually chant.

import * as calendar from './calendar.js';
import * as store from './store.js';

// Why they are learning. Only the wording differs — the practice is identical —
// but the wording is most of what makes the app feel like it is for you.
export const OCCASIONS = {
  barmitzvah: {
    label: 'Bar mitzvah', article: 'his', short: 'Bar mitzvah',
    sub: 'Usually the maftir and the haftarah',
  },
  batmitzvah: {
    label: 'Bat mitzvah', article: 'her', short: 'Bat mitzvah',
    sub: 'Usually the maftir and the haftarah',
  },
  aliyah: {
    label: 'An aliyah', article: 'their', short: 'Aliyah',
    sub: 'One of the seven sections of the parashah',
  },
  learning: {
    label: 'Learning to chant', article: 'their', short: 'Learning',
    sub: 'No date yet \u2014 just want to learn',
  },
};

// Whose simcha it is. Drives the second person ("your maftir") vs the third
// ("J's maftir"), which is the difference between the app talking to the child
// and talking to the parent who set it up.
export const ROLES = {
  self: { label: "It's mine", sub: 'I\u2019m the one who will be reading' },
  family: { label: 'A family member\u2019s', sub: 'I\u2019m helping them prepare' },
  student: { label: 'My student\u2019s', sub: 'I\u2019m teaching them' },
};

// A reading is chanted either in full (the annual cycle, standard in Orthodox
// practice) or as one third of it (the triennial cycle, common in Conservative
// and Reform congregations). The reader is asked in those terms, not in ours.
export const CYCLES = {
  annual: {
    label: 'The whole parashah',
    sub: 'Annual cycle \u2014 usual in Orthodox congregations',
  },
  triennial: {
    label: 'One year\u2019s third',
    sub: 'Triennial cycle \u2014 usual in Conservative & Reform congregations',
  },
};

export const ALIYAH_NUMBERS = [1, 2, 3, 4, 5, 6, 7];

// --- Parts ------------------------------------------------------------------
// What the reader will actually stand up and chant. A bar/bat mitzvah is
// classically given the maftir (the closing pesukim, repeated) and the haftarah;
// anyone can be given one of the seven aliyot.

export function maftirPart() { return { kind: 'maftir' }; }
export function haftarahPart() { return { kind: 'haftarah' }; }
export function aliyahPart(n) { return { kind: 'aliyah', n }; }

// A stable id for a part, used as the key for "which part am I working on" and
// for the progress rows in the guided menu.
export function partId(part) {
  if (!part) return '';
  return part.kind === 'aliyah' ? `aliyah-${part.n}` : part.kind;
}

export function partFromId(id) {
  if (!id) return null;
  if (id === 'maftir') return maftirPart();
  if (id === 'haftarah') return haftarahPart();
  const m = /^aliyah-([1-7])$/.exec(id);
  return m ? aliyahPart(Number(m[1])) : null;
}

export function partLabel(part) {
  if (!part) return '';
  if (part.kind === 'maftir') return 'Maftir';
  if (part.kind === 'haftarah') return 'Haftarah';
  return `Aliyah ${part.n}`;
}

// One line saying what this part IS, for a reader who has never been told.
export function partBlurb(part) {
  if (!part) return '';
  if (part.kind === 'maftir') {
    return 'The closing pesukim of the parashah, read again \u2014 traditionally by whoever chants the haftarah.';
  }
  if (part.kind === 'haftarah') {
    return 'The reading from the Prophets that follows the Torah. Same accents, its own melody.';
  }
  return `The ${ordinal(part.n)} of the seven sections the parashah is divided into.`;
}

function ordinal(n) {
  return ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'][n] || `#${n}`;
}

// The parts a plan starts with, before the reader adjusts them. A simcha means
// the maftir and the haftarah; anything else is a single aliyah until they say
// otherwise, because offering seven at once is how a plan stops being a plan.
export function defaultParts(occasion) {
  if (occasion === 'barmitzvah' || occasion === 'batmitzvah') {
    return [maftirPart(), haftarahPart()];
  }
  if (occasion === 'aliyah') return [aliyahPart(3)];
  return [haftarahPart()];
}

// Parts in the order they are read in the service — the aliyot in turn, then the
// maftir, then the haftarah — whatever order the reader tapped them in. The order
// is a fact about the morning rather than about the wizard, and guided mode starts
// on the first part, so tapping the checkboxes in an odd order should not decide
// what gets learned first.
function servicePosition(part) {
  if (!part) return 99;
  if (part.kind === 'aliyah') return Number(part.n) || 0;
  return part.kind === 'maftir' ? 8 : 9;
}

function sortParts(parts) {
  return (parts || []).slice().sort((a, b) => servicePosition(a) - servicePosition(b));
}

// --- Building a plan --------------------------------------------------------

// The haftarah reading slug that goes with a Torah parashah slug. The manifest
// names them by construction (scripts/haftarot.py), so this is the naming rule
// rather than a table to keep in step.
export function haftarahSlugFor(slug) {
  return slug ? `haftarah-${slug}` : null;
}

// Build a plan from a Shabbat (a normalized calendar record) plus the reader's
// answers. Everything the guided UI shows about the reading is captured here, so
// the plan reads correctly even before data/calendar.json has been re-fetched.
export function fromShabbat(rec, {
  role = 'self', occasion = 'barmitzvah', learner = '',
  cycle = 'annual', parts = null, enteredDate = '',
} = {}) {
  if (!rec || !rec.slug) return null;
  const chosen = sortParts(parts && parts.length ? parts : defaultParts(occasion));
  return {
    role,
    occasion,
    learner: (learner || '').trim().slice(0, 40),
    // The date they typed, kept beside the Shabbat it resolved to, so a birthday
    // or a party date still reads back as what they entered.
    enteredDate: enteredDate || rec.date,
    date: rec.date,
    parashah: rec.parashah,
    hebrew: rec.hebrew,
    slug: rec.slug,
    slugs: rec.slugs.slice(),
    combined: rec.combined,
    haftarahSlug: haftarahSlugFor(rec.slug),
    hebrewDate: rec.hebrewDate,
    hebrewYear: rec.hebrewYear,
    triYear: rec.triYear || calendar.triennialYearOfHebrewYear(rec.hebrewYear) || 1,
    torahRef: rec.torahRef,
    maftirRef: cycle === 'triennial' && rec.triMaftirRef ? rec.triMaftirRef : rec.maftirRef,
    haftarahRef: rec.haftarahRef,
    special: rec.special,
    cycle,
    parts: chosen,
    activePart: partId(chosen[0]),
    createdAt: Date.now(),
  };
}

// --- Reading + storage ------------------------------------------------------

export function get() { return store.getPlan(); }

export function save(plan) {
  return store.setPlan(plan && plan.parts ? { ...plan, parts: sortParts(plan.parts) } : plan);
}

export function clear() { return store.setPlan(null); }

export function has() { return !!store.getPlan(); }

// Change one field (or a few) without rewriting the plan at the call site.
export function update(patch) {
  const cur = get();
  if (!cur) return null;
  return save({ ...cur, ...patch });
}

export function setActivePart(part) {
  const id = typeof part === 'string' ? part : partId(part);
  return update({ activePart: id });
}

export function activePart(plan = get()) {
  if (!plan) return null;
  const parts = plan.parts || [];
  return parts.find((p) => partId(p) === plan.activePart) || parts[0] || null;
}

// --- Talking about the plan -------------------------------------------------

// "your" / "J's" / "your student's" — whoever the app is addressing.
export function possessive(plan = get()) {
  if (!plan) return 'your';
  if (plan.role === 'self') return 'your';
  if (plan.learner) return `${plan.learner}\u2019s`;
  return plan.role === 'student' ? 'your student\u2019s' : 'their';
}

export function learnerName(plan = get()) {
  if (!plan) return '';
  return plan.role === 'self' ? '' : (plan.learner || '');
}

export function occasionLabel(plan = get()) {
  const occ = plan && OCCASIONS[plan.occasion];
  return occ ? occ.label : '';
}

// "Parashat Devarim · Shabbat 25 July 2026" — the one line that says what this
// plan is, used in the header chip and the menu.
export function summary(plan = get()) {
  if (!plan) return '';
  return `${plan.parashah} \u00b7 ${formatDate(plan.date)}`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1, 12);
  try {
    return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  } catch (e) { return iso; }
}

// Whole days from today until the simcha. Negative once it has passed, which is
// worth knowing: the app should stop counting down and start saying "well done".
export function daysAway(plan = get(), today = new Date()) {
  if (!plan || !plan.date) return null;
  const [y, m, d] = plan.date.split('-').map(Number);
  const target = Date.UTC(y, (m || 1) - 1, d || 1);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - now) / 864e5);
}

// "in 8 months" / "in 12 days" / "this Shabbat" / "3 weeks ago". Vague on purpose
// at long range: a countdown in days is a stressor, not information.
export function countdown(plan = get(), today = new Date()) {
  const days = daysAway(plan, today);
  if (days == null) return '';
  if (days === 0) return 'today';
  const ago = days < 0;
  const n = Math.abs(days);
  let phrase;
  if (n <= 6) phrase = n === 1 ? '1 day' : `${n} days`;
  else if (n <= 27) phrase = `${Math.round(n / 7)} week${Math.round(n / 7) === 1 ? '' : 's'}`;
  else if (n < 365) phrase = `${Math.round(n / 30.4)} month${Math.round(n / 30.4) === 1 ? '' : 's'}`;
  else phrase = `${(n / 365).toFixed(n % 365 < 60 ? 0 : 1)} years`;
  return ago ? `${phrase} ago` : `in ${phrase}`;
}

// --- Substituted passages ---------------------------------------------------
//
// The haftarah a date lands on is the one the calendar says, and for most readers
// that is the end of it. But plenty of b'nei mitzvah chant something else: a shul
// with its own custom, a special Shabbat, a passage chosen for the child. So any
// part of a plan can be pointed at an arbitrary passage of any book instead, using
// the same picker machinery as ✦ Any passage in the workshop — see
// api.describeRange in js/app.js, which is what fills in `ref` and `readingId`.
//
// Stored per part id so the substitution survives a change of date or cycle, and
// so the same mechanism would serve a substituted maftir without new plumbing.

export function customFor(part, plan = get()) {
  if (!plan || !part) return null;
  return (plan.custom || {})[partId(part)] || null;
}

export function setCustom(part, desc) {
  const cur = get();
  if (!cur || !part) return null;
  const custom = { ...(cur.custom || {}) };
  if (desc) custom[partId(part)] = desc;
  else delete custom[partId(part)];
  return save({ ...cur, custom });
}

export function clearCustom(part) { return setCustom(part, null); }

// --- Which readings a plan needs -------------------------------------------

// Where a part's text lives, as a target the app can open:
//   { readingId, kind, whole }        the whole reading (a haftarah)
//   { readingId, kind, aliyah: 'M' }  one chunk of a parashah (maftir / aliyah n)
//   { readingId, kind: 'passage' }    a substituted passage (see setCustom)
// `readingId` is a slug in data/readings.json — which may not be bundled; see
// availability().
export function partTarget(part, plan = get()) {
  if (!plan || !part) return null;
  const custom = customFor(part, plan);
  if (custom) {
    return {
      readingId: custom.readingId, kind: 'passage', whole: true, custom,
    };
  }
  if (part.kind === 'haftarah') {
    return { readingId: plan.haftarahSlug, kind: 'haftarah', whole: true };
  }
  return {
    readingId: plan.slug,
    kind: 'parashah',
    aliyah: part.kind === 'maftir' ? 'M' : part.n,
    cycle: plan.cycle,
    triYear: plan.triYear,
  };
}

// Whether the app actually ships this part, given the reading manifest:
//   'recorded'  bundled with the cantor's recording — the full experience
//   'text'      the text exists in data/tanakh/, so it can be taught from the
//               measured trope shapes (as a trope drill is), but with no example
//               chant to imitate
//   'none'      neither, so guided mode must not offer it
export function availability(part, available, plan = get()) {
  const target = partTarget(part, plan);
  if (!target || !target.readingId) return 'none';
  // A substituted passage always has its text (that is what the picker guarantees);
  // whether it inherits a recording depends on where it falls, and only opening it
  // can say.
  if (target.kind === 'passage') return 'text';
  const entry = (available || []).find((p) => p.slug === target.readingId);
  if (entry) {
    // A haftarah/parashah entry with no audio source is text-only (see Vayeilech).
    const sources = entry.sources || [];
    return sources.length ? 'recorded' : 'text';
  }
  // Not bundled as a reading, but its reference is known from the calendar, so
  // the text can still be assembled out of data/tanakh/ (see guided.js).
  const ref = part.kind === 'haftarah' ? plan.haftarahRef
    : part.kind === 'maftir' ? plan.maftirRef : plan.torahRef;
  return ref ? 'text' : 'none';
}

// The reference a part covers, for display and for the text-only fallback.
export function partRef(part, plan = get()) {
  const custom = customFor(part, plan);
  return (custom && custom.ref) || appointedRef(part, plan);
}

// What the calendar says this part is, whatever the reader has substituted for it —
// so a substitution can be described ("instead of Isaiah 49:14") and undone.
export function appointedRef(part, plan = get()) {
  if (!plan || !part) return '';
  if (part.kind === 'haftarah') return plan.haftarahRef || '';
  if (part.kind === 'maftir') return plan.maftirRef || '';
  return plan.torahRef || '';
}

// Every reading slug a plan touches, so the app can mark them in the menu and
// prime them for offline use.
export function readingSlugs(plan = get()) {
  if (!plan) return [];
  const out = new Set();
  for (const part of plan.parts || []) {
    const t = partTarget(part, plan);
    if (t && t.readingId) out.add(t.readingId);
  }
  return [...out];
}
