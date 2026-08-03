// Guided mode: the app narrowed to one reader, one reading, one thing at a time.
//
// Expert mode (js/app.js) is a workshop — every reading, every stage, every
// control, all reachable at once. This is the other product built on the same
// engine: a reader who has been handed a date and a maftir, and needs to be told
// what to sing next and how it went. Nothing here re-implements practice. The
// coach line, the recording, the pitch scoring and the store are exactly the ones
// expert mode uses; guided mode drives them (which reading, which pasuk, which
// stage, which unit) and puts a much smaller surface on top:
//
//   * a top bar naming the part and the round, with the five rounds as pips
//   * a mission card: what to do, why this, and where you are in it
//   * ONE row of large buttons — listen, sing, stop — and nothing else
//   * a result card with the score, what it unlocked, and the next thing
//
// Everything expert mode shows that isn't one of those is hidden by CSS rather
// than removed, so a reader can cross into expert mode and back without losing
// anything (see `exit`), and one engine keeps serving both.
//
// The difficulty ramp is deliberate: the interface itself gets more complicated
// as the rounds go up (body[data-guided-round] in css/guided.css). Round 1 is a
// word, a coach line and two buttons. By round 4 the scroll, the live meter and
// the analysis panels are all in play — the same controls the workshop has, but
// arrived at one at a time instead of all at once. Round 5 takes nothing away
// again: chaining pesukim together is the last and hardest thing asked for.

import * as plan from './plan.js';
import * as schedule from './schedule.js';
import { FULL_VERSE_LEVEL } from './levels.js';
import * as calendar from './calendar.js';
import * as store from './store.js';

// What counts as "done" for a whole-part chant, and for a chain.
const CHUNK_PASS = schedule.THRESHOLDS.good;

let api = null;
let active = false;
let current = null;      // the plan
let part = null;         // the part being worked
let ctx = null;          // schedule context for that part
let task = null;         // the task in hand
let session = 0;         // tasks handed out this sitting (walks the pattern)
let pickup = '';         // why this task isn't the pasuk the reader left off at
let explained = false;   // ...said once per part, not every time it happens
let phase = 'brief';     // 'brief' | 'running' | 'result'
let result = null;       // the last score report
let streak = 0;          // consecutive passes, for a little momentum feedback
let loading = false;
let problem = '';        // why the current part can't be practised, if it can't
let signinBusy = false;  // a sign-in popup opened from the menu is still open
let signinFailed = false; // ...and it didn't complete (closed, blocked, offline)
let chunkRefs = null;    // { key, map } — what each part of the plan's parashah covers

// --- Install ----------------------------------------------------------------

// `a` is the bridge to app.js: guided mode never touches app internals directly,
// so the two can be reasoned about (and tested) apart.
export function install(a) {
  api = a;
  buildDom();
}

export function isActive() { return active; }

export function currentPlan() { return current; }

// --- DOM --------------------------------------------------------------------

const el = {};

function buildDom() {
  if (el.top) return;
  const mk = (id, cls, html = '') => {
    const d = document.createElement('div');
    d.id = id;
    d.className = cls;
    d.innerHTML = html;
    document.body.appendChild(d);
    return d;
  };
  el.top = mk('guidedTop', 'g-top');
  el.card = mk('guidedCard', 'g-card');
  el.bar = mk('guidedBar', 'g-bar');
  el.backdrop = mk('guidedMenuBackdrop', 'g-menu-backdrop');
  el.menu = mk('guidedMenu', 'g-menu');
  el.backdrop.addEventListener('click', closeMenu);
  // A rotation re-wraps the card, so the padding it drives has to be re-measured.
  window.addEventListener('resize', () => { if (active) measureCard(); });
}

// --- Entering & leaving -----------------------------------------------------

// Open guided mode on a plan. Loads whatever reading the active part needs, then
// hands out the first task.
export async function start(p) {
  current = p || plan.get();
  if (!current) return;
  // A plan made before the aliyah divisions shipped knows only the parashah's whole
  // range; the calendar can still say where its aliyot fall, so it is asked once
  // here rather than every time a label is drawn.
  if (!current.aliyotRefs) {
    await calendar.load();
    current = plan.upgrade(current) || current;
  }
  active = true;
  session = 0;
  streak = 0;
  document.body.classList.add('guided');
  await openPart(plan.activePart(current) || (current.parts || [])[0]);
}

// Leave for the workshop, keeping the plan (and every score) exactly as it is.
export function exit() {
  active = false;
  document.body.classList.remove('guided');
  document.body.removeAttribute('data-guided-round');
  closeMenu();
  if (api && api.stopAll) api.stopAll();
}

// Re-enter after a trip through expert mode.
export function resume() {
  if (!plan.has()) return Promise.resolve();
  return start(plan.get());
}

// --- Parts ------------------------------------------------------------------

// Point the app at a part's text and build the schedule context for it.
async function openPart(p) {
  if (!p) return;
  part = p;
  task = null;
  result = null;
  phase = 'brief';
  problem = '';
  loading = true;
  pickup = '';
  explained = false;
  plan.setActivePart(p);
  current = plan.get();
  render();
  try {
    const opened = await loadPartReading(p);
    if (!opened) {
      problem = opened === false ? 'missing' : 'missing';
      loading = false;
      render();
      return;
    }
    ctx = buildContext(p);
    if (!ctx || !ctx.verses.length) {
      problem = 'empty';
      loading = false;
      render();
      return;
    }
  } catch (e) {
    console.warn('[guided] could not open part', e);
    problem = 'error';
    loading = false;
    render();
    return;
  }
  loading = false;
  openAtTop();
  // What every OTHER part covers, for the menu. Off the critical path: the reader is
  // already looking at the first word by the time it lands, and it costs nothing when
  // the parashah is the reading in hand.
  loadChunkRefs().then(() => { if (active) render(); });
}

// Load the reading a part lives in. A part the app ships as a recorded reading is
// opened directly; one it doesn't is assembled out of data/tanakh/ from the
// reference the calendar gave us, so a reader whose parashah has not been built
// yet still gets the right words and the measured melody (as a trope drill does)
// rather than a dead end.
async function loadPartReading(p) {
  const target = plan.partTarget(p, current);
  if (!target || !target.readingId) return false;
  const style = p.kind === 'haftarah' ? 'haftarah' : 'torah';
  const name = `${plan.possessive(current) === 'your' ? 'My' : `${current.learner || 'Their'}\u2019s`} ${plan.partLabel(p, current).toLowerCase()}`;
  // A passage the reader chose in place of the appointed one (see plan.setCustom).
  // Opened by book and range rather than by slug, because it is not a reading in
  // the manifest — it is any pesukim of any book, exactly as ✦ Any passage opens
  // them, in the haftarah melody.
  if (target.kind === 'passage') {
    const c = target.custom;
    if (!c || !c.book) return false;
    if (api.readingId() !== target.readingId) {
      await api.openPassage(c.book, c.from, c.to, { tropeStyle: style, name });
    }
    return true;
  }
  const bundled = api.available().some((x) => x.slug === target.readingId);
  if (bundled) {
    if (api.readingId() !== target.readingId) await api.loadReading(target.readingId);
    if (target.kind === 'parashah') api.setPortion(current.cycle, current.triYear);
    return true;
  }
  const ref = plan.partRef(p, current);
  const span = parseRef(ref);
  if (!span) return false;
  const bookSlug = await api.bookSlugFor(span.book);
  if (!bookSlug) return false;
  await api.openPassage(bookSlug, span.from, span.to, { tropeStyle: style, name });
  return true;
}

// The pesukim a part covers, plus the chunk that chants it in one go.
function buildContext(p) {
  const slug = api.readingSlug();
  const count = api.verseCount();
  const { cycle, triYear } = api.cycleNow();
  let verses = [];
  let chunk = null;

  const target = plan.partTarget(p, current);
  if (target.kind === 'passage' || api.readingId() !== target.readingId) {
    // A substituted passage, or a text-only fallback: the whole passage IS the part.
    chunk = api.wholeChunk();
    verses = range(1, count);
  } else if (p.kind === 'haftarah') {
    chunk = api.wholeChunk() || { n: 'H', kind: 'haftarah', start: 1, end: count };
    verses = range(chunk.start || 1, Math.min(chunk.end || count, count));
  } else if (p.kind === 'maftir') {
    const m = api.maftir(cycle, triYear);
    if (!m) return null;
    chunk = { ...m };
    verses = range(m.start, Math.min(m.end, count));
  } else {
    const a = (api.aliyot(cycle, triYear) || []).find((x) => Number(x.n) === Number(p.n));
    if (!a) return null;
    chunk = { ...a };
    verses = range(a.start, Math.min(a.end, count));
  }
  return schedule.makeContext({
    slug, verses, cycle, triYear, chunk,
    unitCount: (verse, level) => api.unitCount(verse, level),
  });
}

function range(a, b) {
  const out = [];
  for (let n = a; n <= b; n++) out.push(n);
  return out;
}

// "I Kings 2:1-12" / "Isaiah 27:6-28:13, 29:22-23" -> book + [c,v] endpoints.
// Where a reading is two separate passages the hull is taken (and said so in the
// UI), because the picker deals in one contiguous range.
function parseRef(ref) {
  if (!ref) return null;
  const m = /^(.*?)\s+(\d+:\d+.*)$/.exec(ref.trim());
  if (!m) return null;
  const book = m[1];
  const nums = [...m[2].matchAll(/(\d+):(\d+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
  if (!nums.length) return null;
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);
  const sorted = nums.slice().sort(cmp);
  return { book, from: sorted[0], to: sorted[sorted.length - 1], split: nums.length > 2 };
}

// --- Task loop --------------------------------------------------------------

// Choosing a part means starting it, and starting it means starting at the top of
// it. Everything after this first task is the schedule's business (see openingTask).
function openAtTop() {
  if (!ctx) return;
  pickup = '';
  result = null;
  phase = 'brief';
  task = schedule.openingTask(ctx);
  if (task) applyTask(task);
  render();
}

// Hand out the next task and point the app at it.
function runNext() {
  if (!ctx) return;
  const picked = schedule.nextTask(ctx, { session, avoid: task });
  session += 1;
  task = picked;
  result = null;
  phase = 'brief';
  pickup = picked ? pickupFor(picked) : '';
  if (!picked) { render(); return; }
  applyTask(picked);
  render();
}

// Repeat the task in hand (after a miss, or by choice).
function again() {
  result = null;
  phase = 'brief';
  if (task) applyTask(task);
  render();
}

// Drive the app to where the task lives. This is the whole of guided mode's
// coupling to the practice engine: pick a pasuk, a stage and a unit, or open the
// chain/whole-part reader.
function applyTask(t) {
  if (!t) return;
  // A chain names the text it is to be read from as well as the pesukim: the
  // fifth round asks for every run twice, with the vowels and then off the bare
  // scroll (see CHAIN_SURFACES).
  if (t.kind === 'chain') {
    api.openChain(t.start, t.end, { surface: schedule.chainSurface(t) });
    return;
  }
  if (t.kind === 'whole') { api.openAliyah(ctx.chunk); return; }
  api.selectVerse(t.verse);
  api.selectStage(t.level);
  // A repair task names a WORD; the stage cuts the pasuk into units, so find the
  // unit holding that word rather than assuming they line up.
  if (t.word != null) {
    const idx = api.unitIndexOfWord(t.verse, t.level, t.word);
    if (idx > 0) api.goToUnit(idx);
  }
}

// --- Feedback ---------------------------------------------------------------

// Called by app.js at the end of every scored take. Guided mode owns what happens
// next; expert mode's own result line is hidden here (css/guided.css) so there is
// one verdict on screen, not two.
export function notifyScore(info) {
  if (!active || !info) return;
  const passed = !!info.passed;
  streak = passed ? streak + 1 : 0;
  // Where a stage cuts the pasuk into several units, the task isn't finished
  // until they have all been sung — that is what makes "words" a round rather
  // than a single tap.
  const more = info.kind === 'verse' && passed
    && info.unitCount > 1 && info.unitIndex + 1 < info.unitCount;
  result = { ...info, passed, streak, more };
  phase = 'result';
  render();
}

// Advance within the task (next word/phrase) or move on to the next task.
function onward() {
  if (result && result.more) {
    const nextUnit = result.unitIndex + 1;
    result = null;
    phase = 'brief';
    api.goToUnit(nextUnit);
    render();
    return;
  }
  // A run just chanted cleanly with the vowels comes straight back off the bare
  // scroll, which is the promise the result card made (see nextChainTier).
  const up = followUpTier();
  if (up) {
    session += 1;
    task = up;
    result = null;
    phase = 'brief';
    pickup = '';
    applyTask(task);
    render();
    return;
  }
  runNext();
}

// The harder surface of the run in hand, once it has been earned.
function followUpTier() {
  if (!ctx || !result || !result.passed || result.more) return null;
  return schedule.nextChainTier(ctx, task);
}

// --- Rendering --------------------------------------------------------------

function render() {
  if (!active || !el.top) return;
  const round = activeRound();
  document.body.dataset.guidedRound = String(round.id);
  renderTop(round);
  renderCard(round);
  renderBar();
  if (document.body.classList.contains('g-menu-open')) renderMenu();
  measureCard();
}

// The round the chrome is dressed for: the one the task in hand belongs to, which
// is the part's current round except when the reader has gone back to a pasuk that
// is further along. Working round-3 material with round-1 chrome would hide the
// pitch meter the task is asking them to use.
function activeRound() {
  if (task && task.round) return schedule.roundById(task.round);
  return ctx ? schedule.currentRound(ctx) : schedule.ROUNDS[0];
}

// The mission card is a fixed strip whose height depends on its content (a brief
// is two lines, a result is a dial and two buttons), and the practice pane below
// has to be padded clear of it. Measuring beats guessing: a card taller than the
// padding would hide the top of the coach line.
function measureCard() {
  if (!el.card) return;
  const h = Math.ceil(el.card.getBoundingClientRect().height);
  if (h > 0) document.documentElement.style.setProperty('--g-card-h', `${h}px`);
}

// Re-draw the chrome without changing the task (after a store change elsewhere).
export function refresh() { if (active) render(); }

function renderTop(round) {
  const prog = ctx ? schedule.overallProgress(ctx) : null;
  const pips = schedule.ROUNDS.map((r) => {
    const p = prog ? prog.rounds[r.id - 1] : { pct: 0 };
    const state = p.pct >= 100 ? 'done' : (r.id === round.id ? 'on' : '');
    return `<span class="g-pip ${state}" title="Round ${r.id}: ${r.label} \u2014 ${p.pct}%">
        <span class="g-pip-fill" style="width:${p.pct}%"></span>
        <span class="g-pip-n">${r.id}</span>
      </span>`;
  }).join('');
  el.top.innerHTML = `
    <button class="g-menu-btn" id="gMenu" aria-label="Progress &amp; settings">\u2630</button>
    <div class="g-top-mid">
      <p class="g-top-part">${escapeHtml(plan.partLabel(part, current))}</p>
      <p class="g-top-round">Round ${round.id} \u00b7 ${escapeHtml(round.label)}</p>
    </div>
    <div class="g-pips" aria-label="Progress through the five rounds">${pips}</div>`;
  document.getElementById('gMenu').addEventListener('click', openMenu);
}

function renderCard(round) {
  if (loading) {
    el.card.innerHTML = `<div class="g-brief"><p class="g-task">Opening ${escapeHtml(plan.partLabel(part, current))}\u2026</p></div>`;
    return;
  }
  if (problem) { el.card.innerHTML = problemHtml(); wireProblem(); return; }
  if (phase === 'result' && result) { el.card.innerHTML = resultHtml(); wireResult(); return; }
  if (!task) { el.card.innerHTML = finishedHtml(round); wireFinished(); return; }
  el.card.innerHTML = briefHtml(round);
}

// What to do now. Three lines at most: the instruction, why this piece, and where
// in the piece you are.
function briefHtml(round) {
  const where = taskWhere();
  // Round 1's blurb promises "the cantor to copy", which is a promise the app can
  // only keep for the readings someone recorded. On a passage nobody has — most of
  // Tanakh, including any haftarah picked outside the weekly cycle — say what the
  // voice actually is, once, rather than letting the reader wonder why the cantor
  // sounds like that.
  // A reader moved on past their place has a live question about it, and asks it in a
  // posture where the card is one line (see css/guided.css) — so the answer is its
  // own element, kept when the rest of the small print goes.
  const hint = pickup ? '' : (round.id === 1 && task.reason !== 'repair'
    ? (recorded() ? round.blurb
      : 'One word at a time. Nobody has recorded these pesukim, so the voice is '
        + 'synthesized \u2014 but every accent\u2019s tune and timing is measured from the '
        + 'cantor\u2019s own chanting, not guessed.')
    : '');
  return `
    <div class="g-brief">
      <p class="g-task">${escapeHtml(schedule.taskTitle(task))}</p>
      <p class="g-why"><span class="g-why-tag ${task.reason}">${escapeHtml(schedule.taskWhy(task))}</span>${
    where ? `<span class="g-where">${escapeHtml(where)}</span>` : ''}</p>
      ${pickup ? `<p class="g-pickup">${escapeHtml(pickup)}</p>` : ''}
      ${hint ? `<p class="g-hint">${escapeHtml(hint)}</p>` : ''}
    </div>`;
}

function pasukIndex(verse) {
  return ctx ? ctx.verses.indexOf(verse) : -1;
}

// Chapter and pasuk without the book, for the pasuk list: "7:22" reads as a
// position in a reading whose book is named twice over the top of it already.
function shortRef(verse) {
  const ref = api.verseRef(verse) || '';
  const m = /(\d+:\d+)\s*$/.exec(ref);
  return m ? m[1] : ref;
}

// Why the reader has been moved on past pesukim they didn't sing this sitting.
// ADVANCE walks the part in order and steps over whatever has already cleared the
// round, which is right — and looks exactly like the app losing their place unless it
// says so, once, along with where to go to argue with it.
function pickupFor(t) {
  if (!ctx || explained) return '';
  if (t.kind !== 'verse' || t.reason !== 'advance') return '';
  const at = pasukIndex(t.verse);
  if (at < 1) return '';
  explained = true;
  const before = at === 1 ? 'The first pasuk is' : `Pesukim 1\u2013${at} are`;
  return `${before} already through this round, so this moves on to pasuk ${at + 1}. `
    + 'Tap \u2630 for the whole list \u2014 any pasuk can be sung again whenever you like.';
}

// Whether there is a human recording of what is open. The app ships recordings for
// the readings it was built with; anything else is taught from the measured trope
// shapes, which is honest work but a different promise.
function recorded() {
  return !!(api.hasRecording && api.hasRecording());
}

// The pesukim a part actually covers, as the reading itself divides them.
//
// The plan alone can't say: it knows the week's Torah reading is Deuteronomy
// 7:12–11:25, which is true of the parashah and true of none of its aliyot. Told
// that on all seven rows a reader would reasonably conclude the app had not split
// the reading at all. The division — and the triennial third — lives in the
// reading's own aliyah table, so that is what is asked (see api.chunkRefs).
function refFor(p) {
  if (!p) return '';
  const custom = plan.customFor(p, current);
  if (custom) return custom.ref || '';
  const key = p.kind === 'maftir' ? 'M' : (p.kind === 'haftarah' ? 'H' : String(p.n));
  const map = chunkRefs && chunkRefs.map;
  return (map && map[key]) || plan.partRef(p, current);
}

// Asked for once per plan/cycle, and only for the parashah: a haftarah is one
// passage and the plan already names it.
async function loadChunkRefs() {
  if (!current || !current.slug || !api.chunkRefs) return;
  const key = `${current.slug}:${current.cycle}:${current.triYear}`;
  if (chunkRefs && chunkRefs.key === key) return;
  const map = await api.chunkRefs(current.slug, current.cycle, current.triYear);
  if (map) chunkRefs = { key, map };
}

// "Devarim 3:20 · pasuk 2 of 5 · word 2 of 9" — the position, in the reader's
// terms. Which pasuk of the part this is matters as much as which pasuk of the
// book: it is the only thing on screen that says how far through the reading the
// reader has got, and without it being moved past a pasuk looks like losing one.
function taskWhere() {
  if (!task) return '';
  if (task.kind === 'whole') return refFor(part) || '';
  if (task.kind === 'chain') return api.verseRange(task.start, task.end);
  const bits = [api.verseRef(task.verse)];
  const at = pasukIndex(task.verse);
  if (at >= 0 && ctx.verses.length > 1) bits.push(`pasuk ${at + 1} of ${ctx.verses.length}`);
  const n = api.unitsShown();
  if (n > 1) {
    const unit = api.currentUnitName();
    bits.push(`${unit} ${api.currentUnitIndex() + 1} of ${n}`);
  }
  return bits.filter(Boolean).join(' \u00b7 ');
}

// How it went. One number, one sentence, and one obvious button — plus the thing
// that actually motivates a reader, which is seeing the number move.
function resultHtml() {
  const r = result;
  const pass = r.passed;
  const pct = Math.max(0, Math.min(100, Math.round(r.score)));
  const tone = pct >= 90 ? 'great' : pass ? 'good' : 'again';
  const headline = pct >= 95 ? 'Perfect' : pct >= 90 ? 'Beautiful'
    : pct >= 80 ? 'Well sung' : pass ? 'That counts' : 'Not quite yet';
  // Passing a run with the vowels earns the same run off the bare scroll, and
  // saying so is what makes the second take read as the next rung rather than as
  // the app asking for the thing they just did.
  const nextRung = !!followUpTier();
  const say = pass
    ? (r.more ? 'On to the next one.'
      : nextRung ? 'The joins are holding. Now the same run from the bare scroll.'
        : 'That piece is done.')
    : `Reach ${Math.round(r.threshold)} to move on \u2014 listen once more, then try again.`;
  const bonus = [];
  if (r.assisted) bonus.push('Sung with the guide, so it counts for less \u2014 try it on your own to beat it.');
  if (pass && r.streak >= 3) bonus.push(`${r.streak} in a row.`);
  return `
    <div class="g-result ${tone}">
      <div class="g-score" role="img" aria-label="${pct} out of 100"
        style="--pct:${pct}"><span>${pct}</span></div>
      <div class="g-result-text">
        <p class="g-headline">${headline}</p>
        <p class="g-say">${escapeHtml(say)}</p>
        ${bonus.length ? `<p class="g-hint">${escapeHtml(bonus.join(' '))}</p>` : ''}
      </div>
      <div class="g-result-actions">
        ${pass ? `<button class="g-go" id="gNext">${r.more ? 'Next' : nextRung ? 'From the scroll' : 'Carry on'} \u203a</button>`
    : `<button class="g-go" id="gAgain">Try again</button>`}
        ${pass ? `<button class="g-ghost" id="gAgain">Again</button>`
    : `<button class="g-ghost" id="gNext">Skip for now</button>`}
      </div>
    </div>`;
}

function wireResult() {
  const n = document.getElementById('gNext');
  const a = document.getElementById('gAgain');
  if (n) n.addEventListener('click', onward);
  if (a) a.addEventListener('click', again);
  if (n) n.focus({ preventScroll: true });
}

// Nothing left to hand out: every round of this part is finished to the standard
// the schedule cares about. Offer the other parts, and the one thing left worth
// doing — running it through again.
function finishedHtml(round) {
  const others = (current.parts || []).filter((p) => plan.partId(p) !== plan.partId(part));
  return `
    <div class="g-done">
      <p class="g-task">\u2728 ${escapeHtml(plan.partLabel(part, current))} is ready</p>
      <p class="g-say">Every pasuk chanted, and the whole thing end to end. Keep it warm by running it again.</p>
      <div class="g-result-actions">
        <button class="g-go" id="gWhole">Chant it through</button>
        ${others.length ? `<button class="g-ghost" id="gOther">Work on ${escapeHtml(plan.partLabel(others[0], current))}</button>` : ''}
      </div>
    </div>`;
}

function wireFinished() {
  const w = document.getElementById('gWhole');
  if (w) w.addEventListener('click', () => {
    task = { kind: 'whole', reason: 'combine', round: 5 };
    phase = 'brief';
    result = null;
    applyTask(task);
    render();
  });
  const o = document.getElementById('gOther');
  if (o) o.addEventListener('click', () => {
    const others = (current.parts || []).filter((p) => plan.partId(p) !== plan.partId(part));
    if (others.length) openPart(others[0]);
  });
}

// This part can't be practised here. Say exactly why and offer the way round it,
// rather than showing an empty coach pane.
function problemHtml() {
  const label = plan.partLabel(part, current);
  const ref = plan.partRef(part, current);
  const others = (current.parts || []).filter((p) => plan.partId(p) !== plan.partId(part));
  const why = problem === 'empty'
    ? `This cycle's ${label.toLowerCase()} falls outside the text the app has for ${escapeHtml(current.parashah)}.`
    : `The app doesn't have the text for ${escapeHtml(label)}${ref ? ` (${escapeHtml(ref)})` : ''} yet.`;
  return `
    <div class="g-problem">
      <p class="g-task">Can\u2019t open ${escapeHtml(label)}</p>
      <p class="g-say">${why}</p>
      <div class="g-result-actions">
        ${others.map((p) => `<button class="g-go" data-part="${plan.partId(p)}">Work on ${escapeHtml(plan.partLabel(p, current))}</button>`).join('')}
        <button class="g-ghost" id="gProblemMenu">Change my plan</button>
      </div>
    </div>`;
}

function wireProblem() {
  el.card.querySelectorAll('[data-part]').forEach((b) => b.addEventListener('click', () => {
    const p = plan.partFromId(b.dataset.part);
    if (p) openPart(p);
  }));
  const m = document.getElementById('gProblemMenu');
  if (m) m.addEventListener('click', openMenu);
}

// --- The action bar ---------------------------------------------------------
// Two big buttons, and a third only once it is worth having. Each one clicks the
// control expert mode already has, so there is exactly one code path for playing
// and recording however the reader got there.

function renderBar() {
  if (problem || loading || !task) { el.bar.innerHTML = ''; return; }
  const chunky = task.kind === 'chain' || task.kind === 'whole';
  const running = api.isBusy();
  const round = activeRound();
  if (running) {
    el.bar.innerHTML = `<button class="g-act g-stop" data-click="${chunky ? 'alStop,btnStop' : 'btnStop,alStop'}">\u25a0 Stop</button>`;
  } else {
    // Listen to what the mission actually asks for. In the early rounds that is
    // ONE word or phrase, so the word-level playback comes first: the whole-verse
    // button also widens the recording target to the whole verse, which would make
    // "sing this word" mean something else the moment they pressed Listen.
    const listen = chunky ? 'alGuide' : 'btnRealWord,btnReal,btnPlay';
    const sing = chunky ? 'alRec' : 'btnRec';
    const duet = chunky ? 'alDuet' : 'btnSing';
    // The sing-along is a crutch and a help in equal measure, so it appears once
    // the reader is chanting whole pesukim (round 3) or has just missed.
    const showDuet = round.id >= 3 || (result && !result.passed) || chunky;
    el.bar.innerHTML = `
      <button class="g-act g-listen" data-click="${listen}">\u266a ${recorded() ? 'Listen' : 'Guide voice'}</button>
      <button class="g-act g-sing" data-click="${sing}">\u25cf ${chunky ? 'Chant it' : 'Sing it'}</button>
      ${showDuet ? `<button class="g-act g-duet" data-click="${duet}">\u21c5 Sing along</button>` : ''}`;
  }
  el.bar.querySelectorAll('[data-click]').forEach((b) => b.addEventListener('click', () => {
    api.click(b.dataset.click.split(','));
    // The engine flips its own buttons; mirror that here so Stop appears at once.
    setTimeout(() => { if (active) renderBar(); }, 60);
  }));
}

// app.js calls this whenever playback/recording starts or stops, so the bar can
// swap to Stop and back without polling.
export function transportChanged() { if (active && el.bar) renderBar(); }

// The session changed (a sign-in completed, cloud progress merged, someone signed
// out). The menu's account rows are the one part of this surface that moves without
// the reader touching it, so app.js pokes it and it redraws if it is open.
export function accountChanged() {
  if (active && el.menu && document.body.classList.contains('g-menu-open')) renderMenu();
}

// --- The menu ---------------------------------------------------------------
// "A menu once these games are starting will show the progress on each task
// visually and allow some minimal settings changes, and to return to main
// selection or a new parasha retaining current progress."

export function openMenu() {
  if (!active) return;
  document.body.classList.add('g-menu-open');
  renderMenu();
}

export function closeMenu() {
  document.body.classList.remove('g-menu-open');
}

function renderMenu() {
  const p = current;
  const days = plan.countdown(p);
  const who = plan.learnerName(p);
  const rows = (p.parts || []).map(partRowHtml).join('');
  el.menu.innerHTML = `
    <div class="g-menu-head">
      <button class="g-menu-close" id="gClose" aria-label="Close">\u2715</button>
      <p class="g-menu-title">${escapeHtml(who ? `${who}\u2019s ${plan.occasionName(p).toLowerCase()}` : plan.occasionLabel(p))}</p>
      <p class="g-menu-sub">${escapeHtml(p.parashah)} \u00b7 ${escapeHtml(plan.formatDate(p.date))}${days ? ` \u00b7 ${escapeHtml(days)}` : ''}</p>
      <p class="g-menu-he" lang="he" dir="rtl">${escapeHtml(p.hebrew || '')}</p>
    </div>
    <div class="g-menu-body">
      <h3 class="g-menu-h">What you\u2019re learning</h3>
      <div class="g-parts">${rows}</div>
      <p class="g-menu-note">Chanting something other than what the calendar appoints \u2014 a shul\u2019s own haftarah, or a passage chosen for the day? Tap \u270e on a part to put any pesukim of any book in its place.</p>
      ${pesukimHtml()}

      <h3 class="g-menu-h">Settings</h3>
      <div class="g-set">
        <button class="g-row-btn g-row-primary" id="gWholeAliyah" ${ctx && ctx.chunk ? '' : 'disabled'}>
          \u25b6 Read / listen / practice the full ${escapeHtml(plan.partLabel(part, current).toLowerCase())}
        </button>
        <label class="g-row"><span>Full-reading text</span>
          <select id="gScrollTextMode">
            <option value="stam" ${api.scrollTextMode() === 'stam' ? 'selected' : ''}>STA\u201dM scroll</option>
            <option value="pointed" ${api.scrollTextMode() === 'pointed' ? 'selected' : ''}>Vowels &amp; cantillation</option>
            <option value="dual" ${api.scrollTextMode() === 'dual' ? 'selected' : ''}>Both side by side</option>
          </select></label>
        <label class="g-row g-row-check"><span>Keep both texts aligned</span>
          <input type="checkbox" id="gScrollSync" ${api.scrollSync() ? 'checked' : ''}
            ${api.scrollTextMode() === 'dual' ? '' : 'disabled'} /></label>
        <label class="g-row"><span>Text size</span>
          <input type="range" id="gTextSize" min="0.8" max="2.4" step="0.1" value="${api.readScale()}" /></label>
        ${translitRowHtml()}
        <label class="g-row g-row-check"><span>Show the pitch analysis</span>
          <input type="checkbox" id="gAnalysis" ${api.analysisOn() ? 'checked' : ''} /></label>
        <button class="g-row-btn" id="gOffline">\u2b07 Save the audio for offline</button>
      </div>
      ${translitNoteHtml()}

      ${accountHtml()}

      <h3 class="g-menu-h">This plan</h3>
      <div class="g-set">
        <button class="g-row-btn" id="gEdit">\u270e Change the date, cycle or parts</button>
        <button class="g-row-btn" id="gNew">\u2726 Learn a different parashah</button>
        <button class="g-row-btn" id="gExpert">\u2699 Open the full workshop</button>
      </div>
      <p class="g-menu-note">Changing the plan never deletes practice \u2014 scores are filed under the pesukim themselves, so coming back to a reading finds it exactly where you left it.</p>
    </div>`;
  wireMenu();
}

// Reading along in Latin letters, for a reader whose Hebrew alphabet is still
// slower than the tune they are learning. The workshop keeps this in its settings
// sheet, which guided mode hides — and the reader who needs it most is precisely
// the one on this surface, so it is offered here as well.
//
// The row is drawn only while the stage still allows the aid (see translitOn in
// app.js). Past that it is not shown greyed but simply gone: a dead switch in a
// four-row menu invites a reader to poke at it, and the note below has already
// said, before it happened, that this is coming.
function translitRowHtml() {
  if (!api.translitAllowed()) return '';
  return `<label class="g-row g-row-check"><span>Show the words in English letters</span>
          <input type="checkbox" id="gTranslit" ${api.translitOn() ? 'checked' : ''} /></label>`;
}

function translitNoteHtml() {
  if (!api.translitAllowed()) return '';
  const gone = schedule.roundOfLevel(FULL_VERSE_LEVEL + 1);
  return `<p class="g-menu-note">English letters are a way in, not the goal \u2014 they come off
    in the ${escapeHtml(gone.icon)} ${escapeHtml(gone.label)} round, where the helps are taken
    away one at a time. Until then, read them alongside the Hebrew rather than instead of it.</p>`;
}

// Where the practice is going, and the way to change the answer. The wizard asks
// this once, before the first take; a reader who said "not now" then — or who is
// three weeks in on a borrowed iPad and has thought better of it — would otherwise
// have to find the workshop's topbar to sign in, and guided mode exists precisely
// so they never have to go there. Nothing is drawn when there is no project to
// sign in to (see auth.readyState).
function accountHtml() {
  const a = api.account();
  if (!a || a.state === 'unconfigured') return '';
  const heading = '<h3 class="g-menu-h">Saving your progress</h3>';
  const google = (label, disabled) => `<button class="g-row-btn g-row-primary" id="gSignIn"
      ${disabled ? 'disabled' : ''}><span class="g-g" aria-hidden="true">G</span> ${label}</button>`;
  const identity = () => `<button class="g-row-btn" id="gIdentity">\u270e Change the name and picture
    you appear under</button>`;

  if (a.signedIn && !a.anon) {
    return `${heading}
      <div class="g-set">
        ${whoRowHtml(a)}
        ${identity()}
        <button class="g-row-btn" id="gSignOut">Sign out</button>
      </div>
      <p class="g-menu-note">Every take is saved to this account, so it is on any phone or computer
        you sign in on \u2014 and outlives this browser.</p>`;
  }

  // An anonymous session syncs and appears on the leaderboard, but nobody can ever
  // sign back into it: on a new phone it is simply gone. So it is offered the same
  // Google button, which links the two and keeps the nickname (see auth.signIn).
  if (a.signedIn && a.anon) {
    return `${heading}
      <div class="g-set">
        ${whoRowHtml(a)}
        ${google(signinLabel(a), a.state !== 'ready' || signinBusy)}
        ${identity()}
      </div>
      ${signinFailedNote()}
      <p class="g-menu-note">You\u2019re posting anonymously. Nobody can sign back into an anonymous
        score \u2014 signing in keeps this nickname and everything under it, on every device.</p>`;
  }

  return `${heading}
    <div class="g-set">
      ${google(signinLabel(a), a.state !== 'ready' || signinBusy)}
    </div>
    ${signinFailedNote()}
    <p class="g-menu-note">Practice is being saved in this browser only. Signed in, it is kept in an
      account instead: a new phone, the computer downstairs, or this one after the browser is
      cleared. A parent\u2019s Google account is fine, and everything done so far goes up with it.</p>`;
}

function whoRowHtml(a) {
  const initial = (a.name || '?').trim().charAt(0).toUpperCase();
  const face = a.photo
    ? `<img class="g-acct-av" src="${escapeAttr(a.photo)}" alt="" referrerpolicy="no-referrer" />`
    : `<span class="g-acct-av g-acct-initial">${escapeHtml(initial)}</span>`;
  return `<div class="g-acct">
      <span class="g-acct-who">${face}<span class="g-acct-name">${escapeHtml(a.name || 'Signed in')}</span></span>
      ${a.anon ? '<span class="g-acct-tag">anon</span>' : '<span class="g-acct-tag">saving</span>'}
    </div>`;
}

function signinLabel(a) {
  if (signinBusy) return 'Signing in\u2026';
  if (a.state === 'loading') return 'Preparing sign-in\u2026';
  return 'Sign in with Google';
}

function signinFailedNote() {
  const a = api.account();
  if (a && a.state === 'failed') {
    return `<p class="g-menu-note">Sign-in can\u2019t be reached right now \u2014 try again when you have
      signal. Nothing is lost meanwhile.</p>`;
  }
  return signinFailed
    ? `<p class="g-menu-note">That didn\u2019t finish \u2014 the popup may have been closed or blocked.</p>`
    : '';
}

// One row per part: the rounds as a bar each, the whole-part score, and a tap
// target to switch to it. This is the "progress on each task, visually".
function partRowHtml(p) {
  const id = plan.partId(p);
  const mine = id === plan.partId(part);
  const c = mine && ctx ? ctx : null;
  const prog = c ? schedule.overallProgress(c) : null;
  const bars = schedule.ROUNDS.map((r) => {
    const pct = prog ? prog.rounds[r.id - 1].pct : 0;
    return `<span class="g-rbar" title="Round ${r.id}: ${r.label} \u2014 ${pct}%">
        <span style="width:${pct}%"></span></span>`;
  }).join('');
  const whole = c ? schedule.wholeScore(c) : 0;
  const swapped = !!plan.customFor(p, current);
  return `
    <div class="g-part${mine ? ' on' : ''}">
      <button class="g-part-main" data-part="${id}">
        <span class="g-part-top">
          <span class="g-part-name">${escapeHtml(plan.partLabel(p, current))}</span>
          <span class="g-part-pct">${prog ? `${prog.pct}%` : (mine ? '' : 'tap to open')}</span>
        </span>
        <span class="g-bars">${bars}</span>
        <span class="g-part-foot">
          <span class="g-part-ref">${swapped ? '\u2726 ' : ''}${escapeHtml(refFor(p) || '')}</span>
          ${whole ? `<span class="g-part-whole">whole: ${whole}</span>` : ''}
        </span>
      </button>
      <button class="g-part-swap" data-swap="${id}"
        title="Chant a different passage for the ${escapeAttr(plan.partLabel(p, current).toLowerCase())}"
        aria-label="Choose a different passage for the ${escapeAttr(plan.partLabel(p, current))}">\u270e</button>
    </div>`;
}

// Every pasuk of the part in hand, with how far each one has got and a way straight
// into it. Two things a reader needs that the round bars can't give them: which
// pesukim are actually done (the bars are averages, and a reader who has been moved
// past one wants to see it ticked rather than take it on trust), and the way back to
// one — the schedule is a good default, not a rail.
function pesukimHtml() {
  if (!ctx || !ctx.verses.length) return '';
  const chips = ctx.verses.map((n, i) => {
    const p = schedule.verseProgress(ctx, n);
    const here = task && task.kind === 'verse' && task.verse === n;
    const segs = p.cleared.map((ok) => `<span class="g-vseg${ok ? ' on' : ''}"></span>`).join('');
    return `<button class="g-pasuk${here ? ' on' : ''}${p.done >= p.total ? ' done' : ''}"
        data-verse="${n}"
        title="Pasuk ${i + 1} \u00b7 ${shortRef(n)} \u2014 ${p.done} of ${p.total} rounds${here ? ' \u00b7 this one' : ''}">
        <span class="g-pasuk-top">
          <span class="g-pasuk-n">${i + 1}</span>
          <span class="g-pasuk-ref">${escapeHtml(shortRef(n))}</span>
        </span>
        <span class="g-vsegs" aria-hidden="true">${segs}</span>
      </button>`;
  }).join('');
  // "the maftir", "the haftarah" — but "Aliyah 3", which is a name and not a thing.
  const label = part.kind === 'aliyah'
    ? plan.partLabel(part, current) : `the ${plan.partLabel(part, current).toLowerCase()}`;
  return `
    <h3 class="g-menu-h">Every pasuk of ${escapeHtml(label)}</h3>
    <div class="g-pesukim">${chips}</div>
    <p class="g-menu-note">Four ticks is a pasuk you can chant on its own from the
      scroll. Chanting them in runs is the last round \u2014 each run with the vowels
      first and then off the bare scroll \u2014 and it belongs to the reading rather than
      to any one pasuk. Tap any one to sing it now \u2014 nothing is lost, and
      the next thing you would have been handed comes back after it.</p>`;
}

// Go back (or forward) to a pasuk by name, at whatever stage that pasuk itself has
// reached. The schedule picks up again from the next task.
function workVerse(n) {
  if (!ctx || !ctx.verses.includes(n)) return;
  closeMenu();
  task = schedule.taskForVerse(ctx, n);
  pickup = '';
  result = null;
  phase = 'brief';
  applyTask(task);
  render();
}

function workWhole() {
  if (!ctx || !ctx.chunk) return;
  closeMenu();
  api.stopAll();
  task = { kind: 'whole', reason: 'chosen', round: 5 };
  pickup = '';
  result = null;
  phase = 'brief';
  applyTask(task);
  render();
}

function wireMenu() {
  const byId = (id) => document.getElementById(id);
  byId('gClose').addEventListener('click', closeMenu);
  el.menu.querySelectorAll('[data-verse]').forEach((b) => b.addEventListener('click',
    () => workVerse(Number(b.dataset.verse))));
  el.menu.querySelectorAll('[data-part]').forEach((b) => b.addEventListener('click', () => {
    const p = plan.partFromId(b.dataset.part);
    closeMenu();
    if (p && plan.partId(p) !== plan.partId(part)) openPart(p);
  }));
  el.menu.querySelectorAll('[data-swap]').forEach((b) => b.addEventListener('click', () => {
    const p = plan.partFromId(b.dataset.swap);
    if (p) openPicker(p);
  }));
  const size = byId('gTextSize');
  if (size) size.addEventListener('input', () => api.setReadScale(parseFloat(size.value)));
  const tl = byId('gTranslit');
  if (tl) tl.addEventListener('change', () => api.setTranslit(tl.checked));
  const an = byId('gAnalysis');
  if (an) an.addEventListener('change', () => api.setAnalysis(an.checked));
  const whole = byId('gWholeAliyah');
  if (whole) whole.addEventListener('click', workWhole);
  const textMode = byId('gScrollTextMode');
  if (textMode) textMode.addEventListener('change', () => {
    api.setScrollTextMode(textMode.value);
    if (document.body.classList.contains('g-menu-open')) renderMenu();
  });
  const scrollSync = byId('gScrollSync');
  if (scrollSync) scrollSync.addEventListener('change', () => api.setScrollSync(scrollSync.checked));
  const off = byId('gOffline');
  if (off) off.addEventListener('click', () => { api.download(); closeMenu(); });
  const signIn = byId('gSignIn');
  if (signIn) signIn.addEventListener('click', async () => {
    signinBusy = true;
    signinFailed = false;
    renderMenu();
    try {
      await api.signIn();
    } catch (e) {
      // A popup the reader closed, or one the browser blocked. Neither is worth
      // more than a line saying so: the menu is still open behind it.
      console.warn('[guided] sign-in did not complete:', e);
      signinFailed = true;
    }
    signinBusy = false;
    // The session change redraws this through accountChanged(); this covers the
    // failure, where nothing changed and nothing else will redraw it.
    if (document.body.classList.contains('g-menu-open')) renderMenu();
  });
  const out = byId('gSignOut');
  if (out) out.addEventListener('click', async () => {
    try { await api.signOut(); } catch (e) { console.warn('[guided] sign-out failed:', e); }
  });
  const who = byId('gIdentity');
  if (who) who.addEventListener('click', () => { closeMenu(); api.editIdentity(); });
  byId('gEdit').addEventListener('click', () => { closeMenu(); api.editPlan(); });
  byId('gNew').addEventListener('click', () => { closeMenu(); api.newPlan(); });
  byId('gExpert').addEventListener('click', () => { closeMenu(); api.toExpert(); });
}

// --- Choosing a different passage -------------------------------------------
//
// "My son has a custom haftarah from a different book." Plenty of b'nei mitzvah
// chant something other than the haftarah the calendar appoints — a shul's own
// custom, a special Shabbat, a passage chosen for the child — so any part of the
// plan can be pointed somewhere else.
//
// This is the workshop's ✦ Any passage picker with everything but the question
// taken away: book, first pasuk, last pasuk, and a line saying what that comes to.
// The clamping, the reference formatting and the opening are the same code (see
// api.describeRange / api.openPassage), so a passage chosen here is exactly the
// passage the workshop would have opened.

let picking = null;   // { part, books, book, from, to } while the sheet is open

async function openPicker(p) {
  const existing = plan.customFor(p, current);
  const ref = plan.partRef(p, current);
  const books = await api.books();
  if (!books.length) return;
  // Start from wherever the part points now, so "the same chapter, four pesukim
  // later" is a couple of taps rather than a search from Genesis 1:1.
  let book = existing ? existing.book : null;
  let from = existing ? existing.from.slice() : null;
  let to = existing ? existing.to.slice() : null;
  if (!book) {
    const span = parseRef(ref);
    const hit = span && books.find((b) => b.en === span.book);
    if (hit) { book = hit.slug; from = span.from; to = span.to; }
  }
  if (!book) { book = books[0].slug; from = [1, 1]; to = [1, 1]; }
  picking = { part: p, books, book, from, to };
  renderPicker();
}

function closePicker() {
  picking = null;
  const sheet = document.getElementById('guidedPick');
  if (sheet) sheet.remove();
}

function pickerBook() {
  return picking.books.find((b) => b.slug === picking.book) || picking.books[0];
}

// The sheet is built once and then updated in place: the four selects keep their
// identity (and the reader's focus) while their option lists and the line saying
// what the choice comes to are rewritten under them.
function renderPicker() {
  if (!picking) return;
  const sheet = document.createElement('div');
  sheet.id = 'guidedPick';
  // The wizard's card, on purpose: this IS another single question about the plan,
  // and it should look and behave like the ones the wizard asks.
  sheet.className = 'onboard g-pick';
  const label = plan.partLabel(picking.part, current).toLowerCase();
  const who = plan.possessive(current) === 'your' ? 'you' : (current.learner || 'they');
  const appointed = plan.appointedRef(picking.part, current);
  const numRow = (id) => `
    <div class="g-pick-row">
      <select class="g-pick-num" id="${id}C" aria-label="Chapter"></select>
      <span class="g-pick-sep">:</span>
      <select class="g-pick-num" id="${id}V" aria-label="Pasuk"></select>
    </div>`;
  sheet.innerHTML = `
    <div class="ob-card" role="dialog" aria-modal="true" aria-label="Choose a passage">
      <div class="ob-body">
        <h2 class="ob-h">What will ${escapeHtml(who)} chant?</h2>
        <p class="ob-sub">Any pesukim of any book, in the ${label === 'haftarah' ? 'haftarah' : 'Torah'} melody.${appointed
          ? ` The ${escapeHtml(label)} appointed for ${escapeHtml(current.parashah)} is ${escapeHtml(appointed)}.` : ''}</p>
        <p class="ob-label">Book</p>
        <select class="ob-input" id="gPickBook">${picking.books.map((b) => `
          <option value="${escapeAttr(b.slug)}"${b.slug === picking.book ? ' selected' : ''}>${escapeHtml(b.en)}</option>`).join('')}
        </select>
        <p class="ob-label">From</p>
        ${numRow('gPickFrom')}
        <p class="ob-label">To</p>
        ${numRow('gPickTo')}
        <div id="gPickInfo"></div>
        <button class="ob-go ob-primary" id="gPickGo">Chant this instead</button>
        ${plan.customFor(picking.part, current) ? `<button class="ob-go ob-ghost" id="gPickReset">\u21a9 Back to the appointed ${escapeHtml(label)}${appointed ? ` (${escapeHtml(appointed)})` : ''}</button>` : ''}
        <button class="ob-go ob-ghost" id="gPickCancel">Cancel</button>
      </div>
    </div>`;
  const old = document.getElementById('guidedPick');
  if (old) old.remove();
  document.body.appendChild(sheet);
  wirePicker();
  refreshPicker();
}

// Option lists, then the verdict. Called after every change, and after the range
// has been clamped, so what is on screen always describes a passage that exists.
function refreshPicker() {
  const book = pickerBook();
  const byId = (id) => document.getElementById(id);
  const fill = (sel, count, val) => {
    if (sel.options.length !== count) {
      let html = '';
      for (let n = 1; n <= count; n++) html += `<option value="${n}">${n}</option>`;
      sel.innerHTML = html;
    }
    sel.value = String(val);
  };
  // Chapter 9 of Amos has 15 pesukim and chapter 1 has 15 too, but chapter 5 has 27:
  // moving the chapter can leave the pasuk beyond the end of it.
  const lastOf = (c) => book.chapters[c - 1] || 1;
  picking.from = [picking.from[0], Math.min(picking.from[1], lastOf(picking.from[0]))];
  picking.to = [picking.to[0], Math.min(picking.to[1], lastOf(picking.to[0]))];
  fill(byId('gPickFromC'), book.chapters.length, picking.from[0]);
  fill(byId('gPickFromV'), lastOf(picking.from[0]), picking.from[1]);
  fill(byId('gPickToC'), book.chapters.length, picking.to[0]);
  fill(byId('gPickToV'), lastOf(picking.to[0]), picking.to[1]);

  const desc = api.describeRange(picking.book, picking.from, picking.to);
  const tooLong = !!desc && desc.count > desc.max;
  byId('gPickInfo').innerHTML = `
    ${desc ? `
      <div class="ob-parashah ob-parashah-sm">
        <p class="ob-pname">${escapeHtml(desc.ref)}</p>
        <p class="ob-phe" lang="he" dir="rtl">${escapeHtml(desc.heRef)}</p>
        <p class="ob-pmeta">${desc.count} ${desc.count === 1 ? 'pasuk' : 'pesukim'}</p>
      </div>` : ''}
    ${tooLong ? `<p class="ob-warn">${desc.count} pesukim is more than the ${desc.max} the app will prepare at once \u2014 pick a shorter passage.</p>` : ''}
    ${desc && !tooLong ? voiceNote(desc) : ''}
    ${book.accents === 'poetic' ? `<p class="ob-note">${escapeHtml(book.en)} is written with the poetic accents, which are chanted to a different system. The trope here will be the ordinary one.</p>` : ''}`;
  // Landing on the appointed passage is not a substitution, so the button stops
  // saying "instead" — and pressing it puts the plan back on the calendar's own
  // reading rather than storing a substitution identical to it (see applyPick).
  byId('gPickGo').textContent = isAppointed(desc) ? 'Chant this' : 'Chant this instead';
  byId('gPickGo').disabled = tooLong || !desc;
}

// Whose voice this passage will be chanted in, said before the reader commits to it.
// Recordings exist for the readings the app was built with; the rest of Tanakh — any
// haftarah outside the weekly cycle, for instance — has no recording anywhere, and
// the app teaches it from the trope shapes measured across the recordings it has.
// That is a real difference to a reader listening for a cantor, so it belongs on
// this screen rather than being discovered after the fact.
function voiceNote(desc) {
  const rec = desc.recording;
  if (rec && rec.exact) {
    return `<p class="ob-note ob-good">\u266a Recorded \u2014 these are the pesukim of
      ${escapeHtml(rec.label)}, so ${escapeHtml(plan.possessive(current) === 'your' ? 'you' : (current.learner || 'they'))}
      will be chanting along with the cantor.</p>`;
  }
  if (rec) {
    return `<p class="ob-note">These pesukim sit inside ${escapeHtml(rec.label)}, which is recorded.
      Choose that whole passage and the cantor sings it; as it stands the guide voice will be synthesized.</p>`;
  }
  return `<p class="ob-note">No one has recorded these pesukim, so the guide voice will be
    synthesized \u2014 the words and the accents are exact, and every accent\u2019s tune and timing is
    measured from the cantor\u2019s own chanting, but there is no human recitation of this passage to copy.</p>`;
}

// Whether what is on screen is simply the passage the calendar appointed. Compared
// as pesukim rather than as strings, because the calendar and the picker write a
// reference in their own hands.
function isAppointed(desc) {
  const app = parseRef(plan.appointedRef(picking.part, current));
  if (!desc || !app || app.book !== desc.book.en) return false;
  return app.from[0] === desc.from[0] && app.from[1] === desc.from[1]
    && app.to[0] === desc.to[0] && app.to[1] === desc.to[1];
}

function wirePicker() {
  const byId = (id) => document.getElementById(id);
  byId('gPickBook').addEventListener('change', (e) => {
    picking.book = e.target.value;
    // Chapter 51 means nothing in the next book along, so a new book starts at 1:1.
    picking.from = [1, 1];
    picking.to = [1, 1];
    refreshPicker();
  });
  // `moved` is the end the reader just touched. If the two ends cross, the OTHER end
  // follows — dragging "to" back before "from" means a shorter passage, not a
  // passage that runs backwards, and silently swapping them would leave the reader
  // looking at a range they never asked for.
  const read = (moved) => () => {
    const v = (id) => Number(byId(id).value) || 1;
    let from = [v('gPickFromC'), v('gPickFromV')];
    let to = [v('gPickToC'), v('gPickToV')];
    const after = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
    if (after(from, to)) {
      if (moved === 'from') to = from.slice();
      else from = to.slice();
    }
    // Clamped to the book by the same code the workshop's picker uses.
    const d = api.describeRange(picking.book, from, to);
    picking.from = d ? d.from : from;
    picking.to = d ? d.to : to;
    refreshPicker();
  };
  byId('gPickFromC').addEventListener('change', read('from'));
  byId('gPickFromV').addEventListener('change', read('from'));
  byId('gPickToC').addEventListener('change', read('to'));
  byId('gPickToV').addEventListener('change', read('to'));
  byId('gPickCancel').addEventListener('click', closePicker);
  const reset = byId('gPickReset');
  if (reset) reset.addEventListener('click', () => applyPick(picking.part, null));
  byId('gPickGo').addEventListener('click', () => {
    const desc = api.describeRange(picking.book, picking.from, picking.to);
    if (!desc || desc.count > desc.max) return;
    if (isAppointed(desc)) {
      applyPick(picking.part, null);
      return;
    }
    applyPick(picking.part, {
      book: desc.book.slug,
      bookEn: desc.book.en,
      bookHe: desc.book.he,
      from: desc.from,
      to: desc.to,
      ref: desc.ref,
      heRef: desc.heRef,
      readingId: desc.readingId,
      progressSlug: desc.progressSlug,
      count: desc.count,
      // These pesukim ARE a reading the app ships with a recording (another week's
      // haftarah, say). Open that rather than assembling the same words out of the
      // book text, or the reader would be taught by the synthesized guide while a
      // recording of exactly this passage sat unused.
      recordedAs: desc.recording && desc.recording.exact ? desc.recording.slug : null,
    });
  });
}

// Commit a substitution (or `null` to go back to the appointed passage) and open
// it. Opening is the point: the reader has just said what they are going to chant,
// so the next thing they should see is its first pasuk, not the menu they came from.
function applyPick(p, desc) {
  closePicker();
  closeMenu();
  plan.setCustom(p, desc);
  current = plan.get();
  if (api.planChanged) api.planChanged();
  openPart(p);
}

// --- Progress, for anywhere outside guided mode ------------------------------

// A one-line readiness figure for the plan as a whole, used by the "currently
// learning" chip in expert mode's header. Computed from the store alone, so it
// needs no reading to be loaded.
export function planReadiness(p = plan.get()) {
  if (!p) return null;
  const parts = p.parts || [];
  if (!parts.length) return null;
  let sum = 0;
  let counted = 0;
  for (const pt of parts) {
    const target = plan.partTarget(pt, p);
    if (!target) continue;
    // A one-text part (a haftarah, or a passage the reader picked instead) has no
    // cycle: the app pins it to annual when it loads it, so that is where its score
    // is filed. A picked passage is also filed under the book and where it starts,
    // not under a reading slug — see tanakh.progressSlug.
    const whole = target.kind !== 'parashah';
    const slug = target.kind === 'passage'
      ? (target.custom.progressSlug || target.readingId)
      : (whole ? target.readingId : p.slug);
    const key = target.kind === 'passage' ? 'C' : (target.aliyah || 'H');
    const score = whole
      ? store.getAliyahScore(slug, 'annual', 1, key)
      : store.getAliyahScore(slug, p.cycle, p.triYear, key);
    sum += Math.min(100, score);
    counted += 1;
  }
  return counted ? Math.round(sum / counted) : 0;
}

export { calendar };

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) { return escapeHtml(s); }
