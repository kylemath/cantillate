import { tokenize, renderWord, toScroll, stripNikud, stripTaamim } from './hebrew.js';
import { transliterate } from './translit.js';
import { buildLineMelody, splitPhrases, splitAtRank, RANK, RANK_LABELS, rankFor, FAMILIES,
  markGlyph, NAMES, motifFor, nameFor, SOF_PASUK_NAME, sofPasukMotif,
  STYLES, DEFAULT_STYLE, styleOf } from './trope.js';
import { singSteps, playTone, stopPlayback } from './audio.js';
import { playSegment, stopVerseAudio, pauseVerseAudio, resumeVerseAudio, seekVerseAudio,
  previewVerseAudio, isVerseAudioLoaded, isVerseAudioPaused, verseAudioProgress,
  setAudioCuts } from './realaudio.js';
import { startMic, stopMic } from './pitch.js';
import { ContourView, Spectrogram, scoreTrail, scoreNotes, stepsToPoints, sampleContour } from './viz.js';
import { LEVELS, levelById, VERSE_MODES, skillForLevel, DIVISIONS, divisionByRank,
  FULL_VERSE_LEVEL } from './levels.js';
import { aliyotFor, parashahOf, currentTriennialYear } from './aliyot.js';
import * as corpus from './tanakh.js';
import * as store from './store.js';
import * as auth from './auth.js';
import * as scores from './scores.js';
import * as offline from './offline.js';
import { loadTikkunData, renderTikkunPages, TIKKUN_DATA_URL } from './tikkun.js';

// The plan, the guided surface and the wizard are only reachable from a reading
// plan, so they are fetched when one exists (or is about to) rather than at
// startup: a reader who opens the workshop never pays for them. Everything
// outside those three modules treats them as possibly-absent — see
// ensureGuided/ensureWizard below, and store.getPlan() for "is there a plan"
// without loading anything.
let plan = null;
let guided = null;
let onboarding = null;
let _planLoad = null;
let _guidedLoad = null;
let _wizardLoad = null;
let _guidedCssLoad = null;

// guided.css styles the wizard as well as the guided surface, so both entry
// points wait on it — otherwise the sheet paints unstyled for a frame.
function ensureGuidedCss() {
  if (_guidedCssLoad) return _guidedCssLoad;
  _guidedCssLoad = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/guided.css';
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
    document.head.appendChild(link);
  });
  return _guidedCssLoad;
}

function ensurePlan() {
  if (!_planLoad) _planLoad = import('./plan.js').then((m) => { plan = m; return m; });
  return _planLoad;
}

// Installing the bridge here rather than in init() is what keeps the whole
// guided module graph (guided -> schedule -> calendar) off the first paint.
function ensureGuided() {
  if (!_guidedLoad) {
    _guidedLoad = Promise.all([import('./guided.js'), ensurePlan(), ensureGuidedCss()])
      .then(([m]) => { guided = m; m.install(guidedApi()); return m; });
  }
  return _guidedLoad;
}

function ensureWizard() {
  if (!_wizardLoad) {
    _wizardLoad = Promise.all([import('./onboarding.js'), ensurePlan(), ensureGuidedCss()])
      .then(([m]) => { onboarding = m; return m; });
  }
  return _wizardLoad;
}

// An aliyah's scroll+yad challenge unlocks once every pasuk in it has reached at
// least this stage (i.e., the learner has worked it up to whole-verse practice).
const ALIYAH_READY_LEVEL = FULL_VERSE_LEVEL;

// Readings are auto-discovered from data/readings.json (updated by
// scripts/build_reading.py). This hardcoded list is the fallback if the manifest
// can't be loaded, so adding a reading normally needs no code change here.
let AVAILABLE = [
  { slug: 'devarim1', file: 'data/devarim1.json', label: 'Devarim (Deuteronomy) 1' },
  { slug: 'vaetchanan', file: 'data/vaetchanan.json', label: "Va'etchanan (Deuteronomy 3:23–7:11)" },
];

const state = {
  data: null,
  tikkun: null,       // fixed Davidovich 245-column / 42-line page layout
  audio: null,        // per-verse recorded-chant ranges
  pitch: null,        // per-word extracted note steps
  shapes: null,       // averaged per-trope shapes (for legend icons)
  sources: [],        // the current reading's available audio sources (voices)
  audioSource: null,  // id of the active audio source (voice) for this reading
  coach: null,        // current window's coach data
  verseSegs: [],      // all word segments of the selected verse
  units: [],          // current pages (word-groups / phrases / verse)
  focusIndex: 0,      // currently focused word (for keyboard nav)
  slug: null,
  showVowels: true,
  showTaamim: true,
  scroll: false,
  showEnglish: false, // show the English (Koren Jerusalem) translation column
  showTranslit: false, // Latin letters under each word (stages 1-5 only)
  overlay: 'off',     // left-column score overlay: 'off'|'word'|'phrase'|'verse'
  // The "Portion" selector drives these two: annual = whole parashah;
  // triennial + triYear = one shorter year (its own aliyot AND verse range).
  cycle: 'triennial', // aliyah cycle: 'annual' | 'triennial'
  triYear: 1,         // triennial cycle year (1-3)
  readingId: null,    // the menu entry in use (may differ from slug for excerpts)
  readingKind: 'parashah', // see readingKind(): parashah|haftarah|excerpt|drill|custom
  excerpt: null,      // manifest entry when the reading is a named passage
  drill: null,        // manifest entry when the reading is a synthetic drill set
  custom: null,       // {book, from, to, count} when the reader picked the range
  // Which melody the open reading is taught in: 'torah' or 'haftarah'. The same
  // accents, a different tune for each of them — so this picks the motif table
  // (trope.js) AND which measured corpus of shapes the coach line falls back to.
  tropeStyle: DEFAULT_STYLE,
  aliyah: null,       // currently-open aliyah challenge (null = normal practice)
  aliyahCue: 'word',  // yad outline granularity in aliyah mode: 'word' | 'phrase'
  stamHand: 'shlomo', // scribal hand for every STA"M surface: 'shlomo' | 'ashkenaz'
  stamTrack: 0.05,    // STA"M letter-spacing, em (see applyStamTrack)
  scrollView: false,  // Torah-column (STA"M) pane expanded on desktop / full-screen on mobile
  scrollTextMode: 'stam', // full-reading surface: 'stam' | 'pointed' | 'dual'
  scrollSync: true,   // in dual mode, keep both columns on the same visible word
  textCollapsed: false, // desktop: collapse the pesukim / aliyot pane to a rail
  practiceCollapsed: false, // desktop: collapse the coach pane to a rail
  scrollZoom: false,  // guitar-hero: zoom to ~5 words and auto-scroll the line
  tonicHz: 220,
  division: 'full',  // legacy field; verse range now derives from cycle/triYear (see divisionRange)
  readScale: 1.6,     // reading-size multiplier: bigger Hebrew, smaller notation
  showAnalysis: false, // desktop: reveal the spectrograms + accuracy bars (off = the
                       // coaching contour fills the pane so slight tone shifts show)
  selectedVerse: null,
  level: 1,
  unitIndex: 0,
  divideRank: null,   // section stage: how coarsely to cut the verse (see DIVISIONS)
  openAliyot: null,   // Set of expanded aliyah keys in the left pesukim list
  chainSize: 2,       // pesukim per verse-chain run (see buildChainStrip)
  paused: false,      // transport is held mid-verse (see pauseTransport)
  pausedAt: 0,        // normalized position, 0..1, where the transport is held
  recording: false,
  playingReal: false,
  view: null,
  spectro: null,
  realSamples: [],
  targetPoints: [],
  unitSegs: [],
  expectedDur: 2.5,
  recStart: 0,
  highlight: null,    // { kind: 'taam'|'family', value }
  guideOpen: false,   // the optional vertical "Trope guide" panel is shown
  colorMode: 'full',  // pesukim colouring: 'full' | 'trope' | 'grey'
  // Which scoring model "counts" (stored bests, stars, unlocks). Both models are
  // always computed and shown side by side for dev/testing (see scoreSteps).
  //   'contour' = melody/shape scorer (scoreTrail, the original)
  //   'gh'      = Guitar-Hero note-hit scorer (scoreNotes)
  scoreModel: 'contour',
};

// The service-worker auto-update consults this before it reloads the page (see
// index.html). A reload mid-take loses the recording and its score, and one
// mid-playback cuts the chant off; __cantillateBusy alone only covers the former.
window.__cantillateReloadSafe = () =>
  !window.__cantillateBusy && !state.recording && !state.playingReal;

// Neutral ink for words/vowels when colour is limited to the trope (or off).
const INK_GREY = '#aab0c8';

// Size of the transliteration line, as a fraction of the Hebrew above it. Kept
// here (and mirrored by --wtl-em in the CSS) because the coaching pane has to
// budget the pixels for it before anything is laid out — see wordsBandPx.
const TRANSLIT_EM = 0.5;

const $ = (id) => document.getElementById(id);

// User-facing label for a verse. Multi-chapter readings carry per-verse chapter
// (c) and verse (v) numbers, shown as plain "chapter:verse" so the reference is
// unambiguous across chapters. Single-chapter readings (no c/v) fall back to the
// Hebrew-numeral verse index, as before.
function verseRefLabel(verse, n) {
  // Drill lines aren't scripture, so they carry their own label ("shalom · 3.2")
  // instead of a chapter:verse that would imply one.
  if (verse && verse.ref && verse.label) return `${verse.label} · ${verse.ref}`;
  if (verse && verse.c != null && verse.v != null) return `${verse.c}:${verse.v}`;
  return `${toHebrewNum(n)}`;
}

// The running verse number shown after the reference. A single-chapter reading
// needs it (its ref is only a Hebrew numeral); a multi-chapter one already reads
// "6:4", and a drill line carries its own label, so both suppress it.
function verseIndexSuffix(verse, n, word = 'v') {
  if (state.data.multiChapter || (verse && verse.label)) return '';
  return ` · ${word}${n}`;
}

// A human ref for a verse range (e.g. "1:1–1:10"), used when rebuilding labels
// for user-edited aliyah boundaries.
function rangeRef(startN, endN) {
  const vs = state.data.verses;
  const s = vs[startN - 1], e = vs[endN - 1];
  if (!s || !e) return '';
  const sL = verseRefLabel(s, startN), eL = verseRefLabel(e, endN);
  return sL === eL ? sL : `${sL}–${eL}`;
}

// The parashah context for the current reading: prefer the data file's own
// parashah block (multi-chapter readings), else the hardcoded table in aliyot.js.
function parashahForReading() {
  return (state.data && state.data.parashah) || parashahOf(state.slug);
}

// A stable key for a cycle+year partition, used for per-user custom-boundary
// storage (annual is one partition; each triennial year is its own).
function cycleKeyFor(cycle, year) {
  return cycle === 'triennial' ? `tri${year}` : 'annual';
}

// The DEFAULT aliyah list for a cycle/year: prefer the data file's own aliyot
// block (with sequential-n start/end indices), else the hardcoded table.
function defaultAliyot(cycle, year) {
  if (state.data && state.data.aliyot) {
    return cycle === 'triennial'
      ? (state.data.aliyot.triennial[year] || [])
      : (state.data.aliyot.annual || []);
  }
  return aliyotFor(state.slug, cycle, year);
}

// The aliyah list the USER sees/practices: their saved custom boundaries if any,
// else the default partition. Leaderboards deliberately ignore custom overrides
// (they roll up from pesukim onto the default partition), so this only affects
// what the user chants as a single aliyah take.
function aliyotForReading(cycle, year) {
  const base = defaultAliyot(cycle, year);
  const custom = state.slug && store.getAliyotCustom(state.slug, cycleKeyFor(cycle, year));
  if (custom && custom.length) return custom;
  return base;
}

// The maftir for a cycle/year (a distinct scored unit that repeats the closing
// pesukim), or null if this reading has no maftir data. It carries n:'M' and the
// same start/end verse-index + ref shape as an aliyah, so the card, practice
// view and scoring treat it like an aliyah keyed 'M'. Read straight from the
// data file (maftir isn't user-editable), gracefully null for the hardcoded
// fallback table.
function maftirForReading(cycle, year) {
  const m = state.data && state.data.aliyot && state.data.aliyot.maftir;
  if (!m) return null;
  return cycle === 'triennial' ? (m.triennial && m.triennial[year]) || null : m.annual || null;
}

// The Deuteronomy summer readings this app ships are chanted on consecutive
// Shabbatot anchored to Tisha B'Av (9 Av): Devarim on Shabbat Chazon (the
// Shabbat on/before 9 Av), then Va'etchanan (Nachamu) and Eikev on the two
// Shabbatot after. Mapping each slug to its week offset from Devarim's Shabbat
// lets the app open the parashah of the UPCOMING Shabbat by default.
const READING_WEEK_OFFSET = { devarim1: 0, vaetchanan: 1, eikev: 2 };

// Gregorian date (local noon) of 9 Av in the given civil year, found via the
// browser's built-in Hebrew calendar. 9 Av always lands in Jul–Aug/Sep.
function dateOf9Av(civilYear) {
  const fmt = new Intl.DateTimeFormat('en-US-u-ca-hebrew', { month: 'long', day: 'numeric' });
  for (let m = 5; m <= 8; m++) { // Jun–Sep (0-indexed)
    const days = new Date(civilYear, m + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const dt = new Date(civilYear, m, d, 12);
      let mo, da;
      for (const p of fmt.formatToParts(dt)) {
        if (p.type === 'month') mo = p.value;
        if (p.type === 'day') da = p.value;
      }
      if (mo === 'Av' && da === '9') return dt;
    }
  }
  return null;
}

// Slug of the reading for the upcoming Shabbat (this coming Saturday, or today
// if today is Saturday), or null if that Shabbat is outside the shipped set.
function upcomingParashahSlug(available, today = new Date()) {
  // The next Saturday (inclusive of today when today is Shabbat).
  const sat = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7));

  const nineAv = dateOf9Av(sat.getFullYear());
  if (!nineAv) return null;

  // Devarim's Shabbat (Shabbat Chazon): the last Saturday on/before 9 Av.
  const devSat = new Date(nineAv);
  devSat.setDate(devSat.getDate() - ((devSat.getDay() - 6 + 7) % 7));

  // Which week (relative to Devarim's Shabbat) the upcoming Shabbat falls in.
  const weekIdx = Math.round((sat - devSat) / (7 * 864e5));
  const slug = Object.keys(READING_WEEK_OFFSET).find((k) => READING_WEEK_OFFSET[k] === weekIdx);
  return slug && available.some((a) => a.slug === slug) ? slug : null;
}

// Group the reading menu into <optgroup>s so the weekly parashiyot, the
// standalone prayers and the trope drills read as three different kinds of thing
// rather than one long list.
function renderReadingMenu(sel = $('parashah')) {
  if (!sel) return;
  // Rebuilt in place, so whatever is open stays open: this runs again whenever the
  // plan changes (the stars below) or a passage is added, not only at startup.
  const open = sel.value;
  sel.innerHTML = '';
  const order = [];
  const byGroup = new Map();
  for (const p of AVAILABLE) {
    const g = p.group || 'Parashiyot';
    if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
    byGroup.get(g).push(p);
  }
  // The readings the reader is actually preparing get a ★, so they are findable
  // in a menu of 33 entries without having to remember which parashah it was.
  const learning = new Set(plan ? plan.readingSlugs() : []);
  const single = order.length < 2;
  for (const g of order) {
    const parent = single ? sel : document.createElement('optgroup');
    if (!single) parent.label = g;
    for (const p of byGroup.get(g)) {
      const o = document.createElement('option');
      o.value = p.slug;
      o.textContent = learning.has(p.slug) ? `\u2605 ${p.label}` : p.label;
      if (p.note) o.title = p.note;
      parent.appendChild(o);
    }
    if (!single) sel.appendChild(parent);
  }
  if (open && [...sel.options].some((o) => o.value === open)) sel.value = open;
}

// The reading the plan's active part lives in, when guided mode is what this
// visit is going to open into and the app can already name that reading. Null
// for everyone else, and for a plan pointing at a passage that is not in the
// menu yet — guided mode opens those itself once it has run.
async function plannedStartSlug() {
  const saved = store.getPlan();
  if (!saved || guidedPreference() === 'expert') return null;
  await ensureGuided();
  const target = plan.partTarget(plan.activePart(saved), saved);
  const id = target && target.readingId;
  return id && AVAILABLE.some((p) => p.slug === id) ? id : null;
}

async function init() {
  loadPanePrefs();
  // Apply pane classes before the first paint of loaded content so the rail
  // layout matches saved prefs without a flash of the expanded panes.
  document.body.classList.toggle('scroll-view', state.scrollView);
  document.body.classList.toggle('pane-text-collapsed', state.textCollapsed);
  document.body.classList.toggle('pane-practice-collapsed', state.practiceCollapsed);
  // Auto-discover readings from the manifest (falls back to the hardcoded list).
  try {
    const rr = await fetch('data/readings.json');
    if (rr.ok) {
      const list = await rr.json();
      if (Array.isArray(list) && list.length) AVAILABLE = list;
    }
  } catch (e) { /* keep the hardcoded fallback */ }

  // Populate the reading selector. Entries carry an optional `group` so the
  // parashiyot, the standalone prayers and the trope drills stay visually
  // separate in one menu.
  const sel = $('parashah');
  renderReadingMenu(sel);
  // Passages the reader picked out of a book in earlier sittings go back in the
  // menu (see openCustomRange); the text itself is only fetched if one is
  // opened. Restored before the first reading is chosen so that a plan pointing
  // at one of them can open it directly.
  await restoreCustomRanges();

  // Open the upcoming week's parashah by default (falls back to the first
  // full parashah, never a drill or an excerpt) — unless a plan is about to
  // take over, in which case open what the plan is preparing instead. Loading
  // one or the other, rather than one and then the other, is the difference
  // between one reading fetch at startup and two.
  const firstParashah = AVAILABLE.find((p) => readingKind(p) === 'parashah') || AVAILABLE[0];
  const startSlug = (await plannedStartSlug())
    || upcomingParashahSlug(AVAILABLE) || firstParashah.slug;
  sel.value = startSlug;
  await loadData(startSlug);

  sel.addEventListener('change', () => loadData(sel.value));
  $('tonic').addEventListener('change', (e) => { state.tonicHz = parseFloat(e.target.value); });
  $('audioSource').addEventListener('change', (e) => { switchAudioSource(e.target.value); });

  bindToggle('tgVowels', () => { state.showVowels = !state.showVowels; refreshText(); });
  bindToggle('tgTaamim', () => { state.showTaamim = !state.showTaamim; refreshText(); });
  bindToggle('tgFont', () => { state.scroll = !state.scroll; refreshText(); });
  bindToggle('tgEnglish', () => {
    state.showEnglish = !state.showEnglish;
    renderVerses();
    if (state.showEnglish) ensureCustomEnglish();
  });
  initTranslit();
  bindToggle('tgTranslit', () => setTranslit(!state.showTranslit));
  $('overlaySeg').querySelectorAll('.ov').forEach((b) => {
    b.addEventListener('click', () => { state.overlay = b.dataset.ov; syncToggleUI(); renderVerses(); });
  });
  initScoreModel();
  $('scoreModelSeg').querySelectorAll('.sm').forEach((b) => {
    b.addEventListener('click', () => setScoreModel(b.dataset.sm));
  });
  initStamHand();
  $('stamHandSeg').querySelectorAll('.sh').forEach((b) => {
    b.addEventListener('click', () => setStamHand(b.dataset.sh));
  });
  setupStamTrack();
  setupPaneToggles();
  const textMode = $('scrollTextModeSeg');
  if (textMode) textMode.querySelectorAll('[data-scroll-text]').forEach((b) => {
    b.addEventListener('click', () => setScrollTextMode(b.dataset.scrollText));
  });
  const scrollSync = $('scrollSync');
  if (scrollSync) scrollSync.addEventListener('click', () => setScrollSync(!state.scrollSync));
  // A single "Portion" selector is the sole control for how much of the parashah
  // you read: the full annual reading, or one shorter triennial-cycle year. The
  // triennial year drives both the aliyah boundaries AND the range of verses
  // shown (see divisionRange), so there is one place to choose a shorter reading
  // instead of two overlapping controls. (📅 Today jumps to the current year.)
  $('portion').addEventListener('change', (e) => {
    applyPortion(e.target.value);
    renderAliyot(); renderVerses();
  });
  $('cycToday').addEventListener('click', () => {
    state.cycle = 'triennial';
    state.triYear = currentTriennialYear();
    syncPortionUI(); renderAliyot(); renderVerses();
  });
  syncPortionUI();

  state.readScale = loadReadScale();
  state.showAnalysis = loadAnalysisPref();
  setupGuide();
  document.addEventListener('keydown', onKey);
  setupSplitter();
  setupLeftSize();
  setupSettingsSheet();
  setupOrientation();
  setupPasukDrawer();
  setupWordLookup();
  setupAuth();
  setupLeaderboard();
  setupAliyotEditor();
  setupCustomPicker();
  setupOfflineButton();
  setupNetBadge();

  // Guided mode. A reader who has told the app what they are learning gets the
  // narrowed, one-thing-at-a-time surface by default; one who hasn't gets the
  // workshop, plus an invitation to say. The wizard is only forced on a genuinely
  // first-time visitor, so a returning expert user is never interrupted by it.
  renderLearningChip();
  const wanted = guidedPreference();
  if (wanted === 'expert') { markFirstVisitDone(); return; }
  if (store.getPlan()) await enterGuided();
  else if (wanted === 'guided' || isFirstVisit()) await openWizard();
  markFirstVisitDone();
}

// `?guided=0` (or `?mode=expert`) opens straight into the workshop even for a
// reader with a plan, and `?guided=1` asks for the guided surface. Link-level
// rather than a setting: it is how a teacher shares the workshop with a student
// who is otherwise in guided mode, and how the headless UI walkthrough
// (scripts/check_app.py) reaches expert mode from an empty browser profile.
function guidedPreference() {
  try {
    const q = new URLSearchParams(window.location.search);
    const g = q.get('guided');
    const m = q.get('mode');
    if (g === '0' || g === 'off' || m === 'expert') return 'expert';
    if (g === '1' || g === 'on' || m === 'guided') return 'guided';
  } catch (e) { /* no URL API */ }
  return null;
}

// Whether anything has ever been practised in this browser. A reader with scores
// but no plan chose the workshop; don't put a wizard in front of them.
const SEEN_KEY = 'cantillate.seen';

function isFirstVisit() {
  try {
    if (localStorage.getItem(SEEN_KEY)) return false;
    const all = store.getAll();
    const touched = ['verses', 'words', 'levels', 'aliyot', 'modes']
      .some((k) => all[k] && Object.keys(all[k]).length);
    return !touched;
  } catch (e) { return false; }
}

function markFirstVisitDone() {
  try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch (e) { /* private mode */ }
}

// ---------------------------------------------------------------------------
// Guided mode ("currently learning"). The bridge to js/guided.js, which is the
// same engine with a much smaller surface for a reader preparing one reading for
// one date. Guided mode never reaches into the state above; everything it needs
// is in this one object, so the two halves stay separable — and every play,
// record and score still goes through exactly the code path expert mode uses.
// ---------------------------------------------------------------------------

// Is there a human recording of these pesukim? Every reading in the manifest says
// which verses it covers (`covers`, stamped by scripts/organize_readings.py), so
// this is a table lookup rather than thirty fetches — and the answer is the
// difference between chanting along with a cantor and being taught by the measured
// trope shapes. A range that only PART of a reading covers still counts: the app
// can open that reading and the words are in it.
//
// Returns { slug, label, exact } for the tightest recorded reading that contains
// the range, or null.
function recordingCovering(bookEn, from, to) {
  const abs = (r) => r[0] * 1000 + r[1];   // chapters are never 1000 pesukim long
  const a = abs(from);
  const b = abs(to);
  let best = null;
  for (const meta of AVAILABLE) {
    const c = meta.covers;
    if (!c || c.book !== bookEn || !readingSources(meta).length) continue;
    const lo = abs(c.from);
    const hi = abs(c.to);
    if (lo > a || hi < b) continue;
    const span = hi - lo;
    if (!best || span < best.span) {
      best = { slug: meta.slug, label: meta.label, exact: lo === a && hi === b, span };
    }
  }
  if (!best) return null;
  delete best.span;
  return best;
}

function guidedApi() {
  return {
    available: () => AVAILABLE,
    readingId: () => state.readingId,
    readingSlug: () => state.slug,
    verseCount: () => (state.data ? state.data.verses.length : 0),
    // The reading selector is the workshop's own source of truth for "what is
    // open", and guided mode changes readings behind its back — so keep it in step,
    // or crossing into expert mode lands on a menu naming the wrong reading.
    loadReading: async (readingId) => {
      const out = await loadData(readingId);
      const sel = $('parashah');
      if (sel && [...sel.options].some((o) => o.value === readingId)) sel.value = readingId;
      return out;
    },
    openPassage: (book, from, to, opts) => openCustomRange(book, from, to, opts),
    // Async, unlike the internal one: guided mode may be the first thing in the
    // session to want a Tanakh book, and the index is only fetched on demand (the
    // "Any passage" picker normally triggers it).
    bookSlugFor: async (en) => {
      try { await corpus.loadIndex(); } catch (e) { return null; }
      return bookSlugFor(en);
    },

    // The Tanakh book list, for guided mode's "a different haftarah" picker. Same
    // index, same clamping and same reference formatting the ✦ Any passage picker
    // uses, so a passage chosen in either place is the same passage.
    books: async () => {
      try {
        const idx = await corpus.loadIndex();
        return (idx.books || []).map((b) => ({
          slug: b.slug, en: b.en, he: b.he,
          chapters: b.chapters.slice(), accents: b.accents,
        }));
      } catch (e) { return []; }
    },
    // A range put in order, clamped to the book, with the count and both refs —
    // everything the picker needs to show what a choice means before opening it.
    describeRange: (bookSlug, from, to) => {
      const entry = corpus.bookEntry(bookSlug);
      if (!entry) return null;
      const r = corpus.normalizeRange(entry, from, to);
      return {
        ...r,
        max: corpus.MAX_VERSES,
        ref: corpus.refFor(entry.en, r.from, r.to),
        heRef: corpus.heRefFor(entry.he, r.from, r.to),
        readingId: corpus.readingId(bookSlug, r.from, r.to),
        // Where practice on this passage is filed: the book and the pasuk it starts
        // at, so every range beginning there shares one tally (see progressSlug).
        progressSlug: corpus.progressSlug(bookSlug, r.from),
        recording: recordingCovering(entry.en, r.from, r.to),
        accents: entry.accents,
        book: { slug: entry.slug, en: entry.en, he: entry.he },
      };
    },

    setPortion: (cycle, year) => {
      if (!hasAliyotCycle(state.readingKind)) return;
      state.cycle = cycle === 'triennial' ? 'triennial' : 'annual';
      state.triYear = Number(year) || 1;
      syncPortionUI();
      renderAliyot();
      renderVerses();
    },
    aliyot: (cycle, year) => aliyotForReading(cycle, year),
    maftir: (cycle, year) => maftirForReading(cycle, year),
    // What each chunk of a reading actually covers, keyed as the chunks are ('1'…'7'
    // for the aliyot, 'M' for the maftir): "Deuteronomy 7:22–7:26", not the whole
    // parashah it sits in. Guided mode needs this for parts it is NOT currently
    // showing — the menu lists all seven aliyot while only one is open — so it reads
    // the reading's own aliyah table, which is where the triennial thirds live. Uses
    // the resident doc when it is the open reading, so the common case costs nothing.
    chunkRefs: async (readingId, cycle, triYear) => {
      const meta = AVAILABLE.find((p) => p.slug === readingId);
      if (!meta) return null;
      let doc = (state.readingId === readingId && state.data) ? state.data : null;
      if (!doc) {
        try { doc = await readingDocFor(meta); } catch (e) { return null; }
      }
      if (!doc || !doc.aliyot) return null;
      const book = (doc.book && doc.book.en) || '';
      const named = (ref) => (book && ref ? `${book} ${ref}` : ref || '');
      const out = {};
      const list = cycle === 'triennial'
        ? (doc.aliyot.triennial && doc.aliyot.triennial[triYear]) || []
        : doc.aliyot.annual || [];
      for (const a of list) out[String(a.n)] = named(a.ref);
      const m = doc.aliyot.maftir;
      const mm = m && (cycle === 'triennial' ? (m.triennial || {})[triYear] : m.annual);
      if (mm) out.M = named(mm.ref);
      return out;
    },
    // Which cycle the OPEN reading is actually on, which is not always the plan's:
    // a haftarah or a picked passage is one fixed text, so loadData pins it to
    // annual. Scores are filed under the cycle, so guided mode has to read them
    // back under the one the app recorded them with.
    cycleNow: () => ({ cycle: state.cycle, triYear: state.triYear }),
    // Whether a human recording of the open reading exists. False for the whole of
    // Tanakh outside the readings this app was built with — a passage picked there
    // is taught from the measured trope shapes, and guided mode says so rather than
    // promising a cantor who never sang it.
    hasRecording: () => !!(state.audio && state.audio.verses
      && Object.keys(state.audio.verses).length),
    // The single chunk of a reading chanted straight through (a haftarah, or a
    // passage picked out of a book). Parashiyot have aliyot instead.
    wholeChunk: () => {
      const list = defaultAliyot('annual', 1);
      const whole = list.find((a) => a.n === 'H' || a.n === 'C' || a.kind === 'passage');
      if (whole) return { ...whole };
      if (hasAliyotCycle(state.readingKind)) return null;
      // An excerpt reuses a parent's text file but only a carved-out verse span
      // (the Shema inside Va'etchanan). Guided mode must practise that span, not
      // the whole parent — otherwise a Shema demo would open on pasuk 1 of the
      // parashah. Drills own their verses, so the full length is correct for them.
      if (state.excerpt) {
        const [start, end] = divisionRange();
        return { n: 'H', kind: 'excerpt', start, end };
      }
      return { n: 'H', kind: state.readingKind === 'drill' ? 'drill' : 'haftarah',
        start: 1, end: state.data.verses.length };
    },

    selectVerse: (n) => selectVerse(n),
    selectStage: (id) => selectStage(id),
    goToUnit: (i) => goToUnit(i),
    openChain: (s, e, opts) => openChain(s, e, opts),
    openAliyah: (a) => openAliyah(a),

    unitsShown: () => (state.units ? state.units.length : 1),
    currentUnitIndex: () => state.unitIndex,
    currentUnitName: () => levelById(state.level).unit,
    unitCount: (verse, level) => unitCountFor(verse, level),
    unitIndexOfWord: (verse, level, gi) => unitIndexOfWord(verse, level, gi),
    verseRef: (n) => {
      const v = state.data && state.data.verses[n - 1];
      return v ? `${state.data.book.en} ${verseRefLabel(v, n)}` : '';
    },
    verseRange: (a, b) => rangeRef(a, b),

    // Guided mode's action bar names an intent ("listen") rather than a button,
    // and which button serves it depends on the stage and whether this reading was
    // recorded. So it hands over the preferences in order and the first one the
    // pane is actually offering wins.
    click: (...ids) => {
      for (const id of ids.flat()) {
        const b = $(id);
        if (b && !b.disabled && !b.hidden) { b.click(); return id; }
      }
      return null;
    },
    stopAll: () => stopAll(),
    isBusy: () => !!(state.recording || state.playingReal || state._aliyaRunning),
    hasRecording: () => !!verseAudio(state.selectedVerse),

    readScale: () => state.readScale,
    setReadScale: (v) => applyReadScale(v, true),
    analysisOn: () => state.showAnalysis,
    setAnalysis: (on) => { if (on !== state.showAnalysis) toggleAnalysis(); },
    scrollTextMode: () => state.scrollTextMode,
    setScrollTextMode: (mode) => setScrollTextMode(mode),
    scrollSync: () => state.scrollSync,
    setScrollSync: (on) => setScrollSync(on),
    // The transliteration is the one aid whose control has to be offered twice.
    // Guided mode hides the workshop's settings sheet, and a reader who cannot
    // yet read the letters is exactly the reader guided mode is for — so the
    // switch has to exist on the narrowed surface too. `allowed` is the stage
    // cap (see translitOn): guided mode uses it to take the row away rather than
    // offer a switch that does nothing.
    translitOn: () => translitOn(),
    translitAllowed: () => state.level <= FULL_VERSE_LEVEL,
    setTranslit: (on) => { if (on !== state.showTranslit) setTranslit(on); },
    download: () => { const b = $('btnOffline'); if (b && !b.hidden) b.click(); },

    // The account, for a reader who never sees the workshop's topbar: guided mode
    // owns the whole screen, so the sign-in button up there may as well not exist.
    // Someone who answered "not now" in the wizard needs a second door, and it
    // belongs next to the other settings rather than behind a trip to the workshop.
    account: () => {
      const state_ = auth.readyState();
      const user = auth.getUser();
      if (!user) return { state: state_, signedIn: false, anon: false, name: '', photo: '' };
      const id = auth.publicIdentity();
      return { state: state_, signedIn: true, anon: auth.isAnon(), name: id.name, photo: id.photo };
    },
    signIn: () => auth.signIn(),
    signOut: () => auth.signOutUser(),
    editIdentity: () => openProfileModal({ firstTime: false }),

    editPlan: () => editPlan(),
    newPlan: () => newPlan(),
    toExpert: () => leaveGuided(),
    // The plan gained or lost a reading (a substituted passage), so the ★ chip and
    // the stars in the reading menu are out of date.
    planChanged: () => renderLearningChip(),
  };
}

// How many words / phrases / sections a stage cuts a pasuk into. The scheduler
// needs this to know when a task is finished; it can't compute it itself (the
// answer is in the text and the accents).
function unitCountFor(verse, level) {
  const units = unitsForVerse(verse, level);
  return units ? units.length : 1;
}

// Which unit of a stage holds a given word, so a repair task aimed at one weak
// word opens on the page that actually contains it.
function unitIndexOfWord(verse, level, gi) {
  const units = unitsForVerse(verse, level);
  if (!units) return 0;
  const at = units.findIndex((u) => u.some((s) => s.index === gi));
  return at < 0 ? 0 : at;
}

// The same division renderPractice would use for a verse at a stage, without
// disturbing the open view (currentUnits reads the SELECTED verse and level).
function unitsForVerse(verse, levelId) {
  const v = state.data && state.data.verses[verse - 1];
  if (!v) return null;
  const segs = verseSegments(verse);
  const level = levelById(levelId);
  if (level.unit === 'word') return groupByMaqaf(segs);
  if (level.unit === 'phrase') return splitPhrases(segs);
  if (level.unit === 'section') return splitAtRank(segs, usableDivideRank(segs, level.divide));
  return [segs];
}

// Guided mode owns the whole screen, so entering it stops whatever expert mode
// was doing and puts the panes into the one layout guided mode draws.
async function enterGuided() {
  stopAll();
  closeSettingsSheet();
  closePasukDrawer();
  await ensureGuided();
  await guided.start(plan.get());
}

function leaveGuided() {
  if (guided) guided.exit();
  renderVerses();
  renderAliyot();
  renderStageBar();
  if (state.selectedVerse != null && !state.aliyah) renderPractice();
  renderLearningChip();
}

// Run the wizard. `editing` pre-fills it from the current plan, so changing the
// date or the cycle is the same three screens rather than a separate editor.
async function openWizard({ editing = null } = {}) {
  const wasGuided = !!guided && guided.isActive();
  if (guided) guided.exit();
  await ensureWizard();
  onboarding.open({
    editing,
    done: (built) => {
      renderLearningChip();
      if (built) enterGuided();
      else if (wasGuided && store.getPlan()) enterGuided();
      // Someone who signed in on the wizard's account screen still has to be
      // asked how they want to appear; it was held back while the sheet was up.
      maybeOfferProfile();
    },
  });
}

function editPlan() { openWizard({ editing: store.getPlan() }); }
function newPlan() { openWizard(); }

// The "currently learning" chip in the topbar: the one thing in expert mode that
// always leads back to the plan, whatever reading happens to be open. It is
// deliberately independent of the open reading and of today's date — a reader
// learning for next spring opens the app on thirty parashiyot that are not
// theirs, and none of them should displace the one that is.
function renderLearningChip() {
  // The reading menu stars whatever the plan needs, so it has to be redrawn
  // whenever the plan changes — which is the same set of moments as the chip.
  renderReadingMenu();
  const slots = document.querySelectorAll('.learningchip');
  if (!slots.length) return;
  const p = store.getPlan();
  // The chip's wording and its readiness percentage both come from the guided
  // modules, so a reader who has a plan gets it filled in once they arrive; one
  // who hasn't gets the invitation with nothing to wait for.
  if (p && !guided) { ensureGuided().then(renderLearningChip); return; }
  const html = p ? chipHtmlFor(p) : startChipHtml();
  for (const box of slots) {
    box.innerHTML = html;
    const btn = box.querySelector('button');
    if (btn) btn.addEventListener('click', () => (p ? enterGuided() : newPlan()));
  }
}

function startChipHtml() {
  return `<button class="learn-start" title="Set up a reading to prepare for a date \u2014 a bar/bat mitzvah, or an aliyah you have been given">\u2605 Learning for a date?</button>`;
}

function chipHtmlFor(p) {
  const who = plan.learnerName(p);
  const ready = guided.planReadiness(p);
  return `<button class="learn-chip"
      title="Go back to what you are learning: ${escapeHtml(plan.summary(p))}">
      <span class="learn-star">\u2605</span>
      <span class="learn-text">
        <b>${escapeHtml(who ? `${who}\u2019s ${p.parashah}` : p.parashah)}</b>
        <span class="learn-sub">${escapeHtml(plan.countdown(p) || plan.occasionLabel(p))}${ready ? ` \u00b7 ${ready}%` : ''}</span>
      </span>
    </button>`;
}

// ---------------------------------------------------------------------------
// Per-user aliyah boundary editor. A rabbi/teacher may divide the reading
// differently; this lets a user set where each aliyah ends (starts follow
// automatically) and saves it for the current cycle/year partition. Leaderboards
// keep using the default partition, so custom splits never fragment the boards.
// ---------------------------------------------------------------------------
function setupAliyotEditor() {
  const btn = $('btnEditAliyot');
  const modal = $('aliyotEditModal');
  if (!btn || !modal) return;
  btn.addEventListener('click', () => openAliyotEditor());
  modal.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => { modal.hidden = true; });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) modal.hidden = true; });
}

function openAliyotEditor() {
  const modal = $('aliyotEditModal');
  const body = $('aliyotEditBody');
  if (!modal || !body) return;
  const maxV = state.data.verses.length;
  const list = aliyotForReading(state.cycle, state.triYear);
  if (!list.length) {
    body.innerHTML = `<p class="lb-empty">This cycle's aliyot fall outside the loaded text, so there are no boundaries to edit here.</p>`;
    modal.hidden = false;
    return;
  }
  const firstStart = list[0].start;
  const rows = list.map((a, i) => {
    const isLast = i === list.length - 1;
    return `<div class="al-edit-row" data-n="${a.n}">
      <span class="al-edit-n">Aliyah ${a.n}</span>
      <label class="al-edit-lbl">ends at verse</label>
      <input class="al-edit-end" type="number" min="1" max="${maxV}" value="${Math.min(a.end, maxV)}" ${isLast ? 'disabled title="the last aliyah ends the reading"' : ''} />
      <span class="al-edit-ref" data-ref></span>
    </div>`;
  }).join('');
  body.innerHTML = `<div class="al-edit-list" data-first="${firstStart}" data-max="${maxV}">${rows}</div>`;
  const refresh = () => refreshEditorRefs(body);
  body.querySelectorAll('.al-edit-end').forEach((inp) => inp.addEventListener('input', refresh));
  refresh();
  $('aliyotSave').onclick = () => { saveAliyotEditor(body); modal.hidden = true; };
  $('aliyotReset').onclick = () => {
    store.setAliyotCustom(state.slug, cycleKeyFor(state.cycle, state.triYear), null);
    modal.hidden = true;
    renderAliyot(); renderVerses();
  };
  modal.hidden = false;
}

// Live-update the "start–end" ref shown next to each editable row as the user
// types, so it's clear which pesukim each aliyah covers.
function refreshEditorRefs(body) {
  const wrap = body.querySelector('.al-edit-list');
  if (!wrap) return;
  const rows = [...wrap.querySelectorAll('.al-edit-row')];
  const maxV = parseInt(wrap.dataset.max, 10);
  let start = parseInt(wrap.dataset.first, 10);
  rows.forEach((row, i) => {
    const inp = row.querySelector('.al-edit-end');
    let end = i === rows.length - 1 ? maxV : parseInt(inp.value, 10);
    if (!Number.isFinite(end)) end = start;
    end = Math.max(start, Math.min(maxV, end));
    row.querySelector('[data-ref]').textContent = rangeRef(start, end);
    start = end + 1;
  });
}

function saveAliyotEditor(body) {
  const wrap = body.querySelector('.al-edit-list');
  if (!wrap) return;
  const rows = [...wrap.querySelectorAll('.al-edit-row')];
  const maxV = parseInt(wrap.dataset.max, 10);
  let start = parseInt(wrap.dataset.first, 10);
  const list = rows.map((row, i) => {
    const n = parseInt(row.dataset.n, 10);
    const inp = row.querySelector('.al-edit-end');
    let end = i === rows.length - 1 ? maxV : parseInt(inp.value, 10);
    if (!Number.isFinite(end)) end = start;
    end = Math.max(start, Math.min(maxV, end));
    const entry = { n, start, end, ref: rangeRef(start, end) };
    start = end + 1;
    return entry;
  });
  store.setAliyotCustom(state.slug, cycleKeyFor(state.cycle, state.triYear), list);
  renderAliyot(); renderVerses();
}

// Settings panel: on a phone the dense header + display controls live in a
// pull-down sheet behind the slim app-bar gear; on desktop the same panel is a
// popover opened from the topbar "Settings" button, so the practice surface
// stays clear either way. Both toggles drive the same body.settings-open flag.
function setSettingsOpen(open) {
  document.body.classList.toggle('settings-open', open);
  const toggle = $('settingsToggle');
  const toggleDesk = $('settingsToggleDesktop');
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (toggleDesk) toggleDesk.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function closeSettingsSheet() { setSettingsOpen(false); }

function setupSettingsSheet() {
  const toggle = $('settingsToggle');
  const toggleDesk = $('settingsToggleDesktop');
  const backdrop = $('settingsBackdrop');
  const closeBtn = $('settingsClose');
  const flip = () => setSettingsOpen(!document.body.classList.contains('settings-open'));
  if (toggle) toggle.addEventListener('click', flip);
  if (toggleDesk) toggleDesk.addEventListener('click', flip);
  if (backdrop) backdrop.addEventListener('click', () => closeSettingsSheet());
  if (closeBtn) closeBtn.addEventListener('click', () => closeSettingsSheet());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('settings-open')) closeSettingsSheet();
  });
}

// Mobile off-canvas "pesukim" drawer: the verse list overlays the practice pane
// (toggled by the floating hamburger) so it never eats horizontal or vertical
// space on a phone. On desktop the drawer controls are hidden via CSS and the
// verse list stays a normal grid column, so these handlers are harmless there.
function openPasukDrawer() { document.body.classList.add('pasuk-open'); }
function closePasukDrawer() { document.body.classList.remove('pasuk-open'); }
function setupPasukDrawer() {
  const fab = $('pasukFab');
  const backdrop = $('drawerBackdrop');
  const closeBtn = $('drawerClose');
  const closeBtnScroll = $('drawerCloseScroll');
  if (fab) fab.addEventListener('click', () => document.body.classList.toggle('pasuk-open'));
  // App-bar "Verses" button (compact): the verse picker lives here rather than a
  // bottom-corner FAB, which collided with the corner-docked transport buttons.
  const versesBtn = $('mobileVersesBtn');
  if (versesBtn) versesBtn.addEventListener('click', () => document.body.classList.toggle('pasuk-open'));
  if (backdrop) backdrop.addEventListener('click', closePasukDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closePasukDrawer);
  // The STA"M pane is the on-demand full-screen Torah-column reader (mobile), so
  // its close button exits scroll view rather than closing the pointed drawer.
  if (closeBtnScroll) closeBtnScroll.addEventListener('click', () => {
    state.scrollView = false; savePanePrefs(); syncToggleUI(); renderVerses(); maybeShowRotate();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('pasuk-open')) closePasukDrawer();
  });
}

// ---------------------------------------------------------------------------
// Account, cloud-synced progress & leaderboard (all optional). Sign-in mirrors
// the existing localStorage progress to Firestore so it follows the user across
// devices and can feed a shared leaderboard. When Firebase isn't configured (or
// the user stays logged out) the app behaves exactly as before, fully offline.
// ---------------------------------------------------------------------------
const authState = { configured: false, user: null, busy: false };

function setupAuth() {
  renderAuthBox();
  setupProfile();
  auth.initAuth({
    onUserChange: (user, info) => {
      authState.configured = !!(info && info.configured);
      authState.user = user;
      authState.busy = false;
      renderAuthBox();
      // Guided mode has its own account rows (it never shows the topbar), so they
      // are told too — a sign-in started there has to finish there.
      if (guided) guided.accountChanged();
    },
    // Cloud progress merged into local on sign-in — refresh everything so the
    // newly-synced scores/levels show up immediately, and (on the very first
    // login) offer to pick an anonymous nickname/avatar.
    onProgressMerged: () => {
      refreshProgressViews();
      renderAuthBox();
      if (guided) guided.accountChanged();
      maybeOfferProfile();
    },
  });
}

// The one-time "how would you like to appear?" prompt, on first login. Held back
// while the onboarding wizard is up: the wizard is a full-screen sheet above every
// modal (see .onboard in css/guided.css), so a modal opened underneath it would be
// invisible, and it would be answering a question about leaderboards that the
// reader hasn't got to yet. The wizard asks for it again when it closes.
function maybeOfferProfile() {
  // A wizard on its way up counts as up: its module is fetched on demand, so
  // between asking for it and having it there is nothing to ask isOpen() of.
  if (_wizardLoad && !onboarding) return;
  if (onboarding && onboarding.isOpen()) return;
  if (!auth.getUser() || auth.hasChosenProfile()) return;
  openProfileModal({ firstTime: true });
}

// --- Public identity picker (anonymous nickname + cartoon/solid avatar) -----
// Signed-in users can appear on the leaderboard under a nickname and a locally
// generated avatar instead of their Google name/photo. Avatars are inline SVG
// data-URLs (no network), so they render anywhere an <img> does.
const AV_COLORS = ['#e05a5a', '#e0894e', '#e0c24e', '#7bd66a', '#4ec9b0',
  '#5aa0ff', '#8a7bff', '#d76ad6', '#e06aa0', '#9aa7b3'];
const AV_EMOJI = ['🦁', '🦊', '🐼', '🐨', '🐵', '🐸', '🦉', '🐧',
  '🦄', '🐝', '🐢', '🐬', '🦖', '🐙', '🦜', '🐺'];
const AV_ADJ = ['Quiet', 'Curious', 'Wandering', 'Gentle', 'Bold', 'Hidden',
  'Ancient', 'Bright', 'Swift', 'Humble', 'Radiant', 'Steady', 'Nimble', 'Calm'];
const AV_NOUN = ['Scribe', 'Cantor', 'Pilgrim', 'Lamp', 'Cedar', 'River', 'Ram',
  'Dove', 'Scroll', 'Ember', 'Comet', 'Falcon', 'Willow', 'Harp'];

function svgDataUrl(svg) { return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); }

function colorAvatar(color) {
  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="${color}"/></svg>`);
}

function emojiAvatar(emoji, bg) {
  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="${bg}"/><text x="48" y="50" dy=".35em" text-anchor="middle" font-size="52">${emoji}</text></svg>`);
}

function randomNickname() {
  const a = AV_ADJ[Math.floor(Math.random() * AV_ADJ.length)];
  const n = AV_NOUN[Math.floor(Math.random() * AV_NOUN.length)];
  return `${a} ${n}`;
}

// A random cartoon avatar (used to give anonymous submitters a friendly default
// picture instead of a bare initial).
function randomAvatar() {
  const i = Math.floor(Math.random() * AV_EMOJI.length);
  return emojiAvatar(AV_EMOJI[i], AV_COLORS[i % AV_COLORS.length]);
}

// The choosable avatars: Google photo (if any) + cartoon faces + solid colours.
function avatarOptions(g) {
  const opts = [];
  if (g && g.photo) opts.push({ id: 'google', label: 'Your Google photo', photo: g.photo });
  AV_EMOJI.forEach((e, i) => opts.push({ id: 'e' + i, label: 'Cartoon avatar', photo: emojiAvatar(e, AV_COLORS[i % AV_COLORS.length]) }));
  AV_COLORS.forEach((c, i) => opts.push({ id: 'c' + i, label: 'Solid colour', photo: colorAvatar(c) }));
  return opts;
}

let profileDraft = null;

function setupProfile() {
  const modal = $('profileModal');
  if (!modal) return;
  const commitDefaultIfFirst = () => {
    // Dismissing the first-time prompt keeps the Google defaults but marks the
    // choice as made, so the user isn't asked again on every sign-in.
    if (profileDraft && profileDraft.firstTime && auth.getUser() && !auth.hasChosenProfile()) {
      const g = auth.getGoogleIdentity() || {};
      auth.saveProfile({ name: g.name || 'Anonymous', photo: g.photo || '' });
    }
  };
  const close = () => { commitDefaultIfFirst(); modal.hidden = true; profileDraft = null; renderAuthBox(); };
  modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
  $('profileKeepGoogle').addEventListener('click', () => {
    const g = auth.getGoogleIdentity() || {};
    auth.saveProfile({ name: g.name || 'Anonymous', photo: g.photo || '' });
    modal.hidden = true; profileDraft = null; renderAuthBox();
  });
  $('profileSave').addEventListener('click', async () => {
    const name = ((profileDraft && profileDraft.name) || '').trim() || 'Anonymous';
    const photo = (profileDraft && profileDraft.photo) || '';
    const anonSubmit = !!(profileDraft && profileDraft.anonSubmit);
    modal.hidden = true; profileDraft = null;
    if (anonSubmit) await submitAnon({ name, photo });
    else auth.saveProfile({ name, photo });
    renderAuthBox();
  });
}

// Post the current scores to the shared leaderboard without a Google account:
// remember the chosen anonymous identity, sign in anonymously (so Firestore's
// rules accept the write), then publish the summary + per-scope entries. All
// best-effort — on any failure the app stays exactly as it was.
async function submitAnon({ name, photo }) {
  // Persist the chosen identity locally FIRST, so the first-login profile prompt
  // (fired by onProgressMerged mid sign-in) sees it as already chosen and won't
  // pop a second modal.
  store.setProfile({ chosen: true, name, photo });
  renderAuthBox();
  try {
    if (!auth.getUser()) await auth.signInAnon();
    await auth.saveProfile({ name, photo }); // publishes the leaderboard summary
    maybePushScopes();                        // publishes per-scope entries
  } catch (e) {
    console.warn('[anon] leaderboard submit failed', e);
  }
}

function openProfileModal({ firstTime = false, anonSubmit = false } = {}) {
  const modal = $('profileModal');
  if (!modal) return;
  // Editing an existing identity needs a session; anonymous submission doesn't
  // (it creates the session on Save).
  if (!anonSubmit && !auth.getUser()) return;
  const g = anonSubmit ? {} : (auth.getGoogleIdentity() || {});
  const cur = store.getProfile();
  profileDraft = {
    firstTime,
    anonSubmit,
    name: (cur && cur.chosen && cur.name) ? cur.name : (g.name || randomNickname()),
    photo: (cur && cur.chosen && cur.photo) ? cur.photo : (g.photo || (anonSubmit ? randomAvatar() : '')),
  };
  const title = $('profileTitle');
  const intro = $('profileIntro');
  const keep = $('profileKeepGoogle');
  const save = $('profileSave');
  if (title) title.textContent = anonSubmit ? '🏆 Submit to the leaderboard'
    : (firstTime ? 'Welcome! How would you like to appear?' : 'Edit how you appear');
  if (intro) {
    intro.hidden = false;
    intro.textContent = anonSubmit
      ? 'No account needed — pick a nickname and a cartoon or solid-colour avatar, and your score goes up under that anonymous identity. Sign in with Google later to keep it across devices.'
      : 'Stay anonymous if you like — pick a nickname and a cartoon or solid-colour avatar instead of your Google name and photo. You can change this anytime.';
  }
  if (keep) keep.hidden = anonSubmit || !(g && (g.name || g.photo));
  if (save) save.textContent = anonSubmit ? 'Save & submit' : 'Save';
  renderProfileBody();
  modal.hidden = false;
  const nameInput = $('profileName');
  if (nameInput) nameInput.focus();
}

function renderProfileBody() {
  const body = $('profileBody');
  if (!body || !profileDraft) return;
  const g = auth.getGoogleIdentity() || {};
  const opts = avatarOptions(g);
  const cells = opts.map((o) => `
    <button type="button" class="av-opt ${o.photo === profileDraft.photo ? 'sel' : ''}" data-photo="${escapeHtml(o.photo)}" title="${escapeHtml(o.label)}">
      <img src="${escapeHtml(o.photo)}" alt="" />
    </button>`).join('');
  body.innerHTML = `
    <label class="profile-field">
      <span class="profile-label">Nickname</span>
      <span class="profile-name-row">
        <input id="profileName" type="text" maxlength="40" value="${escapeHtml(profileDraft.name)}" placeholder="Anonymous" autocomplete="off" spellcheck="false" />
        <button type="button" id="profileRandom" class="auth-btn" title="Suggest an anonymous nickname">🎲</button>
      </span>
    </label>
    <p class="profile-label profile-pic-label">Picture</p>
    <div class="av-grid">${cells}</div>`;
  $('profileName').addEventListener('input', (e) => { profileDraft.name = e.target.value; });
  $('profileRandom').addEventListener('click', () => {
    profileDraft.name = randomNickname();
    $('profileName').value = profileDraft.name;
    $('profileName').focus();
  });
  body.querySelectorAll('.av-opt').forEach((b) => b.addEventListener('click', () => {
    profileDraft.photo = b.dataset.photo;
    body.querySelectorAll('.av-opt').forEach((x) => x.classList.toggle('sel', x === b));
  }));
}

function renderAuthBox() {
  const box = $('authBox');
  if (!box) return;
  if (authState.user) {
    const u = authState.user;
    const anon = !!(auth.isAnon && auth.isAnon());
    const prof = store.getProfile();
    const name = (prof && prof.chosen && prof.name) ? prof.name : (u.displayName || u.email || (anon ? 'Anonymous' : 'Signed in'));
    const photo = (prof && prof.chosen) ? (prof.photo || '') : (u.photoURL || '');
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    const avatar = photo
      ? `<img class="av-img" src="${escapeHtml(photo)}" alt="" referrerpolicy="no-referrer" />`
      : `<span class="av-fallback">${escapeHtml(initial)}</span>`;
    const anonTag = anon ? '<span class="auth-anon" title="Posting anonymously — not signed in to an account">anon</span>' : '';
    // Anonymous sessions also get a Google button to upgrade in place (linking
    // keeps the same nickname + progress).
    const upgrade = anon
      ? `<button id="btnSignIn" class="auth-btn primary" ${authState.busy ? 'disabled' : ''} title="Keep your progress across devices by linking a Google account">
          <span class="g-mark">G</span> ${authState.busy ? 'Signing in…' : 'Sign in'}</button>`
      : '';
    box.innerHTML = `
      <button class="auth-user" id="btnEditProfile" title="Edit your nickname & avatar">
        ${avatar}<span class="auth-name">${escapeHtml(name)}</span>${anonTag}
      </button>
      ${upgrade}
      <button id="btnSignOut" class="auth-btn" title="Sign out">Sign out</button>`;
    $('btnEditProfile').addEventListener('click', () => openProfileModal({ firstTime: false }));
    $('btnSignOut').addEventListener('click', async () => {
      try { await auth.signOutUser(); } catch (e) { /* ignore */ }
    });
    const upgradeBtn = $('btnSignIn');
    if (upgradeBtn) upgradeBtn.addEventListener('click', async () => {
      authState.busy = true; renderAuthBox();
      try { await auth.signIn(); }
      catch (e) { authState.busy = false; renderAuthBox(); console.warn('sign-in failed', e); }
    });
    return;
  }
  if (!authState.configured) {
    box.innerHTML = `<a class="auth-note" href="firebase-setup.html" title="Open the ~5-minute setup checklist to enable Google sign-in, cloud-saved progress and the leaderboard. Progress is saved locally in this browser meanwhile.">Sign-in not set up ↗</a>`;
    return;
  }
  box.innerHTML = `<button id="btnSignIn" class="auth-btn primary" ${authState.busy ? 'disabled' : ''}>
      <span class="g-mark">G</span> ${authState.busy ? 'Signing in…' : 'Sign in with Google'}</button>`;
  $('btnSignIn').addEventListener('click', async () => {
    authState.busy = true; renderAuthBox();
    try {
      await auth.signIn();
    } catch (e) {
      authState.busy = false; renderAuthBox();
      console.warn('sign-in failed', e);
    }
  });
}

// Re-render every view that reflects stored progress (scores, levels, badges).
function refreshProgressViews() {
  renderVerses();
  renderAliyot();
  renderStageBar();
  if (state.selectedVerse != null && !state.aliyah) renderPractice();
}

function setupLeaderboard() {
  const btn = $('btnLeaderboard');
  const modal = $('lbModal');
  if (!btn || !modal) return;
  btn.addEventListener('click', () => { closeSettingsSheet(); openLeaderboard(); });
  modal.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => { modal.hidden = true; });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) modal.hidden = true; });
}

// Leaderboard navigation state. `lbSection` is the top-level screen; `lbDetail`,
// when set, is a per-scope drill-down (pasuk or aliyah board) layered on top.
let lbSection = 'pasuk';        // 'pasuk' | 'aliyah' | 'sefer' | 'overall'
let lbDetail = null;            // { scope, view } where view is 'you' | 'overall'
let lbAliyahCycle = 'annual';   // Aliyot screen: 'annual' | 'triennial'
let lbAliyahYear = 1;           // triennial year (1-3) when the toggle is triennial
let lbSeferSel = null;          // Sefer screen: selected book (English name)
let lbSeferSort = 'pesukim';    // Sefer table sort column
let lbSeferDir = -1;            // sort direction: -1 desc, 1 asc

// How many per-scope board tops we're willing to fetch on one browse render.
// Aliyot across the shipped readings stay well under this; the far larger pasuk
// set exceeds it, so for pesukim we only enrich the ones you've scored (keeping
// the modal snappy) — see renderPasukList / renderAliyahList.
const MAX_BOARD_FETCH = 160;

async function openLeaderboard() {
  const modal = $('lbModal');
  const body = $('lbBody');
  if (!modal || !body) return;
  modal.hidden = false;
  lbDetail = null; // always open on the section list, not a stale drill-down
  _boardTopCache.clear(); // refetch record-holders on each open so the board is current
  // Publish this reader's latest corpus aggregates so the Sefer/Overall boards
  // are current for everyone (best-effort, a no-op offline / signed out).
  if (typeof auth.updateSummaryExtras === 'function') {
    computeCorpusAggregates().then((agg) => { if (agg) auth.updateSummaryExtras(agg.summaryExtras); }).catch(() => {});
  }
  renderLbShell(body);
}

// Section nav + a body region each section fills in. Four screens:
//   Pesukim  — every pasuk with a score, grouped by parashah, verse order;
//   Aliyot   — the 7 aliyot + maftir per parashah (annual or triennial toggle);
//   Sefer    — a per-book table ranking readers by how much they've practiced;
//   Overall  — a cross-book table (all sefarim) with XP + hours.
// Tapping a pasuk/aliyah row opens a drill-down board (top scores + a colourbar
// of score-over-runs, with a You/Overall toggle) via lbDetail.
function renderLbShell(body) {
  // A drill-down board takes over the whole body when open.
  if (lbDetail) { renderLbDetail(body); return; }
  const secs = [
    ['pasuk', 'Pesukim'],
    ['aliyah', 'Aliyot'],
    ['sefer', 'Sefer'],
    ['overall', 'Overall'],
  ];
  body.innerHTML = `<div class="lb-tabs">${secs.map(([id, l]) =>
    `<button class="lb-tab ${lbSection === id ? 'on' : ''}" data-sec="${id}">${l}</button>`).join('')}</div>
    <div class="lb-tabbody" id="lbTabBody"><p class="lb-empty">Loading…</p></div>`;
  body.querySelectorAll('.lb-tab').forEach((b) => {
    b.addEventListener('click', () => { lbSection = b.dataset.sec; renderLbShell(body); });
  });
  renderLbSection();
}

// Open a per-scope drill-down board (pasuk or aliyah) and re-render.
function openLbDetail(scope) {
  lbDetail = { scope, view: 'you' };
  renderLbShell($('lbBody'));
}

// Close the drill-down, returning to the section list.
function closeLbDetail() {
  lbDetail = null;
  renderLbShell($('lbBody'));
}

function renderLbSection() {
  if (lbSection === 'pasuk') return renderPasukList();
  if (lbSection === 'aliyah') return renderAliyahList();
  if (lbSection === 'sefer') return renderSefer();
  if (lbSection === 'overall') return renderOverall();
}

function lbNotConfigured() {
  return `<p class="lb-empty">The shared leaderboard isn't set up yet. Add your Firebase config in
    <code>js/firebase-config.js</code> (see the README) to enable it.</p>${localSummaryHtml()}`;
}

// A reader's avatar (photo or initial fallback), shared by every board view.
function avatarHtml(r) {
  const initial = ((r && r.name) || '?').trim().charAt(0).toUpperCase();
  return r && r.photo
    ? `<img class="lb-av" src="${escapeHtml(r.photo)}" alt="" referrerpolicy="no-referrer" />`
    : `<span class="lb-av fallback">${escapeHtml(initial)}</span>`;
}

// Small "anon" pill for readers who posted without a Google account.
function anonTagHtml(r) {
  return r && r.anon ? ' <span class="lb-anon" title="Posted anonymously (no account)">anon</span>' : '';
}

// Render one board's rows into an HTML table (used by the Overall XP board).
function boardTable(rows, { cols, me }) {
  const list = rows.map((r, i) => {
    const rank = i + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`;
    const isMe = me && r.uid === me.uid;
    const star = r.partial ? ' <span class="lb-star" title="Covered only part of the parashah (e.g. one triennial third)">⭐</span>' : '';
    const cyc = r.cycle && r.cycle !== 'annual' ? ` <span class="lb-youtag">tri</span>` : '';
    const numCols = cols.map((c) => `<td class="lb-num">${(r[c.key] != null ? r[c.key] : 0).toLocaleString ? (r[c.key] || 0).toLocaleString() : (r[c.key] || 0)}</td>`).join('');
    return `<tr class="${isMe ? 'me' : ''}">
      <td class="lb-rank">${medal}</td>
      <td class="lb-who">${avatarHtml(r)}<span class="lb-name">${escapeHtml(r.name || 'Anonymous')}${isMe ? ' <span class="lb-youtag">you</span>' : ''}${anonTagHtml(r)}${cyc}${star}</span></td>
      ${numCols}
    </tr>`;
  }).join('');
  return `<table class="lb-table"><thead><tr><th></th><th>Reader</th>${cols.map((c) => `<th title="${escapeHtml(c.title || '')}">${c.label}</th>`).join('')}</tr></thead><tbody>${list}</tbody></table>`;
}

// A horizontal strip of one cell per attempt (run 1, 2, 3…), each coloured by
// its score, so a reader's progression is visible at a glance and commensurate
// across readers (same attempt-index axis). Empty runs render a muted note.
function colourbarHtml(runs, { showAxis = false } = {}) {
  const arr = (runs || []).map((x) => Math.max(0, Math.min(100, Math.round(Number(x) || 0))));
  if (!arr.length) return '<span class="lb-cb-empty">no runs yet</span>';
  const cells = arr.map((s, i) =>
    `<span class="lb-cb-cell" style="background:${scoreColorSolid(s)}" title="Run ${i + 1}: ${s}"></span>`).join('');
  const axis = showAxis
    ? `<div class="lb-cb-axis"><span>run 1</span><span>${arr.length} runs · best ${Math.max(...arr)}</span></div>`
    : '';
  return `<div class="lb-colourbar">${cells}</div>${axis}`;
}

// ---------------------------------------------------------------------------
// Top-scores browse: one row per aliyah (or pasuk) across EVERY reading, showing
// the current record holder + score, grouped by parashah and sorted best-first.
// Tapping a row loads that reading, sets its cycle/portion, and opens the unit
// for a fresh challenge. Works offline too: with no shared board configured it
// falls back to your own local bests so the directory is still useful.
// ---------------------------------------------------------------------------

let _readingsMetaCache = null;   // [{ slug, label, data }] for all readings
let _lbBrowse = [];              // scope descriptors backing the current rows
const _boardTopCache = new Map(); // `${type}:${refId}` -> top row (or null)

// Load (once) every reading's data so we can enumerate its aliyot/pesukim. The
// currently-open reading reuses the resident state.data; the rest are fetched.
async function loadAllReadingsMeta() {
  if (_readingsMetaCache) return _readingsMetaCache;
  const out = [];
  for (const meta of AVAILABLE) {
    try {
      // A picked passage has no data file — it is assembled from the book text,
      // which is what readingDocFor does for both cases.
      const data = (state.readingId === meta.slug && state.data)
        ? state.data
        : await readingDocFor(meta);
      if (!data || !data.verses) continue;
      out.push({ slug: meta.slug, label: meta.label, data });
    } catch (e) { /* skip a reading whose text can't be resolved */ }
  }
  _readingsMetaCache = out;
  return out;
}

function parashaNameOf(data, slug, fallbackLabel) {
  const par = (data && data.parashah) || parashahOf(slug);
  return (par && (par.en || par.he)) || fallbackLabel || slug;
}

// Highest local score for a verse across the heatmap best and every skill/mode.
function localVerseBest(slug, n) {
  let best = store.getVerseScore(slug, n) || 0;
  const ms = store.getVerseModeScores(slug, n);
  for (const k of Object.keys(ms)) best = Math.max(best, ms[k] || 0);
  return best;
}

// Every aliyah of every reading, across the annual + three triennial partitions.
function enumerateAliyahScopes(metas) {
  const scopes = [];
  for (const m of metas) {
    const par = (m.data && m.data.parashah) || parashahOf(m.slug);
    const parName = parashaNameOf(m.data, m.slug, m.label);
    const parId = scores.parashaIdFor(par, m.slug);
    const aliyot = m.data && m.data.aliyot;
    const partitions = [['annual', 0]];
    for (let y = 1; y <= 3; y++) partitions.push(['triennial', y]);
    for (const [cycle, year] of partitions) {
      const list = aliyot
        ? (cycle === 'triennial' ? (aliyot.triennial[year] || []) : (aliyot.annual || []))
        : aliyotFor(m.slug, cycle, year);
      const cycleLabel = cycle === 'triennial' ? `Triennial · Yr ${year}` : 'Annual';
      for (const a of list) {
        scopes.push({
          type: 'aliyah', slug: m.slug, cycle, year, n: a.n, ref: a.ref,
          refId: scores.aliyahIdFor(parId, cycle, year, a.n),
          parName, cycleLabel,
          label: `${chunkTitle(a)}${a.ref ? ` · ${a.ref}` : ''}`,
          localBest: store.getAliyahScore(m.slug, cycle, year, a.n),
        });
      }
      // Maftir is its own scored unit (n:'M'), keyed like an aliyah.
      const maf = aliyot && aliyot.maftir
        && (cycle === 'triennial' ? (aliyot.maftir.triennial && aliyot.maftir.triennial[year]) : aliyot.maftir.annual);
      if (maf) {
        scopes.push({
          type: 'aliyah', slug: m.slug, cycle, year, n: maf.n, ref: maf.ref,
          refId: scores.aliyahIdFor(parId, cycle, year, maf.n),
          parName, cycleLabel,
          label: `Maftir${maf.ref ? ` · ${maf.ref}` : ''}`,
          localBest: store.getAliyahScore(m.slug, cycle, year, maf.n),
        });
      }
    }
  }
  return scopes;
}

// Every pasuk of every reading (cycle-independent).
function enumeratePasukScopes(metas) {
  const scopes = [];
  for (const m of metas) {
    const parName = parashaNameOf(m.data, m.slug, m.label);
    const verses = (m.data && m.data.verses) || [];
    const book = (m.data && m.data.book && m.data.book.en) || m.slug;
    for (let n = 1; n <= verses.length; n++) {
      const v = verses[n - 1];
      const ref = (v && (v.ref != null ? v.ref : (v.c != null && v.v != null ? `${v.c}:${v.v}` : n)));
      scopes.push({
        type: 'pasuk', slug: m.slug, n,
        refId: scores.pasukIdFor(m.data, n),
        parName, cycleLabel: '',
        label: `${book} ${ref}`,
        localBest: localVerseBest(m.slug, n),
      });
    }
  }
  return scopes;
}

// Cached top row for one scope's board (or null). Skips the network entirely
// when the shared board isn't configured.
async function boardTop(type, refId) {
  const key = `${type}:${refId}`;
  if (_boardTopCache.has(key)) return _boardTopCache.get(key);
  let top = null;
  if (auth.isConfigured() && typeof auth.getBoard === 'function') {
    try {
      const rows = await auth.getBoard(type, refId, 1);
      top = rows && rows[0] ? rows[0] : null;
    } catch (e) { top = null; }
  }
  _boardTopCache.set(key, top);
  return top;
}

// The highest local roll-up score for one aliyah of a given reading: the
// max(direct take, derived floor from its pesukim), mirroring computeScopeEntries
// but for any reading (not just the resident one), plus its incomplete/solo tags.
function localAliyahDisplay(m, cycle, year, a) {
  const maxV = (m.data.verses || []).length;
  const childBests = [];
  for (let n = a.start; n <= Math.min(a.end || maxV, maxV); n++) {
    const ms = store.getVerseModeScores(m.slug, n);
    let b = store.getVerseScore(m.slug, n) || 0;
    for (const k of Object.keys(ms)) b = Math.max(b, ms[k] || 0);
    if (b > 0) childBests.push(b);
  }
  const direct = store.getAliyahScore(m.slug, cycle, year, a.n);
  const solo = store.getAliyahSolo(m.slug, cycle, year, a.n);
  return { score: scores.deriveScore(direct, childBests), incomplete: direct <= 0, solo: solo > 0 };
}

// ---------------------------------------------------------------------------
// Pesukim screen: every pasuk that has a score, grouped by parashah in verse
// order, one row each showing the top score. Tap a row to open its board.
// ---------------------------------------------------------------------------
async function renderPasukList() {
  const el = $('lbTabBody');
  if (!el) return;
  el.innerHTML = '<p class="lb-empty">Loading…</p>';
  const me = auth.getUser();
  const metas = await loadAllReadingsMeta();
  const scopes = enumeratePasukScopes(metas);

  const configured = auth.isConfigured();
  const canFetchAll = configured && scopes.length <= MAX_BOARD_FETCH;
  const toFetch = configured ? (canFetchAll ? scopes : scopes.filter((s) => s.localBest > 0)) : [];
  await Promise.all(toFetch.map(async (s) => { s.top = await boardTop('pasuk', s.refId); }));

  const rows = scopes.map((s) => ({ s, best: Math.max(s.top ? s.top.score : 0, s.localBest || 0) }))
    .filter((r) => r.best > 0);
  if (!rows.length) {
    el.innerHTML = '<p class="lb-empty">No pasuk scores yet — record a full verse to put it on the board.</p>' + localSummaryHtml();
    return;
  }

  // Group by parashah, preserving verse order within each group.
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.s.parName)) groups.set(r.s.parName, []);
    groups.get(r.s.parName).push(r);
  }
  const partial = configured && !canFetchAll;
  let html = `<p class="lb-scope">Every pasuk you or others have chanted, in order. Tap one for its board and your score-over-runs.${partial ? ' <span class="hint">(showing pesukim you\'ve scored)</span>' : ''}</p>`;
  _lbBrowse = [];
  for (const [name, gr] of groups) {
    html += `<div class="lb-group"><h3 class="lb-group-h">📖 ${escapeHtml(name)}</h3><table class="lb-table"><tbody>`;
    for (const r of gr) {
      const s = r.s;
      const idx = _lbBrowse.push(s) - 1;
      const holder = s.top
        ? `${avatarHtml(s.top)}<span class="lb-name">${escapeHtml(s.top.name || 'Anonymous')}${(me && s.top.uid === me.uid) ? ' <span class="lb-youtag">you</span>' : ''}${anonTagHtml(s.top)}</span>`
        : '<span class="lb-av fallback">★</span><span class="lb-name lb-you-only">You</span>';
      const yourTag = (s.top && (s.localBest || 0) > 0) ? `<span class="lb-yourbest" title="Your best">you ${s.localBest}</span>` : '';
      html += `<tr class="lb-browserow" data-idx="${idx}" title="Open board">
        <td class="lb-scopelbl"><b>${escapeHtml(s.label)}</b></td>
        <td class="lb-who">${holder}${yourTag}</td>
        <td class="lb-num lb-bignum" style="color:${scoreColorSolid(r.best)}">${r.best}</td>
        <td class="lb-go">›</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
  el.querySelectorAll('.lb-browserow').forEach((tr) => {
    tr.addEventListener('click', () => openLbDetail(_lbBrowse[parseInt(tr.dataset.idx, 10)]));
  });
}

// ---------------------------------------------------------------------------
// Aliyot screen: annual/triennial toggle; per parashah the 7 aliyot + maftir,
// each with its top score and an "incomplete" tag when no continuous take
// exists. Tap a row for its board.
// ---------------------------------------------------------------------------
async function renderAliyahList() {
  const el = $('lbTabBody');
  if (!el) return;
  const cycle = lbAliyahCycle;
  const year = lbAliyahYear;

  const yearBtns = cycle === 'triennial'
    ? `<span class="lb-yeartoggle">${[1, 2, 3].map((y) =>
      `<button class="lb-yr ${y === year ? 'on' : ''}" data-yr="${y}">Yr ${y}</button>`).join('')}</span>`
    : '';
  const toggle = `<div class="lb-subtoggle">
    <span class="seg lb-cycseg">
      <button class="lb-cyc ${cycle === 'annual' ? 'on' : ''}" data-cyc="annual">Full year (annual)</button>
      <button class="lb-cyc ${cycle === 'triennial' ? 'on' : ''}" data-cyc="triennial">Triennial</button>
    </span>${yearBtns}</div>`;

  el.innerHTML = toggle + '<p class="lb-empty">Loading…</p>';
  const bindToggles = () => {
    el.querySelectorAll('.lb-cyc').forEach((b) => b.addEventListener('click', () => { lbAliyahCycle = b.dataset.cyc; renderAliyahList(); }));
    el.querySelectorAll('.lb-yr').forEach((b) => b.addEventListener('click', () => { lbAliyahYear = parseInt(b.dataset.yr, 10); renderAliyahList(); }));
  };

  const me = auth.getUser();
  const metas = await loadAllReadingsMeta();

  // Enumerate the aliyot (+ maftir) for the selected partition, carrying start/end.
  const scopes = [];
  for (const m of metas) {
    const par = (m.data && m.data.parashah) || parashahOf(m.slug);
    const parName = parashaNameOf(m.data, m.slug, m.label);
    const parId = scores.parashaIdFor(par, m.slug);
    const aliyot = m.data && m.data.aliyot;
    const list = aliyot
      ? (cycle === 'triennial' ? ((aliyot.triennial && aliyot.triennial[year]) || []) : (aliyot.annual || []))
      : aliyotFor(m.slug, cycle, year);
    const units = list.slice();
    const maf = aliyot && aliyot.maftir
      && (cycle === 'triennial' ? (aliyot.maftir.triennial && aliyot.maftir.triennial[year]) : aliyot.maftir.annual);
    if (maf) units.push(maf);
    for (const a of units) {
      scopes.push({
        type: 'aliyah', slug: m.slug, cycle, year, n: a.n, ref: a.ref, start: a.start, end: a.end,
        refId: scores.aliyahIdFor(parId, cycle, year, a.n), parName,
        label: `${chunkTitle(a)}${a.ref ? ` · ${a.ref}` : ''}`,
        localDisplay: localAliyahDisplay(m, cycle, year, a),
      });
    }
  }

  const configured = auth.isConfigured();
  const canFetchAll = configured && scopes.length <= MAX_BOARD_FETCH;
  const toFetch = configured ? (canFetchAll ? scopes : scopes.filter((s) => s.localDisplay.score > 0)) : [];
  await Promise.all(toFetch.map(async (s) => { s.top = await boardTop('aliyah', s.refId); }));

  const rows = scopes.map((s) => {
    const topScore = s.top ? s.top.score : 0;
    const local = s.localDisplay.score;
    const best = Math.max(topScore, local);
    const incomplete = topScore >= local ? (s.top ? s.top.incomplete : s.localDisplay.incomplete) : s.localDisplay.incomplete;
    return { s, best, incomplete };
  }).filter((r) => r.best > 0);

  if (!rows.length) {
    el.innerHTML = toggle + '<p class="lb-empty">No aliyah scores yet for this cycle — record an aliyah to put it on the board.</p>' + localSummaryHtml();
    bindToggles();
    return;
  }

  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.s.parName)) groups.set(r.s.parName, []);
    groups.get(r.s.parName).push(r);
  }
  let html = toggle + `<p class="lb-scope">Solo, back-to-back takes score highest; a duet is capped; practising only the pesukim gives a lower "incomplete" floor. Tap for the board.</p>`;
  _lbBrowse = [];
  for (const [name, gr] of groups) {
    html += `<div class="lb-group"><h3 class="lb-group-h">📖 ${escapeHtml(name)}</h3><table class="lb-table"><tbody>`;
    for (const r of gr) {
      const s = r.s;
      const idx = _lbBrowse.push(s) - 1;
      const holder = s.top
        ? `${avatarHtml(s.top)}<span class="lb-name">${escapeHtml(s.top.name || 'Anonymous')}${(me && s.top.uid === me.uid) ? ' <span class="lb-youtag">you</span>' : ''}${anonTagHtml(s.top)}</span>`
        : '<span class="lb-av fallback">★</span><span class="lb-name lb-you-only">You</span>';
      const tag = r.incomplete ? ' <span class="lb-incomplete" title="No continuous take yet — this is a floor derived from the pesukim. Record the whole aliyah solo to raise it.">incomplete</span>' : '';
      html += `<tr class="lb-browserow" data-idx="${idx}" title="Open board">
        <td class="lb-scopelbl"><b>${escapeHtml(s.label)}</b>${tag}</td>
        <td class="lb-who">${holder}</td>
        <td class="lb-num lb-bignum" style="color:${scoreColorSolid(r.best)}">${r.best}</td>
        <td class="lb-go">›</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
  bindToggles();
  el.querySelectorAll('.lb-browserow').forEach((tr) => {
    tr.addEventListener('click', () => openLbDetail(_lbBrowse[parseInt(tr.dataset.idx, 10)]));
  });
}

// ---------------------------------------------------------------------------
// Drill-down board for one pasuk / aliyah: top scores + a colourbar of each
// reader's score-over-runs, with a You / Overall toggle and a Practice button.
// ---------------------------------------------------------------------------
function renderLbDetail(body) {
  const scope = lbDetail.scope;
  const overallOk = auth.isConfigured();
  body.innerHTML = `<div class="lb-detailhead">
      <button class="lb-back" id="lbBack">‹ Back</button>
      <h3 class="lb-detail-title">${escapeHtml(scope.label)}</h3>
      <span class="seg lb-viewseg">
        <button class="lb-view ${lbDetail.view === 'you' ? 'on' : ''}" data-view="you">You</button>
        <button class="lb-view ${lbDetail.view === 'overall' ? 'on' : ''}" data-view="overall" ${overallOk ? '' : 'disabled title="Sign in to compare with others"'}>Overall</button>
      </span>
      <button class="auth-btn lb-practice" id="lbPractice">▶ Practice</button>
    </div>
    <div id="lbDetailBody"><p class="lb-empty">Loading…</p></div>`;
  body.querySelector('#lbBack').addEventListener('click', closeLbDetail);
  body.querySelector('#lbPractice').addEventListener('click', () => navigateToScope(scope));
  body.querySelectorAll('.lb-view').forEach((b) => {
    if (b.disabled) return;
    b.addEventListener('click', () => { lbDetail.view = b.dataset.view; renderLbDetail(body); });
  });
  renderLbDetailBody();
}

function localRunLogFor(scope) {
  return scope.type === 'aliyah'
    ? store.getAliyahRunLog(scope.slug, scope.cycle, scope.year, scope.n)
    : store.getVerseRunLog(scope.slug, scope.n);
}

async function renderLbDetailBody() {
  const el = $('lbDetailBody');
  if (!el) return;
  const scope = lbDetail.scope;
  const me = auth.getUser();

  if (lbDetail.view === 'you' || !auth.isConfigured()) {
    const log = localRunLogFor(scope);
    let runs = log.map((x) => x.s);
    // Per-run history only started being logged recently. For progress made
    // before then, fall back to the older top-N bests (pesukim) or at least the
    // single best score, so the "You" board isn't blank for existing users.
    // Per-run history only started being logged recently. For progress made
    // before then, show a single cell as a yardstick of the current best rather
    // than the older top-N bests (which cluster at near-identical high values).
    let approx = false;
    if (!runs.length) {
      approx = true;
      const b = scope.type === 'pasuk'
        ? localVerseBest(scope.slug, scope.n)
        : Math.max(
          store.getAliyahScore(scope.slug, scope.cycle, scope.year, scope.n),
          scope.localDisplay ? scope.localDisplay.score : 0,
        );
      if (b > 0) runs = [b];
    }
    if (!runs.length) {
      el.innerHTML = '<p class="lb-empty">You haven\'t recorded this yet. Hit Practice to post your first run.</p>';
      return;
    }
    const best = Math.max(...runs);
    const soloNote = scope.type === 'aliyah' && log.some((x) => x.duet)
      ? '<p class="hint">Runs marked from duet takes are capped; a solo take can score higher.</p>' : '';
    const label = approx
      ? 'Your current best (per-run history starts from your next take):'
      : 'Your score over runs (oldest → newest):';
    el.innerHTML = `<div class="lb-youdetail">
      <div class="lb-youhead"><span class="lb-detail-best" style="color:${scoreColorSolid(best)}">${best}</span><span class="ceil"> / 100 best</span></div>
      <p class="lb-cb-label">${label}</p>
      ${colourbarHtml(runs, { showAxis: true })}
      ${soloNote}
    </div>`;
    return;
  }

  // Overall: one colourbar row per reader, aligned on the attempt-index axis.
  el.innerHTML = '<p class="lb-empty">Loading…</p>';
  const rows = await auth.getBoard(scope.type, scope.refId, 25);
  if (!rows.length) {
    el.innerHTML = '<p class="lb-empty">No one\'s posted a score here yet.</p>';
    return;
  }
  let html = '<table class="lb-table lb-cbtable"><thead><tr><th></th><th>Reader</th><th>Best</th><th class="lb-cb-th">Score over runs</th></tr></thead><tbody>';
  rows.forEach((r, i) => {
    const rank = i + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`;
    const isMe = me && r.uid === me.uid;
    const inc = r.incomplete ? ' <span class="lb-incomplete">incomplete</span>' : '';
    html += `<tr class="${isMe ? 'me' : ''}">
      <td class="lb-rank">${medal}</td>
      <td class="lb-who">${avatarHtml(r)}<span class="lb-name">${escapeHtml(r.name || 'Anonymous')}${isMe ? ' <span class="lb-youtag">you</span>' : ''}${anonTagHtml(r)}${inc}</span></td>
      <td class="lb-num lb-bignum" style="color:${scoreColorSolid(r.score)}">${r.score}</td>
      <td class="lb-cb-td">${colourbarHtml(r.runs && r.runs.length ? r.runs : [r.score])}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Sefer screen: pick a book, then a ranked table of readers by how much of that
// book they've practiced (pesukim / aliyot / parashot, each count + depth),
// with a sefer score and XP. Sortable by column.
// ---------------------------------------------------------------------------
async function renderSefer() {
  const el = $('lbTabBody');
  if (!el) return;
  el.innerHTML = '<p class="lb-empty">Loading…</p>';
  const metas = await loadAllReadingsMeta();
  const books = [...new Set(metas.map((m) => (m.data.book && m.data.book.en) || m.slug))];
  if (!books.length) { el.innerHTML = '<p class="lb-empty">No readings loaded.</p>'; return; }
  if (!lbSeferSel || !books.includes(lbSeferSel)) lbSeferSel = books[0];

  const picker = `<div class="lb-subtoggle"><span class="seg lb-bookseg">${books.map((b) =>
    `<button class="lb-book ${b === lbSeferSel ? 'on' : ''}" data-book="${escapeHtml(b)}">${escapeHtml(b)}</button>`).join('')}</span></div>`;

  // Gather rows: signed-in => everyone from the leaderboard collection; else the
  // local user only.
  let rows = [];
  const me = auth.getUser();
  if (auth.isConfigured() && me) {
    const lb = await auth.getLeaderboard(50);
    rows = lb.map((r) => ({ name: r.name, photo: r.photo, anon: r.anon, uid: r.uid, xp: r.xp, sefer: (r.perSefer && r.perSefer[lbSeferSel]) || null }))
      .filter((r) => r.sefer);
    // Overlay this reader's freshly-computed local row so their own numbers are
    // always accurate even if the cloud doc hasn't been pushed yet.
    const agg = await computeCorpusAggregates();
    const meS = agg.perSefer[lbSeferSel];
    if (meS) {
      const id = auth.publicIdentity ? auth.publicIdentity() : { name: 'You', photo: '' };
      const meRow = { name: id.name, photo: id.photo, anon: auth.isAnon && auth.isAnon(), uid: me.uid, xp: agg.xp, sefer: meS, isMe: true };
      const i = rows.findIndex((r) => r.uid === me.uid);
      if (i >= 0) rows[i] = meRow; else rows.push(meRow);
    }
  } else {
    const agg = await computeCorpusAggregates();
    const s = agg.perSefer[lbSeferSel];
    if (s) rows = [{ name: 'You', photo: '', anon: false, uid: 'me', xp: agg.xp, sefer: s, isMe: true }];
  }

  if (!rows.length) {
    el.innerHTML = picker + `<p class="lb-empty">No one's practiced ${escapeHtml(lbSeferSel)} yet.</p>` + (auth.isConfigured() ? '' : localSummaryHtml());
    bindBooks();
    return;
  }

  const getVal = (r, key) => {
    if (key === 'xp') return r.xp || 0;
    if (key === 'score') return r.sefer.score || 0;
    return (r.sefer[key] || 0) * 1000 + (r.sefer[key + 'Depth'] || 0); // count first, depth tiebreak
  };
  rows.sort((a, b) => lbSeferDir * (getVal(a, lbSeferSort) - getVal(b, lbSeferSort)));

  const cols = [
    { key: 'pesukim', label: 'Pesukim', title: 'Pesukim practiced (bar = average practice depth)' },
    { key: 'aliyot', label: 'Aliyot', title: 'Aliyot practiced (bar = average take score)' },
    { key: 'parashot', label: 'Parashot', title: 'Parashot with any practice (bar = of total in book)' },
    { key: 'score', label: 'Sefer score', title: 'Combined: pesukim depth + aliyot + parashot' },
    { key: 'xp', label: 'XP', title: 'Mastery points: sum of your best whole-verse & aliyah accuracies' },
  ];
  const th = cols.map((c) => {
    const on = lbSeferSort === c.key;
    const arrow = on ? (lbSeferDir < 0 ? ' ▾' : ' ▴') : '';
    return `<th class="lb-sort ${on ? 'on' : ''}" data-key="${c.key}" title="${escapeHtml(c.title)}">${c.label}${arrow}</th>`;
  }).join('');

  const cell = (r, key) => {
    const val = r.sefer[key] || 0;
    const depth = key === 'parashot'
      ? (r.sefer.parashotTotal ? Math.round(val / r.sefer.parashotTotal * 100) : 0)
      : (r.sefer[key + 'Depth'] || 0);
    return `<td class="lb-num"><span class="lb-cell-num">${val}</span><span class="lb-depth"><span class="lb-depth-fill" style="width:${depth}%;background:${scoreColorSolid(depth)}"></span></span></td>`;
  };

  let html = picker + `<p class="lb-scope">How much of <b>${escapeHtml(lbSeferSel)}</b> each reader has practiced. Tap a column to sort.</p>`;
  html += `<table class="lb-table lb-sefertable"><thead><tr><th></th><th>Reader</th>${th}</tr></thead><tbody>`;
  rows.forEach((r, i) => {
    const isMe = r.isMe || (me && r.uid === me.uid);
    html += `<tr class="${isMe ? 'me' : ''}">
      <td class="lb-rank">${i + 1}</td>
      <td class="lb-who">${avatarHtml(r)}<span class="lb-name">${escapeHtml(r.name || 'Anonymous')}${isMe ? ' <span class="lb-youtag">you</span>' : ''}${anonTagHtml(r)}</span></td>
      ${cell(r, 'pesukim')}${cell(r, 'aliyot')}${cell(r, 'parashot')}
      <td class="lb-num lb-bignum">${r.sefer.score || 0}</td>
      <td class="lb-num">${(r.xp || 0).toLocaleString()}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  if (!auth.isConfigured() || !me) html += '<p class="hint lb-signin-note">Sign in to rank against other readers.</p>';
  el.innerHTML = html;
  bindBooks();
  el.querySelectorAll('.lb-sort').forEach((h) => h.addEventListener('click', () => {
    const key = h.dataset.key;
    if (lbSeferSort === key) lbSeferDir *= -1; else { lbSeferSort = key; lbSeferDir = -1; }
    renderSefer();
  }));

  function bindBooks() {
    el.querySelectorAll('.lb-book').forEach((b) => b.addEventListener('click', () => { lbSeferSel = b.dataset.book; renderSefer(); }));
  }
}

// ---------------------------------------------------------------------------
// Overall screen: a cross-book table summing practice across all sefarim, plus
// XP (mastery points) and an estimated hours-studying total.
// ---------------------------------------------------------------------------
async function renderOverall() {
  const el = $('lbTabBody');
  if (!el) return;
  el.innerHTML = '<p class="lb-empty">Loading…</p>';
  const me = auth.getUser();
  let rows = [];
  if (auth.isConfigured() && me) {
    rows = (await auth.getLeaderboard(50)).slice();
    // Overlay the current reader's freshly-computed totals (cloud may be stale).
    const agg = await computeCorpusAggregates();
    const id = auth.publicIdentity ? auth.publicIdentity() : { name: 'You', photo: '' };
    const meRow = { name: id.name, photo: id.photo, anon: auth.isAnon && auth.isAnon(), uid: me.uid, isMe: true,
      xp: agg.xp, hours: agg.hours, pesukim: agg.totals.pesukim, aliyot: agg.totals.aliyot, parashot: agg.totals.parashot, sefarim: agg.totals.sefarim };
    const i = rows.findIndex((r) => r.uid === me.uid);
    if (i >= 0) rows[i] = meRow; else rows.push(meRow);
  } else {
    const agg = await computeCorpusAggregates();
    rows = [{ name: 'You', photo: '', anon: false, uid: 'me', isMe: true,
      xp: agg.xp, hours: agg.hours, pesukim: agg.totals.pesukim, aliyot: agg.totals.aliyot, parashot: agg.totals.parashot, sefarim: agg.totals.sefarim }];
  }
  if (!rows.length) {
    el.innerHTML = `<p class="lb-empty">No one's on the board yet — ${me ? 'keep practicing to climb it!' : 'record a full verse to post a score, or sign in.'}</p>${localSummaryHtml()}`;
    return;
  }
  rows = rows.slice().sort((a, b) => (b.xp || 0) - (a.xp || 0));
  let html = '<p class="lb-scope">Everything, everywhere: total practice across the five books of the Torah.</p>';
  html += `<table class="lb-table lb-overalltable"><thead><tr><th></th><th>Reader</th>
    <th title="Mastery points: sum of your best whole-verse & aliyah accuracies">XP</th>
    <th title="Pesukim practiced across all books">Pesukim</th>
    <th title="Aliyot practiced across all books">Aliyot</th>
    <th title="Parashot with any practice">Parashot</th>
    <th title="Books touched (of 5)">Sefarim</th>
    <th title="Estimated time spent practicing">Hours</th></tr></thead><tbody>`;
  rows.forEach((r, i) => {
    const rank = i + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`;
    const isMe = r.isMe || (me && r.uid === me.uid);
    html += `<tr class="${isMe ? 'me' : ''}">
      <td class="lb-rank">${medal}</td>
      <td class="lb-who">${avatarHtml(r)}<span class="lb-name">${escapeHtml(r.name || 'Anonymous')}${isMe ? ' <span class="lb-youtag">you</span>' : ''}${anonTagHtml(r)}</span></td>
      <td class="lb-num lb-bignum">${(r.xp || 0).toLocaleString()}</td>
      <td class="lb-num">${r.pesukim || 0}</td>
      <td class="lb-num">${r.aliyot || 0}</td>
      <td class="lb-num">${r.parashot || 0}</td>
      <td class="lb-num">${r.sefarim || 0} / 5</td>
      <td class="lb-num">${(Number(r.hours) || 0).toFixed(1)}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  if (!auth.isConfigured() || !me) html += '<p class="hint lb-signin-note">Sign in to rank against other readers and sync across devices.</p>';
  el.innerHTML = html;
}

// Compute corpus-wide practice aggregates (per-sefer + overall totals + hours)
// from local progress and the loaded readings metadata. Used both to render the
// local (signed-out) Sefer/Overall rows and to publish `summaryExtras` for the
// shared boards.
async function computeCorpusAggregates() {
  const metas = await loadAllReadingsMeta();
  const perSefer = {};
  const ensure = (book) => perSefer[book] || (perSefer[book] = {
    book, pesukim: 0, pesukimLevelSum: 0, aliyot: 0, aliyotScoreSum: 0,
    parashotSet: new Set(), parashotPracticed: new Set(),
  });
  for (const m of metas) {
    const book = (m.data.book && m.data.book.en) || m.slug;
    const parName = parashaNameOf(m.data, m.slug, m.label);
    const S = ensure(book);
    S.parashotSet.add(parName);
    const verses = m.data.verses || [];
    let parPracticed = 0;
    for (let n = 1; n <= verses.length; n++) {
      const lvl = store.getVerseLevel(m.slug, n);
      const ms = store.getVerseModeScores(m.slug, n);
      let best = store.getVerseScore(m.slug, n) || 0;
      for (const k of Object.keys(ms)) best = Math.max(best, ms[k] || 0);
      if (lvl > 1 || best > 0) { S.pesukim++; S.pesukimLevelSum += lvl; parPracticed++; }
    }
    if (parPracticed > 0) S.parashotPracticed.add(parName);
    const aliyot = m.data.aliyot;
    const partitions = [['annual', 0], ['triennial', 1], ['triennial', 2], ['triennial', 3]];
    for (const [cycle, year] of partitions) {
      const list = aliyot ? (cycle === 'triennial' ? ((aliyot.triennial && aliyot.triennial[year]) || []) : (aliyot.annual || [])) : [];
      const units = list.slice();
      const maf = aliyot && aliyot.maftir && (cycle === 'triennial' ? (aliyot.maftir.triennial && aliyot.maftir.triennial[year]) : aliyot.maftir.annual);
      if (maf) units.push(maf);
      for (const a of units) {
        const sc = store.getAliyahScore(m.slug, cycle, year, a.n);
        if (sc > 0) { S.aliyot++; S.aliyotScoreSum += sc; }
      }
    }
  }
  const perSeferOut = {};
  const totals = { pesukim: 0, aliyot: 0, parashot: 0, sefarim: 0 };
  for (const book of Object.keys(perSefer)) {
    const S = perSefer[book];
    const pesukimDepth = S.pesukim ? Math.round((S.pesukimLevelSum / S.pesukim) / LEVELS.length * 100) : 0;
    const aliyotDepth = S.aliyot ? Math.round(S.aliyotScoreSum / S.aliyot) : 0;
    const parashot = S.parashotPracticed.size;
    const score = Math.round(S.pesukimLevelSum + S.aliyotScoreSum / 10 + parashot * 20);
    perSeferOut[book] = { book, pesukim: S.pesukim, pesukimDepth, aliyot: S.aliyot, aliyotDepth, parashot, parashotTotal: S.parashotSet.size, score };
    totals.pesukim += S.pesukim; totals.aliyot += S.aliyot; totals.parashot += parashot;
    if (S.pesukim > 0 || S.aliyot > 0) totals.sefarim++;
  }
  const hours = Math.round(store.getPracticeSeconds() / 360) / 10;
  const xp = auth.computeSummary(store.getAll()).xp;
  const summaryExtras = { hours, pesukim: totals.pesukim, aliyot: totals.aliyot, parashot: totals.parashot, sefarim: totals.sefarim, perSefer: perSeferOut };
  return { perSefer: perSeferOut, totals, hours, xp, summaryExtras };
}

// Jump from a leaderboard row to actually practicing that unit: load its reading
// if needed, set the matching portion/cycle, then open the aliyah challenge (or
// select the pasuk) so the user can immediately record a try.
async function navigateToScope(scope) {
  if (!scope) return;
  const modal = $('lbModal');
  if (modal) modal.hidden = true;
  if (state.slug !== scope.slug) await loadData(scope.slug);
  if (scope.type === 'aliyah') {
    state.cycle = scope.cycle;
    state.triYear = scope.year || 1;
    syncPortionUI();
    renderVerses();
    renderAliyot();
    const list = aliyotForReading(scope.cycle, state.triYear);
    let a = list.find((x) => x.n === scope.n)
      || defaultAliyot(scope.cycle, state.triYear).find((x) => x.n === scope.n);
    if (!a && scope.n === 'M') a = maftirForReading(scope.cycle, state.triYear);
    if (a) openAliyah(a);
  } else {
    // Show the whole parashah so the target pasuk is visible in the list, then
    // open it for practice.
    state.cycle = 'annual';
    syncPortionUI();
    selectVerse(scope.n);
  }
}

// ---------------------------------------------------------------------------
// Hierarchical leaderboard feed. After any scoring event we recompute the
// canonical scope scores for the current reading (pasuk / aliyah / parasha) and
// hand them to the sync layer, which only writes the ones that improved. The
// aliyah/parasha scores are rolled up from pesukim (with the average-based floor
// in scores.js) so a learner who has only done pesukim still appears — at a low,
// improvable score — until they record the continuous chain.
// ---------------------------------------------------------------------------
function pasukBest(verseN) {
  return bestVerseScore(verseN);
}

function computeScopeEntries() {
  const par = parashahForReading();
  const parId = scores.parashaIdFor(par, state.slug);
  const maxV = state.data.verses.length;
  const entries = [];

  // Pasuk: each verse's best whole-verse accuracy (cycle-independent).
  const allBests = [];
  for (let n = 1; n <= maxV; n++) {
    const sc = pasukBest(n);
    if (sc > 0) {
      allBests.push(sc);
      entries.push({ type: 'pasuk', refId: scores.pasukIdFor(state.data, n), score: sc, label: `${(state.data.book && state.data.book.en) || ''} ${verseRefLabel(state.data.verses[n - 1], n)}`, runs: store.getVerseRunLog(state.slug, n).map((x) => x.s) });
    }
  }

  // Aliyah: for every DEFAULT partition (annual + each triennial year), the
  // max(direct take, derived floor from its pesukim).
  const partitions = [['annual', 0]];
  for (let y = 1; y <= 3; y++) partitions.push(['triennial', y]);
  for (const [cycle, year] of partitions) {
    // Score an aliyah/maftir as max(direct take, floor derived from its pesukim).
    const scoreUnit = (a, label) => {
      const childBests = [];
      for (let n = a.start; n <= Math.min(a.end, maxV); n++) {
        const b = pasukBest(n);
        if (b > 0) childBests.push(b);
      }
      const direct = store.getAliyahScore(state.slug, cycle, year, a.n);
      const solo = store.getAliyahSolo(state.slug, cycle, year, a.n);
      const sc = scores.deriveScore(direct, childBests);
      if (sc > 0) {
        // `incomplete` = no continuous take yet (score is only the derived floor
        // from pesukim); `solo` = a genuine solo full-aliyah chain exists.
        entries.push({
          type: 'aliyah', refId: scores.aliyahIdFor(parId, cycle, year, a.n), score: sc, cycle, label,
          incomplete: direct <= 0, solo: solo > 0,
          runs: store.getAliyahRunLog(state.slug, cycle, year, a.n).map((x) => x.s),
        });
      }
    };
    for (const a of defaultAliyot(cycle, year)) scoreUnit(a, `${chunkTitle(a)} · ${a.ref || ''}`);
    const maf = maftirForReading(cycle, year);
    if (maf) scoreUnit(maf, `Maftir · ${maf.ref || ''}`);
  }

  // Parasha: rolled up from all pesukim. `partial` (⭐ on the board) marks a
  // reader who has only covered a fraction of the parashah (e.g. one triennial
  // third).
  if (allBests.length) {
    const parScore = scores.deriveScore(0, allBests);
    if (parScore > 0) {
      const coverage = allBests.length / maxV;
      entries.push({ type: 'parasha', refId: parId, score: parScore, partial: coverage < 0.5, label: (par && (par.en || par.he)) || state.slug });
    }
  }
  return entries;
}

// Fire-and-forget: recompute and push scope scores if the sync layer supports
// it and the user is signed in. Guarded so it is a no-op offline or before the
// per-scope board functions are available.
function maybePushScopes() {
  try {
    if (typeof auth.pushScopeScores !== 'function') return;
    auth.pushScopeScores(computeScopeEntries());
  } catch (e) { /* leaderboard push is best-effort */ }
  // Recompute the corpus-wide aggregates (per-sefer + overall practice counts +
  // hours) and hand them to the sync layer for the Sefer/Overall boards.
  try {
    if (typeof auth.updateSummaryExtras === 'function') {
      computeCorpusAggregates().then((agg) => {
        if (agg) auth.updateSummaryExtras(agg.summaryExtras);
      }).catch(() => {});
    }
  } catch (e) { /* best-effort */ }
}

// After a full-verse take, invite a logged-out user to post their score to the
// shared board anonymously. Signed-in users already sync automatically, and it
// stays hidden entirely when the leaderboard isn't configured (offline mode).
function maybeOfferLeaderboardSubmit(score) {
  if (!auth.isConfigured() || auth.getUser() || !(score > 0)) return;
  const result = $('result');
  if (!result || result.querySelector('.submit-anon-wrap')) return;
  const wrap = document.createElement('div');
  wrap.className = 'submit-anon-wrap';
  wrap.innerHTML = `
    <span class="hint submit-anon-note">Post this to the shared leaderboard under an anonymous nickname &amp; avatar — no account needed.</span>
    <button type="button" class="auth-btn primary submit-anon-btn">🏆 Submit to leaderboard</button>`;
  wrap.querySelector('.submit-anon-btn').addEventListener('click', () => openProfileModal({ anonSubmit: true }));
  result.appendChild(wrap);
}

// A read-only summary of THIS browser's local progress, shown when the shared
// board isn't available, so the button is still useful offline.
function localSummaryHtml() {
  const s = auth.computeSummary(store.getAll());
  return `<div class="lb-local">
    <h3>Your progress on this device</h3>
    <div class="lb-local-stats">
      <span><b>${s.xp.toLocaleString()}</b> XP</span>
      <span><b>${s.versesMastered}</b> verses</span>
      <span><b>${s.aliyotComplete}</b> aliyot</span>
    </div>
  </div>`;
}

// Draggable divider between the verse list and the practice pane. The width is
// persisted and never changes automatically, so the horizontal scale stays
// consistent across words/verses/levels.
const LEFTW_KEY = 'cantillate.leftw';
const SCROLLW_KEY = 'cantillate.scrollw';
function applyLeftW(px) {
  const mainEl = document.querySelector('main');
  const max = Math.max(160, window.innerWidth - 380);
  const w = Math.max(0, Math.min(max, px));
  mainEl.style.setProperty('--leftw', w + 'px');
  mainEl.classList.toggle('narrow-left', w > 0 && w < 210);
  try { localStorage.setItem(LEFTW_KEY, String(Math.round(w))); } catch (e) { /* ignore */ }
}
// Width of the optional STA"M column (leftmost; only shown in scroll view).
function applyScrollW(px) {
  const mainEl = document.querySelector('main');
  const max = Math.max(200, window.innerWidth - 480);
  const w = Math.max(140, Math.min(max, px));
  mainEl.style.setProperty('--scrollw', w + 'px');
  try { localStorage.setItem(SCROLLW_KEY, String(Math.round(w))); } catch (e) { /* ignore */ }
  fitScrollPages();
}

// The whole tikkun page scales from its own font-size via a container query
// (see .scroll-page in styles.css: 4cqw makes the 25em page fill the pane, capped
// at the native size). That is pure CSS and reflow-free, so resizing needs no JS
// re-layout here — we only (re)assert the one-time scroll to the reading's start
// once the pane has a measurable width.
function fitScrollPages() {
  const box = $('scrollVerses');
  if (!box) return;
  if (!box.clientWidth) return;
  if (box.dataset.scrollToStart === '1') requestAnimationFrame(scrollTikkunStartIntoView);
}
// Re-assert the start position whenever the pane's viewport changes (splitter
// drag, mobile reflow, drawer open, orientation change, etc.).
let _scrollRO = null;
function observeScrollPane() {
  const box = $('scrollVerses');
  if (!box || _scrollRO || typeof ResizeObserver === 'undefined') return;
  _scrollRO = new ResizeObserver(() => fitScrollPages());
  _scrollRO.observe(box);
}

// Attach drag + double-click-reset behaviour to a splitter. onDrag receives the
// pointer's client X; onReset runs on double-click.
function bindSplitter(splitter, onDrag, onReset) {
  if (!splitter) return;
  let dragging = false;
  const cx = (e) => (e.touches ? e.touches[0].clientX : e.clientX);
  const onMove = (e) => { if (dragging) onDrag(cx(e)); };
  const stop = () => { dragging = false; splitter.classList.remove('dragging'); document.body.style.userSelect = ''; };
  const start = (e) => { dragging = true; splitter.classList.add('dragging'); document.body.style.userSelect = 'none'; e.preventDefault(); };
  splitter.addEventListener('mousedown', start);
  splitter.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', stop);
  window.addEventListener('touchend', stop);
  if (onReset) splitter.addEventListener('dblclick', onReset);
}

function setupSplitter() {
  const mainEl = document.querySelector('main');
  const mainLeft = () => mainEl.getBoundingClientRect().left;
  const savedL = parseInt(localStorage.getItem(LEFTW_KEY) || '', 10);
  applyLeftW(Number.isFinite(savedL) ? savedL : 360);
  const savedS = parseInt(localStorage.getItem(SCROLLW_KEY) || '', 10);
  applyScrollW(Number.isFinite(savedS) ? savedS : 300);

  // Divider between the pointed verses and the practice pane. Measured from the
  // textpane's OWN left edge, so it behaves identically whether or not the STA"M
  // column is shown to its left.
  bindSplitter($('splitter'), (clientX) => {
    const tp = $('textpane');
    const tpLeft = tp.getBoundingClientRect().left - mainLeft();
    applyLeftW(clientX - mainLeft() - tpLeft);
  }, () => applyLeftW(360));

  // Divider between the STA"M column (leftmost) and the pointed verses.
  bindSplitter($('splitter2'), (clientX) => applyScrollW(clientX - mainLeft()), () => applyScrollW(300));
  observeScrollPane();
  window.addEventListener('resize', fitScrollPages);
}

// --- Left-panel (verse list) text size -----------------------------------
// A persisted multiplier on the pointed Hebrew + English verse text, so the
// reader can shrink it to fit more pesukim on screen or enlarge it to read
// comfortably. Applied as a CSS variable on the textpane (pure CSS, no rebuild).
const LEFTSCALE_KEY = 'cantillate.leftscale';
const LEFT_MIN = 0.6, LEFT_MAX = 1.8;
function loadLeftScale() {
  const v = parseFloat(localStorage.getItem(LEFTSCALE_KEY) || '');
  return Number.isFinite(v) ? Math.max(LEFT_MIN, Math.min(LEFT_MAX, v)) : 1.0;
}
function applyLeftScale(scale) {
  const v = Math.max(LEFT_MIN, Math.min(LEFT_MAX, Number(scale) || 1));
  const tp = $('textpane');
  if (tp) tp.style.setProperty('--left-scale', String(v));
  try { localStorage.setItem(LEFTSCALE_KEY, String(v)); } catch (e) { /* ignore */ }
}
function setupLeftSize() {
  const el = $('leftSize');
  const s = loadLeftScale();
  applyLeftScale(s);
  if (el) {
    el.value = String(s);
    el.addEventListener('input', (e) => applyLeftScale(parseFloat(e.target.value)));
  }
}

// --- Reading size --------------------------------------------------------
// The learner should watch the WORDS, not the notation. A persisted multiplier
// enlarges the aligned Hebrew glyphs while the note-step contour and the two
// spectrograms shrink to make room, so the reading dominates the practice pane.
const READSCALE_KEY = 'cantillate.readscale';
const READ_MIN = 1.0, READ_MAX = 3.4;
function loadReadScale() {
  const v = parseFloat(localStorage.getItem(READSCALE_KEY) || '');
  return Number.isFinite(v) ? Math.max(READ_MIN, Math.min(READ_MAX, v)) : 1.6;
}

// Base glyph size (px) for the aligned practice row before the user multiplier —
// fewer words on a page get bigger defaults. Multiplied by state.readScale.
function readingBaseFont(nWords) {
  return nWords === 1 ? 40 : nWords <= 4 ? 30 : nWords <= 9 ? 25 : 20;
}
function readingFontPx(nWords) {
  return Math.round(readingBaseFont(nWords) * (state.readScale || 1));
}

// Note-panel heights that shrink as the reading grows, so enlarging the text
// costs the notation its space (not the reading's). Floors keep them usable.
// On desktop the coaching contour ignores this shrink — it flex-fills the pane
// so slight tone variations are visible (see .contour-wrap in the CSS); only the
// spectrograms use `contour`/`spectro` there. Mobile keeps the fixed heights.
function noteHeights() {
  const s = state.readScale || 1;
  const mobile = window.innerWidth <= 720;
  const cBase = mobile ? 150 : 210, sBase = mobile ? 90 : 120;
  const contour = Math.round(Math.max(mobile ? 66 : 88, cBase - (s - 1) * 62));
  const spectro = Math.round(Math.max(mobile ? 30 : 40, sBase - (s - 1) * 46));
  return { contour, spectro };
}

// Desktop puts the coaching contour center-stage: the spectrograms + accuracy
// bars ("analysis") collapse behind a toggle so the note lines fill the pane.
// Default OFF (collapsed) so the coaching line dominates out of the box.
const ANALYSIS_KEY = 'cantillate.showAnalysis';
function loadAnalysisPref() {
  try { return localStorage.getItem(ANALYSIS_KEY) === '1'; } catch (e) { return false; }
}
// True on the desktop grid layout (where the collapse/flex-fill applies). A
// desktop/laptop is both WIDE and TALL; phones — including landscape phones that
// are wider than 900px but short — use the compact layout (matches the CSS
// "(max-width:900px), (max-height:600px)" breakpoint).
function isDesktopLayout() { return window.innerWidth > 900 && window.innerHeight > 600; }

// Show/hide the analysis panels. When idle we rebuild the practice pane so every
// canvas is re-created crisply at its new size; mid-take we just flip the class
// and re-fit the contour so we never interrupt recording/playback.
function toggleAnalysis() {
  const show = !state.showAnalysis;
  state.showAnalysis = show;
  try { localStorage.setItem(ANALYSIS_KEY, show ? '1' : '0'); } catch (e) { /* ignore */ }
  const idle = !state.recording && !state.playingReal;
  if (idle && state.selectedVerse != null && !state.aliyah) {
    renderPractice();
    return;
  }
  const p = $('practice');
  if (p) p.classList.toggle('hide-analysis', !show);
  const btn = $('btnAnalysis');
  if (btn) { btn.classList.toggle('on', show); btn.setAttribute('aria-pressed', show ? 'true' : 'false'); }
  // The contour's flex height just changed — re-fit its backing store & redraw.
  if (state.view) { state.view._resize(); state.view.draw(); }
}

// Apply a new reading size. During an active take we only resize the text (no
// rebuild, so audio isn't interrupted); when idle we re-render so the note
// canvases are re-created crisply at their new, smaller heights.
function applyReadScale(scale, rerender) {
  const s = Math.max(READ_MIN, Math.min(READ_MAX, Number(scale) || 1));
  state.readScale = s;
  try { localStorage.setItem(READSCALE_KEY, String(s)); } catch (e) { /* ignore */ }
  const tw = $('timelineWords');
  if (tw && state.coach && state.coach.overlayWords) {
    const n = state.coach.overlayWords.length || 1;
    tw.style.fontSize = readingFontPx(n) + 'px';
    tw.style.height = wordsBandPx(readingFontPx(n)) + 'px';
  }
  if (rerender && state.selectedVerse != null && !state.aliyah
      && !state.recording && !state.playingReal) {
    renderPractice();
  }
}

// Keyboard shortcuts (RTL): ← next page/word, → previous, Space/P play — or,
// once something is running, hold it; "," and "." step back and forward one word
// so you can retry the bit you fumbled without restarting the pasuk; ↓ record
// (press again to restart), ↑ sing along (voice guide + record in sync), Escape
// stop. Modifier combos (e.g. Ctrl/Cmd+R to refresh) and typing in a control are
// left to the browser. In aliyah mode the same keys drive the aliyah transport
// (Space guided read, ↓ record, ↑ duet, Esc stop).
function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
  // Step keys work the same everywhere something is running.
  if (e.key === ',' || e.key === '.') {
    if (!transportLive()) return;
    e.preventDefault();
    stepWord(e.key === ',' ? -1 : 1);
    return;
  }
  if (state.aliyah) {
    const tl = state._aliyaTl;
    if (!tl) return;
    if (e.key === ' ' || e.key === 'p') {
      e.preventDefault();
      if (state._aliyaRunning) togglePause();
      else playAliyahGuided(tl);
    } else if (e.key === 'ArrowDown') { e.preventDefault(); recordAliyahRun(tl); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); recordAliyahRun(tl, { duet: true }); }
    else if (e.key === 'Escape') { e.preventDefault(); stopAliyah(); setAliyahButtons(false); }
    return;
  }
  if (state.selectedVerse == null) return;
  const units = state.units;
  if (!units || !units.length) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); goToUnit(state.unitIndex + 1, true); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); goToUnit(state.unitIndex - 1, true); }
  else if (e.key === ' ' || e.key === 'p') {
    e.preventDefault();
    if (transportLive()) togglePause();
    else playUnit();
  } else if (e.key === 'ArrowDown') { e.preventDefault(); startRecording(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); startRecording({ singAlong: true }); }
  else if (e.key === 'Escape') { e.preventDefault(); stopAll(); }
}

// ---------------------------------------------------------------------------
// Transport: pause and step by one word
//
// Chanting is learned by repeating the stretch you keep fumbling, not the whole
// pasuk. So anything time-based — the recorded chant, a duet, or your own take —
// can be held with Space and nudged a word at a time with "," and "." . Paused,
// stepping plays just the word you land on so you can hear it before carrying on;
// while it's still rolling, stepping simply moves the playhead. Rewinding into a
// take also discards what you sang past that point, so the second attempt at a
// phrase replaces the first instead of scoring on top of it.
// ---------------------------------------------------------------------------

// Is there a time-based activity that can be paused or scrubbed right now?
function transportLive() {
  return state.recording || state.playingReal || isVerseAudioLoaded()
    || (!!state.aliyah && !!state._aliyaRunning);
}

// Normalized position, 0..1, within whatever window is currently running.
function transportPos() {
  if (state.paused) return state.pausedAt;
  if (state.recording) {
    const dur = state.expectedDur || unitDuration();
    return clamp01((performance.now() - state.recStart) / 1000 / (dur || 1));
  }
  const p = verseAudioProgress();
  return p != null ? p : 0;
}

function clamp01(x) { return Math.min(1, Math.max(0, Number(x) || 0)); }

function togglePause() {
  if (state.paused) resumeTransport();
  else pauseTransport();
}

function pauseTransport() {
  if (state.paused || !transportLive()) return;
  state.pausedAt = transportPos();
  state.paused = true;
  state._pausedSince = performance.now();
  // The synthesized voice guide is scheduled ahead on the audio clock and can't
  // be held mid-note, so pausing simply silences it.
  stopPlayback();
  pauseVerseAudio();
  if (state.aliyah) pauseAliyahTimers();
  else clearTimeout(state._recTimer);
  syncTransportUI();
}

function resumeTransport() {
  if (!state.paused) return;
  state.paused = false;
  const held = performance.now() - (state._pausedSince || performance.now());
  state._pausedSince = 0;
  if (state.recording) {
    const dur = (state.expectedDur || unitDuration()) * 1000;
    state.recStart = performance.now() - state.pausedAt * dur;
    // Re-arm the backstop that ends the take, minus what has already been sung.
    state._recTimer = setTimeout(finishRecording, Math.max(400, (1 - state.pausedAt) * dur + 800));
  }
  if (state.aliyah) resumeAliyahTimers(held);
  resumeVerseAudio();
  syncTransportUI();
}

// Step the playhead one word back (-1) or forward (+1) within the current window.
function stepWord(delta) {
  const coach = state.aliyah ? aliyahCoachAtPos() : state.coach;
  if (!coach || !coach.wordBounds || !coach.wordBounds.length) return;
  const bounds = coach.wordBounds;
  const here = state.aliyah ? aliyahLocalPos() : transportPos();
  let idx = 0;
  for (let i = 0; i < bounds.length; i++) if (here >= bounds[i]) idx = i;
  const target = Math.max(0, Math.min(bounds.length - 1, idx + delta));
  seekTo(bounds[target], target + 1 < bounds.length ? bounds[target + 1] : 1);
  announceStep(coach, target);
}

// Move everything — audio, record clock, playhead, karaoke highlight — to `t01`.
// `wordEnd` bounds the little preview played when we're parked.
function seekTo(t01, wordEnd) {
  const pos = clamp01(t01);
  if (state.recording) {
    // Re-singing over a stretch replaces it, so drop the frames (and note gems)
    // recorded past this point before the take continues.
    if (state.view) state.view.rewindUser(pos);
    if (state._diffs) state._diffs.length = 0;
    const dur = (state.expectedDur || unitDuration()) * 1000;
    if (!state.paused) state.recStart = performance.now() - pos * dur;
  }
  state.pausedAt = pos;
  if (state.paused && wordEnd != null) previewVerseAudio(pos, wordEnd);
  else seekVerseAudio(pos);
  const coach = state.aliyah ? aliyahCoachAtPos() : state.coach;
  if (state.view && !state.aliyah) state.view.setPlayhead(pos);
  if (coach) {
    if (state.aliyah) {
      const seg = aliyahSegAtPos();
      if (seg) highlightAliyah(seg.n, wordAtTime(coach, pos));
    } else {
      highlightWord(wordAtTime(coach, pos));
      scrollFollow(pos);
    }
  }
  syncTransportUI();
}

function announceStep(coach, wordIdx) {
  const el = state.aliyah ? $('aliyaResult') : $('result');
  if (!el) return;
  const ow = coach.overlayWords && coach.overlayWords[wordIdx];
  const seg = ow && ow.seg;
  const where = seg
    ? `<b style="color:${seg.color}">${renderWord(seg.token, aidsForLevel())}</b> · ${seg.name.en}`
    : `word ${wordIdx + 1}`;
  el.innerHTML = `<span class="hint">${state.paused ? '⏸ Paused at' : '↦'} ${where}`
    + `${state.paused ? ' — Space to carry on, <b>,</b> / <b>.</b> to keep stepping.' : ''}</span>`;
}

// Reflect the paused state on the transport buttons (and the body, so the CSS can
// mark the pane as held).
function syncTransportUI() {
  document.body.classList.toggle('transport-paused', state.paused);
  const btn = $('btnPause') || $('alPause');
  if (btn) {
    btn.textContent = state.paused ? '▶ Resume' : '⏸ Pause';
    btn.disabled = !transportLive();
    btn.setAttribute('aria-pressed', state.paused ? 'true' : 'false');
  }
  for (const id of ['btnStepBack', 'btnStepFwd', 'alStepBack', 'alStepFwd']) {
    const b = $(id);
    if (b) b.disabled = !transportLive();
  }
  // Guided mode's action bar swaps to a single Stop button while anything is
  // running, and this is the one place every start and stop already passes
  // through, so it needs no polling of its own.
  if (guided) guided.transportChanged();
}

// Clear the paused flag whenever a take or playback ends, so a fresh one starts
// from a clean transport.
function resetTransport() {
  state.paused = false;
  state.pausedAt = 0;
  state._pausedSince = 0;
  document.body.classList.remove('transport-paused');
  syncTransportUI();
}

// --- Aliyah-mode helpers for the shared transport ---------------------------
// In the aliyah reader the timeline spans many verses, so "position" has to be
// resolved to the verse segment under the playhead before the shared code can
// treat it like a single window.

function aliyahElapsed() {
  if (!state._aliyaT0) return 0;
  if (state.paused) return state._aliyaPausedAt || 0;
  return (performance.now() - state._aliyaT0) / 1000;
}

function aliyahSegAtPos() {
  const tl = state._aliyaTl;
  if (!tl) return null;
  const tG = aliyahElapsed();
  return tl.segs.find((s) => tG >= s.gStart && tG < s.gEnd) || tl.segs[0] || null;
}

function aliyahCoachAtPos() {
  const seg = aliyahSegAtPos();
  return seg ? seg.coach : null;
}

function aliyahLocalPos() {
  const seg = aliyahSegAtPos();
  if (!seg) return 0;
  return clamp01((aliyahElapsed() - seg.gStart) / (seg.dur || 1));
}

function pauseAliyahTimers() {
  state._aliyaPausedAt = aliyahElapsed();
  clearTimeout(state._aliyaTimer);
  if (state._aliyaGuideTimers) { state._aliyaGuideTimers.forEach(clearTimeout); state._aliyaGuideTimers = []; }
}

function resumeAliyahTimers(heldMs) {
  if (state._aliyaT0) state._aliyaT0 += heldMs;
  const tl = state._aliyaTl;
  if (!tl) return;
  if (state._aliyaRunning === 'rec') {
    const remaining = Math.max(400, (tl.total - aliyahElapsed()) * 1000 + 900);
    state._aliyaTimer = setTimeout(() => finishAliyahRecord(tl), remaining);
    if (state._aliyaDuet) scheduleAliyahDuet(tl, state._aliyaT0);
  }
}

// Advance whole-pasuk in STA"M reading (level 8 / Torah-column view). Jumps to
// the next/previous verse in the current portion and — via selectVerse — opens
// it at that verse's highest UNLOCKED stage (so a fully-learned pasuk stays in
// the scroll, while one that still needs work drops to its word/phrase coach).
function goToVerse(delta) {
  if (state.selectedVerse == null || state.aliyah) return;
  const [start, end] = divisionRange();
  const n = Math.max(start, Math.min(end, state.selectedVerse + delta));
  if (n !== state.selectedVerse) selectVerse(n);
}

// Move to another page (word-group / phrase / verse) and optionally play it.
function goToUnit(idx, play) {
  const units = state.units;
  if (!units || !units.length) return;
  const clamped = Math.max(0, Math.min(units.length - 1, idx));
  state.unitIndex = clamped;
  renderPractice();
  if (play) playUnit();
}

// Play the current page's span (a whole maqaf unit / phrase / verse) from the
// recording, so paired words are heard together with their internal pauses.
function playUnit() {
  const info = verseAudio(state.selectedVerse);
  if (!info || !state.coach) return;
  const coach = state.coach;
  stopPlayback();
  stopVerseAudio();
  state.playingReal = true;
  if (state.spectro) state.spectro.clearPlot();
  if (state.view) state.view.clearReal(); // reset the green detected-tone line on replay
  const tonic = coach.tonicHz || 200;
  $('btnStop').disabled = false;
  resetTransport();
  syncTransportUI();
  $('result').innerHTML = '<span class="hint">Playing this ' + (state.unitSegs.length > 1 ? 'unit (with the pauses between words)' : 'word') + ' from the recording… Space holds it, <b>,</b> / <b>.</b> step a word.</span>';
  playSegment(info.file, coach.start, coach.end, {
    onProgress: (t01) => { state.view.setPlayhead(t01); highlightWord(wordAtTime(coach, t01)); scrollFollow(t01); },
    onAnalysis: (a) => onRealAnalysis(a, tonic),
    onEnd: onRealEnd,
    onError: onRealError,
  });
}

// Touch swipes on the practice timeline advance between units (word/phrase).
// RTL: swiping the content leftward reveals the NEXT unit; rightward the prev.
// Skipped when the timeline itself is horizontally scrolling (guitar-hero zoom),
// where the gesture belongs to the scroll.
function wirePracticeSwipe() {
  const el = document.querySelector('#practice .timeline');
  if (!el) return;
  if (el.querySelector('.tl-scroll.scrolling')) return;
  let x0 = 0, y0 = 0, t0 = 0, active = false;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); active = true;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!active) return; active = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
    if (dt > 600 || Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // Word/phrase levels swipe between units; the whole-verse (line) level has a
    // single unit, so it swipes between pesukim instead. RTL: left = forward.
    const units = state.units;
    const wholeVerse = !units || units.length < 2;
    if (dx < 0) { wholeVerse ? goToVerse(1) : goToUnit(state.unitIndex + 1, true); }
    else { wholeVerse ? goToVerse(-1) : goToUnit(state.unitIndex - 1, true); }
  }, { passive: true });
}

// --- Orientation: the note-coach wants landscape on a phone -----------------
// We attempt a real lock where the platform allows it (Android / installed PWA);
// iOS Safari ignores programmatic locks, so a portrait overlay prompts the user
// to rotate. STA"M reading is the deliberate portrait view, so it's exempt.
function isMobileLayout() { return !isDesktopLayout(); }
function isPortrait() { return window.matchMedia('(orientation: portrait)').matches; }
function maybeShowRotate() {
  const el = $('rotatePrompt');
  if (!el) return;
  const practicing = state.selectedVerse != null && !state.aliyah;
  const show = isMobileLayout() && isPortrait() && practicing
    && !state.allowPortrait && !document.body.classList.contains('scroll-view');
  el.hidden = !show;
  document.body.classList.toggle('rotate-blocking', show);
}
async function tryLockLandscape() {
  try {
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
  } catch (e) { /* unsupported (e.g. iOS) — the rotate prompt guides instead */ }
}
function setupOrientation() {
  const onChange = () => maybeShowRotate();
  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', () => setTimeout(onChange, 200));
  const anyway = $('rotateAnyway');
  if (anyway) anyway.addEventListener('click', () => { state.allowPortrait = true; maybeShowRotate(); });
  maybeShowRotate();
}

// ---------------------------------------------------------------------------
// Trope guide — ONE optional vertical panel that unifies what used to be two
// always-on interfaces: the trope-family key (formerly a top toolbar row) and
// the per-unit vocal-shape legend (formerly at the foot of the practice pane,
// usually off-screen). It lists every family grouped, each accent showing its
// melodic diagram + meaning, and clicking a family or a single trope spotlights
// its words in the pesukim (click again, or "Clear", to reset). Which parts of
// the text carry colour is chosen by the "Colour" control (full / trope / none).
// ---------------------------------------------------------------------------

// The panel is long — every accent in the corpus, each with its own canvas
// diagram — and most readers never slide it open. Built at startup it put
// thirty-odd canvases on the boot path and then left them in the document for
// the rest of the session, sized 0x0 behind a closed drawer. It is built the
// first time it is opened instead; until then renderGuide() keeps the style chip
// honest and leaves the body alone.
let guideBuilt = false;

function buildGuideOnce() {
  if (guideBuilt) return;
  guideBuilt = true;
  renderGuide();
  // A family or trope spotlighted before the panel existed has to be shown as
  // active on the cards that were just made.
  applyHighlight();
}

function setupGuide() {
  renderGuide();
  const tg = $('tgGuide');
  if (tg) tg.addEventListener('click', () => { closeSettingsSheet(); toggleGuide(); });
  const gc = $('guideClose');
  if (gc) gc.addEventListener('click', () => toggleGuide(false));
  const clr = $('guideClear');
  if (clr) clr.addEventListener('click', () => { state.highlight = null; applyHighlight(); });
  const seg = $('colorSeg');
  if (seg) seg.querySelectorAll('.cm').forEach((b) => {
    b.addEventListener('click', () => setColorMode(b.dataset.cm));
  });
}

function toggleGuide(force) {
  state.guideOpen = force != null ? force : !state.guideOpen;
  if (state.guideOpen) buildGuideOnce();
  document.body.classList.toggle('guide-open', state.guideOpen);
  const tg = $('tgGuide');
  if (tg) tg.classList.toggle('on', state.guideOpen);
  const pane = $('guidePane');
  if (pane) pane.setAttribute('aria-hidden', String(!state.guideOpen));
}

// Colour mode for the pointed pesukim (and the aligned practice words):
//   full  — word, vowels and trope all take the family colour (as before)
//   trope — only the cantillation mark is coloured; word + vowels stay grey
//   grey  — no colour at all (everything neutral grey)
function setColorMode(mode) {
  state.colorMode = mode;
  const seg = $('colorSeg');
  if (seg) seg.querySelectorAll('.cm').forEach((b) => b.classList.toggle('on', b.dataset.cm === mode));
  refreshText();
}

// Toggle a family/trope highlight (clicking the active one clears it).
function toggleHighlight(kind, value) {
  const cur = state.highlight;
  const same = cur && cur.kind === kind && String(cur.value) === String(value);
  state.highlight = same ? null : { kind, value };
  applyHighlight();
}

// One trope's card: swatch, name + meaning, role, its melodic diagram and note.
// `m` is a te'am codepoint (number) or the virtual 'sof' key for Sof Pasuk.
// Where a disjunctive sits in the hierarchy that divides the verse — the same
// ranking the "Divide" control uses to cut a pasuk into halves and sections.
const RANK_TIPS = {
  [RANK.EMPEROR]: 'Emperor — divides the verse itself',
  [RANK.KING]: 'King — divides half a verse',
  [RANK.DUKE]: 'Duke — divides a king\u2019s stretch',
  [RANK.COUNT]: 'Count — divides a duke\u2019s stretch',
};
function rankBadge(taam) {
  const rank = rankFor(taam);
  const tip = RANK_TIPS[rank];
  if (!tip) return '';
  return ` <span class="trank r${rank}" title="${tip}">${RANK_LABELS[rank]}</span>`;
}

function tropeCardHtml(m, color) {
  const isSof = m === 'sof';
  const taamVal = isSof ? 'sof' : String(m);
  const name = isSof ? SOF_PASUK_NAME : nameFor(m, state.tropeStyle);
  const glyph = markGlyph(m);
  const shapeKey = isSof ? 'sof' : String(m);
  const shape = state.shapes && state.shapes[shapeKey];
  const avgNote = shape ? ` <span class="avgn">of ${shape.n}</span>` : '';
  const meaning = name.meaning ? `<div class="tmean">“${name.meaning}”</div>` : '';
  return `<div class="trope g-trope" data-taam="${taamVal}" data-member="${shapeKey}" data-color="${color}" style="--c:${color}">
    <div class="tname"><span class="sw" style="background:${color}"></span>${name.he} · ${name.en}${avgNote}</div>
    ${meaning}
    <div class="trole">${glyph ? `<span class="markicon big" style="color:${color}">${glyph}</span>` : ''}${name.role}${name.role === 'conjunctive' ? ' → coloured by the accent it leads into' : ''}${rankBadge(m)}</div>
    <canvas width="150" height="42"></canvas>
    <div class="tnote">${name.note}</div>
  </div>`;
}

// Draw a trope's melodic diagram: the averaged shape from the recording when we
// have one, else the stylized motif from trope.js. Both follow the open reading's
// style, so opening a haftarah shows how each accent is sung in the haftarah.
function drawTropeDiagram(canvas, member, color) {
  if (!canvas) return;
  const shape = state.shapes && state.shapes[member];
  if (shape && shape.steps && shape.steps.length) { drawMiniSteps(canvas, shape.steps, color); return; }
  const motif = member === 'sof'
    ? sofPasukMotif(state.tropeStyle)
    : motifFor(Number(member), state.tropeStyle);
  drawMini(canvas, motif, color);
}

function renderGuide() {
  const body = $('guideBody');
  if (!body) return;
  // The diagrams below are the melody of whichever style the open reading is
  // taught in, so the guide says which one it is showing.
  const chip = $('guideStyle');
  if (chip) {
    const st = styleOf(state.tropeStyle);
    chip.textContent = `${st.label} melody`;
    chip.title = st.note;
    chip.hidden = false;
  }
  // Before the panel has ever been opened there is nothing to redraw: it will be
  // built from whatever style is current the first time it is shown. The chip
  // above is not part of that bargain — it sits in the settings sheet's reach and
  // names the melody the reading is taught in whether or not the guide is open.
  if (!guideBuilt) return;
  let html = '';
  FAMILIES.forEach((f) => {
    const glyphs = f.members.map((m) => `<span class="mk">${markGlyph(m)}</span>`).join('');
    html += `<div class="guide-fam">
      <button class="famchip guide-fam-head" data-fam="${f.id}" style="--c:${f.color}">
        <span class="sw" style="background:${f.color}"></span>
        <span class="gf-label">${f.label}</span>
        <span class="markicon">${glyphs}</span>
      </button>
      <div class="guide-tropes">${f.members.map((m) => tropeCardHtml(m, f.color)).join('')}</div>
    </div>`;
  });
  // Connectors (conjunctive accents): no fixed family colour of their own — each
  // one is a pickup into the following disjunctive, so it's grouped on its own
  // and shown in neutral grey.
  const conj = Object.keys(NAMES).map(Number).filter((cp) => NAMES[cp].role === 'conjunctive');
  if (conj.length) {
    html += `<div class="guide-fam">
      <div class="famchip guide-fam-head static" style="--c:${INK_GREY}">
        <span class="sw" style="background:${INK_GREY}"></span>
        <span class="gf-label">Connectors (conjunctive)</span>
      </div>
      <p class="hint gf-note">No fixed tune — each leads into the next accent and takes its colour (muted).</p>
      <div class="guide-tropes">${conj.map((m) => tropeCardHtml(m, INK_GREY)).join('')}</div>
    </div>`;
  }
  body.innerHTML = html;
  body.querySelectorAll('.g-trope').forEach((el) => {
    drawTropeDiagram(el.querySelector('canvas'), el.dataset.member, el.dataset.color);
  });
  body.querySelectorAll('.guide-fam-head[data-fam]').forEach((b) => {
    b.addEventListener('click', () => toggleHighlight('family', b.dataset.fam));
  });
  body.querySelectorAll('.g-trope').forEach((el) => {
    el.addEventListener('click', () => toggleHighlight('taam', el.dataset.taam));
  });
}

function bindToggle(id, fn) {
  $(id).addEventListener('click', () => { fn(); syncToggleUI(); });
}

function setScrollTextMode(mode) {
  // The reader saying which text they want: that is a preference, and it outranks
  // any surface a chain put them on, so the chain stops planning to put it back.
  state._scrollTextModeBeforeChain = null;
  applyScrollTextMode(mode, true);
}

// `persist` is false when the app is choosing the surface rather than the reader
// (see openChain): the text on screen changes, but what the reader last asked for
// is what comes back next time.
function applyScrollTextMode(mode, persist) {
  if (!['stam', 'pointed', 'dual'].includes(mode)) mode = 'stam';
  if (state.scrollTextMode === mode) return;
  state.scrollTextMode = mode;
  if (persist) savePanePrefs();
  syncToggleUI();
  if (!state.data) return;
  // The verse list is redrawn too, not just the scroll: its chain chips carry a
  // best per surface, and the one to show has just changed.
  if (state.aliyah) renderScrollPane();
  else renderVerses();
}

// Which of the chaining round's two surfaces the reader is actually reading from.
// Dual counts as the pointed one: the vowels and the accents are on screen, which
// is the help that tier is defined by, whichever column the eye is on.
function chainSurfaceNow() {
  return state.scrollTextMode === 'stam' ? 'stam' : 'pointed';
}

function setScrollSync(on) {
  state.scrollSync = !!on;
  savePanePrefs();
  syncToggleUI();
  if (state.data && state.scrollTextMode === 'dual' && (state.scrollView || state.aliyah)) {
    renderScrollPane();
  }
}

const PANE_PREF_KEY = 'cantillate.panes';
function loadPanePrefs() {
  try {
    const raw = localStorage.getItem(PANE_PREF_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (typeof p.scrollView === 'boolean') state.scrollView = p.scrollView;
    if (['stam', 'pointed', 'dual'].includes(p.scrollTextMode)) state.scrollTextMode = p.scrollTextMode;
    if (typeof p.scrollSync === 'boolean') state.scrollSync = p.scrollSync;
    if (typeof p.textCollapsed === 'boolean') state.textCollapsed = p.textCollapsed;
    if (typeof p.practiceCollapsed === 'boolean') state.practiceCollapsed = p.practiceCollapsed;
  } catch (_) { /* ignore corrupt prefs */ }
}
function savePanePrefs() {
  try {
    localStorage.setItem(PANE_PREF_KEY, JSON.stringify({
      scrollView: state.scrollView,
      scrollTextMode: state.scrollTextMode,
      scrollSync: state.scrollSync,
      textCollapsed: state.textCollapsed,
      practiceCollapsed: state.practiceCollapsed,
    }));
  } catch (_) { /* quota / private mode */ }
}
function syncPaneToggle(id, open) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('on', open);
  el.setAttribute('aria-pressed', open ? 'true' : 'false');
}
function syncToggleUI() {
  $('tgVowels').classList.toggle('on', state.showVowels);
  $('tgTaamim').classList.toggle('on', state.showTaamim);
  $('tgFont').classList.toggle('on', state.scroll);
  $('tgEnglish').classList.toggle('on', state.showEnglish);
  const tl = $('tgTranslit');
  if (tl) {
    const capped = state.level > FULL_VERSE_LEVEL;
    tl.classList.toggle('on', state.showTranslit && !capped);
    tl.disabled = capped;
    tl.title = capped
      ? `Not available from stage ${FULL_VERSE_LEVEL + 1} on — those stages are about reading with fewer aids, not more.`
      : 'Latin letters under each word, for reading along before the alphabet is fluent';
  }
  const seg = $('overlaySeg');
  if (seg) seg.querySelectorAll('.ov').forEach((b) => b.classList.toggle('on', b.dataset.ov === state.overlay));
  const sms = $('scoreModelSeg');
  if (sms) sms.querySelectorAll('.sm').forEach((b) => b.classList.toggle('on', b.dataset.sm === state.scoreModel));
  const shs = $('stamHandSeg');
  if (shs) shs.querySelectorAll('.sh').forEach((b) => b.classList.toggle('on', b.dataset.sh === state.stamHand));
  const stm = $('scrollTextModeSeg');
  if (stm) stm.querySelectorAll('[data-scroll-text]').forEach((b) => {
    b.classList.toggle('on', b.dataset.scrollText === state.scrollTextMode);
  });
  const ssy = $('scrollSync');
  if (ssy) {
    ssy.classList.toggle('on', state.scrollSync);
    ssy.disabled = state.scrollTextMode !== 'dual';
    ssy.setAttribute('aria-pressed', state.scrollSync ? 'true' : 'false');
  }
  document.body.classList.toggle('hand-ashkenaz', state.stamHand === 'ashkenaz');
  document.body.classList.toggle('scroll-view', state.scrollView);
  document.body.classList.toggle('scroll-dual-view', state.scrollTextMode === 'dual');
  document.body.classList.toggle('scroll-pointed-view', state.scrollTextMode === 'pointed');
  document.body.classList.toggle('scroll-sync-view', state.scrollTextMode === 'dual' && state.scrollSync);
  document.body.classList.toggle('pane-text-collapsed', state.textCollapsed);
  document.body.classList.toggle('pane-practice-collapsed', state.practiceCollapsed);
  syncPaneToggle('paneToggleScroll', state.scrollView);
  syncPaneToggle('paneToggleText', !state.textCollapsed);
  syncPaneToggle('paneTogglePractice', !state.practiceCollapsed);
  if (state.scrollView) requestAnimationFrame(fitScrollPages);
}
function setupPaneToggles() {
  const scrollBtn = $('paneToggleScroll');
  if (scrollBtn) scrollBtn.addEventListener('click', () => {
    if (state.aliyah) return;
    state.scrollView = !state.scrollView;
    savePanePrefs();
    syncToggleUI();
    renderVerses();
    maybeShowRotate();
  });
  const textBtn = $('paneToggleText');
  if (textBtn) textBtn.addEventListener('click', () => {
    state.textCollapsed = !state.textCollapsed;
    savePanePrefs();
    syncToggleUI();
  });
  const practiceBtn = $('paneTogglePractice');
  if (practiceBtn) practiceBtn.addEventListener('click', () => {
    state.practiceCollapsed = !state.practiceCollapsed;
    savePanePrefs();
    syncToggleUI();
    // Coach canvases need a fresh measure after the pane reappears.
    if (!state.practiceCollapsed && state.selectedVerse != null) {
      requestAnimationFrame(() => { if (state.selectedVerse != null) renderPractice(); });
    }
  });
  syncToggleUI();
}
// Map the unified Portion selector's value onto the underlying cycle/year state
// (kept separate because scoring, leaderboards and aliyah storage all key off
// cycle + triYear). "annual" = the whole parashah; "triN" = triennial year N.
function applyPortion(val) {
  if (val === 'annual') {
    state.cycle = 'annual';
  } else {
    state.cycle = 'triennial';
    state.triYear = parseInt(val.slice(3), 10) || 1;
  }
}
function syncPortionUI() {
  const el = $('portion');
  if (el) el.value = state.cycle === 'triennial' ? `tri${state.triYear}` : 'annual';
  // A fixed passage, a drill set or a haftarah has no annual/triennial choice to
  // make, so the portion controls (and the aliyah-boundary editor) come off the
  // bar entirely.
  const fixed = !hasAliyotCycle(state.readingKind);
  for (const id of ['portion', 'portionLabel', 'cycToday', 'btnEditAliyot']) {
    const c = $(id);
    if (c) c.hidden = fixed;
  }
}

// ---------------------------------------------------------------------------
// Audio sources (voices). A reading can offer more than one recorded voice for
// the example + duet practice (e.g. PocketTorah plus another reader). The
// default source ('pockettorah') uses the original unsuffixed file names for
// zero migration; any other source id `sid` uses `_<sid>`-suffixed files and a
// per-source raw-shard subfolder. See scripts/build_reading.py for the build.
// ---------------------------------------------------------------------------

const DEFAULT_SOURCE = 'pockettorah';
const SOURCE_PREF_KEY = 'cantillate.audioSource';

// --- Scoring model selection (dev/testing) ---------------------------------
// Two scorers run in parallel; this picks which one "counts" toward stored
// bests, stars and unlocks. Both are always shown side by side. Selectable via
// the toolbar, a `?score=gh|contour` URL param (wins + persists), or the saved
// preference. Defaults to the original melody/contour scorer.
const SCORE_MODEL_KEY = 'cantillate.scoreModel';

function initScoreModel() {
  let m = null;
  try { const q = new URLSearchParams(location.search).get('score'); if (q) m = q; } catch (e) { /* ignore */ }
  if (m !== 'contour' && m !== 'gh') { try { m = localStorage.getItem(SCORE_MODEL_KEY); } catch (e) { m = null; } }
  state.scoreModel = m === 'gh' ? 'gh' : 'contour';
  try { localStorage.setItem(SCORE_MODEL_KEY, state.scoreModel); } catch (e) { /* private mode */ }
  syncToggleUI();
}

// --- Transliteration -------------------------------------------------------
// Latin letters under each word, for a reader who has the tune before the
// alphabet (see js/translit.js for the scheme).
//
// It is the strongest aid in the app — stronger than the vowels — so it is
// capped rather than merely offered. Stages 6-9 exist precisely to take the
// helpers away one at a time (drop the te'amim, drop the vowels, read the bare
// scroll), and a Latin line underneath would make every one of them a fiction.
// So the aid is available up to the first whole-verse stage and switches itself
// off above it; the toggle stays visible but says why it can't be used, which is
// how the ladder teaches what it is for. See aidsForLevel.
const TRANSLIT_KEY = 'cantillate.translit';

function initTranslit() {
  let v = null;
  try { v = localStorage.getItem(TRANSLIT_KEY); } catch (e) { v = null; }
  state.showTranslit = v === '1';
  syncToggleUI();
}

function setTranslit(on) {
  state.showTranslit = !!on;
  try { localStorage.setItem(TRANSLIT_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
  refreshText();
}

// Is the aid actually in force right now? Wanted by the reader AND allowed by
// the stage. Anything that draws a word asks this, not state.showTranslit.
function translitOn(level = levelById(state.level)) {
  return state.showTranslit && level.id <= FULL_VERSE_LEVEL;
}

// --- Scribal hand for the STA"M -------------------------------------------
// Two bundled scroll fonts. Shlomo Stam draws the letters as a sofer writes
// them — notably the mem, whose vav-leg runs long and heavy into the base under
// a near-closed notch, where Stam Ashkenaz CLM's is short and light under a wide
// one and so reads as a vav beside a kaf. Ashkenaz stays available: the hand you
// train on should be the hand in the scroll you'll read from. The CSS does the
// swap through the --stam variable; nothing needs re-rendering.
const STAM_HAND_KEY = 'cantillate.stamHand';

function initStamHand() {
  let h = null;
  try { h = localStorage.getItem(STAM_HAND_KEY); } catch (e) { h = null; }
  state.stamHand = h === 'ashkenaz' ? 'ashkenaz' : 'shlomo';
  syncToggleUI();
}

function setStamHand(h) {
  state.stamHand = h === 'ashkenaz' ? 'ashkenaz' : 'shlomo';
  try { localStorage.setItem(STAM_HAND_KEY, state.stamHand); } catch (e) { /* private mode */ }
  syncToggleUI();
}

// Tracking (letter-spacing) for the STA"M, in em so it holds at any reading
// size. Nothing about the mem's own notch can be tightened — it is what keeps it
// an open mem rather than a final one — so the reader's lever is the space
// between real letters. Applied as a CSS variable; the scroll surfaces pick it
// up without a re-render. The fixed tikkun column is exempt — its lines have no
// width to spare (see .scroll-page).
const STAM_TRACK_KEY = 'cantillate.stamTrack';
const TRACK_MIN = 0, TRACK_MAX = 0.1, TRACK_DEFAULT = 0.05;

function loadStamTrack() {
  let v = NaN;
  try { v = parseFloat(localStorage.getItem(STAM_TRACK_KEY) || ''); } catch (e) { /* ignore */ }
  return Number.isFinite(v) ? Math.max(TRACK_MIN, Math.min(TRACK_MAX, v)) : TRACK_DEFAULT;
}

function applyStamTrack(em) {
  const v = Math.max(TRACK_MIN, Math.min(TRACK_MAX, Number(em)));
  state.stamTrack = v;
  document.body.style.setProperty('--stam-track', v + 'em');
  try { localStorage.setItem(STAM_TRACK_KEY, String(v)); } catch (e) { /* private mode */ }
}

function setupStamTrack() {
  const el = $('stamTrack');
  const v = loadStamTrack();
  applyStamTrack(v);
  if (el) {
    el.value = String(v);
    el.addEventListener('input', (e) => applyStamTrack(parseFloat(e.target.value)));
  }
}

function setScoreModel(m) {
  state.scoreModel = m === 'gh' ? 'gh' : 'contour';
  try { localStorage.setItem(SCORE_MODEL_KEY, state.scoreModel); } catch (e) { /* private mode */ }
  syncToggleUI();
  // Refresh the "which model" badge on the score bars (bars themselves show
  // saved bests, which don't change with the toggle).
  if (state.selectedVerse != null && !state.aliyah) renderAccuracyPanel();
}

// Score a set of coach note-steps against the user trail with BOTH models, so we
// can show them side by side while testing. `active` is the currently-selected
// model's 0..100 (what gets stored / drives stars & unlocks). The contour value
// flattens the steps to a polyline exactly as buildCoach does, so with the
// default model this is identical to the previous scoreTrail(...) calls.
function scoreSteps(trail, steps) {
  const contour = scoreTrail(trail, stepsToPoints(steps));
  const gh = scoreNotes(trail, steps);
  return { contour, gh: gh.score, ghDetail: gh, active: state.scoreModel === 'gh' ? gh.score : contour };
}

// The note-hit scorer tends to run tougher than the melody scorer, so when it is
// the active model we EASE the level-up milestones (scaled below the melody
// thresholds). Melody keeps its original thresholds unchanged.
const GH_THRESHOLD_SCALE = 0.8;
function effectiveThreshold(level) {
  const t = (level && level.threshold) || 0;
  return state.scoreModel === 'gh' ? Math.round(t * GH_THRESHOLD_SCALE) : t;
}

function isDefaultSource(sid) {
  return !sid || sid === DEFAULT_SOURCE;
}

// Data file path for a reading's audio source. `suffix` is the trailing part,
// e.g. 'audio.json', 'pitch.slim.json', 'pitch.json', 'shapes.json',
// 'pitch.raw.json'.
function srcPath(slug, sid, suffix) {
  return isDefaultSource(sid)
    ? `data/${slug}_${suffix}`
    : `data/${slug}_${sid}_${suffix}`;
}

// Per-verse raw-contour shard path for the active source.
function rawShardPath(slug, sid, n) {
  return isDefaultSource(sid)
    ? `data/pitch/${slug}/${n}.raw.json`
    : `data/pitch/${slug}/${sid}/${n}.raw.json`;
}

// Per-verse SLIM shard (one entry of the monolith's `verses` map) and the
// manifest listing which pesukim have one. Laid out like rawShardPath, so a
// non-default voice keeps its own directory rather than borrowing the default
// voice's shards — a source with no shards simply 404s and takes the monolith.
function pitchShardPath(slug, sid, n) {
  return isDefaultSource(sid)
    ? `data/pitch/${slug}/${n}.json`
    : `data/pitch/${slug}/${sid}/${n}.json`;
}

function pitchIndexPath(slug, sid) {
  return isDefaultSource(sid)
    ? `data/pitch/${slug}/index.json`
    : `data/pitch/${slug}/${sid}/index.json`;
}

// The sources a reading advertises (from its manifest entry). Falls back to a
// single default PocketTorah source so older manifest entries keep working.
function readingSources(meta) {
  // An entry that declares an EMPTY sources list has no recording at all (a
  // passage picked out of a book nobody has recorded); one that omits the key
  // predates voices and means the single PocketTorah recording.
  if (meta && Array.isArray(meta.sources) && !meta.sources.length) return [];
  const list = meta && Array.isArray(meta.sources) ? meta.sources.filter((s) => s && s.id) : [];
  if (list.length) return list;
  return [{ id: DEFAULT_SOURCE, label: 'PocketTorah (Neiss & Schwartz)', default: true }];
}

function loadSourcePref() {
  try { return localStorage.getItem(SOURCE_PREF_KEY) || null; } catch (e) { return null; }
}

function saveSourcePref(sid) {
  try { localStorage.setItem(SOURCE_PREF_KEY, sid); } catch (e) { /* private mode */ }
}

// Choose the active source for a reading: the user's saved voice if this reading
// offers it, otherwise the reading's declared default (or the first listed).
function resolveAudioSource(sources) {
  const pref = loadSourcePref();
  if (pref && sources.some((s) => s.id === pref)) return pref;
  const def = sources.find((s) => s.default) || sources[0];
  return def ? def.id : DEFAULT_SOURCE;
}

// Queue work for the first idle moment after the app is interactive, so a
// prefetch never competes with the render it was moved off the critical path to
// unblock. Safari has no requestIdleCallback, hence the timer fallback.
function whenIdle(fn, timeout = 1500) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout });
  else setTimeout(fn, 250);
}

// Fetch the recorded-chant / pitch / shapes data for `slug` at source `sid` and
// populate state. Missing files degrade gracefully (playback without a coach
// line / spectrogram overlay), exactly as a reading with no recording does.
async function loadAudioSource(slug, sid) {
  state.audioSource = sid;
  state.audio = null;
  state.pitch = null;
  state.shapes = null;
  // Phase 2: the faint-underlay `raw` contours are NOT loaded up front anymore.
  // They're fetched per-verse (tiny shard) when a pasuk is practiced, or as the
  // whole-reading monolith when an aliyah (many verses) is opened.
  _rawLoaded = new Set();
  _rawMonolithTried = false;
  _pitchShards = null;
  _pitchRequested = new Set();
  _pitchMonolithPromise = null;
  // A reading that advertises no voice at all has no per-reading audio, pitch or
  // shapes files to look for, so it skips straight to the corpus shapes below
  // rather than asking for four files that were never built.
  if (!sid || !(state.sources || []).length) {
    await loadCorpusShapes();
    return;
  }
  try {
    const ar = await fetch(srcPath(slug, sid, 'audio.json'));
    if (ar.ok) state.audio = await ar.json();
  } catch (e) { /* no recorded audio available */ }
  registerAudioCuts(state.audio);
  // Phase 3: the whole-parashah pitch payload (a quarter of a megabyte on the
  // longer readings, re-fetched on every reading switch) is no longer on the
  // critical path. All that is awaited here is the per-verse manifest — a few
  // hundred bytes naming which pesukim have extracted pitch — and each pasuk's
  // slim shard is fetched when that pasuk is actually practiced. Multi-verse
  // views, which would otherwise need dozens of shards at once, still take the
  // monolith in one request, exactly as the `raw` underlay does.
  const pitchIndex = await loadPitchIndex(slug, sid);
  if (pitchIndex) {
    _pitchShards = new Set(pitchIndex.verses);
    state.pitch = { slug: pitchIndex.slug || slug, verses: {} };
  } else {
    // No shards deployed for this reading (only 15 have them) — the monolith is
    // the only source there is, so it stays on the critical path as before.
    const doc = await loadPitchMonolith(slug, sid);
    if (doc) state.pitch = doc;
  }
  try {
    const sr = await fetch(srcPath(slug, sid, 'shapes.json'));
    if (sr.ok) state.shapes = (await sr.json()).shapes;
  } catch (e) { /* no averaged trope shapes available */ }
  await loadCorpusShapes();
}

// A reading with no recording of its own (a drill set, or a passage picked out of
// a book nobody has recorded) borrows the corpus-wide measured shapes, so its
// coach line and voice guide teach the melody a cantor actually sings rather than
// a hand-drawn approximation. The corpus is per style: the Torah's shapes would
// teach the wrong tune for a haftarah.
async function loadCorpusShapes() {
  if (state.shapes) return;
  try {
    const cr = await fetch(styleOf(state.tropeStyle).shapes);
    if (cr.ok) state.shapes = (await cr.json()).shapes;
  } catch (e) { /* fall back to the stylized motifs in trope.js */ }
}

// Populate + show/hide the topbar voice selector for the current reading.
function renderSourceSelector() {
  const sel = $('audioSource');
  const label = $('audioSourceLabel');
  if (!sel) return;
  const sources = state.sources || [];
  const multi = sources.length > 1;
  sel.hidden = !multi;
  if (label) label.hidden = !multi;
  sel.innerHTML = '';
  sources.forEach((s) => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.label || s.id;
    sel.appendChild(o);
  });
  sel.value = state.audioSource;
}

// Switch the active voice without reloading the reading's text. Re-fetches the
// source's audio/pitch/shapes, re-primes offline, and redraws the open view.
async function switchAudioSource(sid) {
  const slug = state.slug;
  if (!slug || sid === state.audioSource) return;
  saveSourcePref(sid);
  await loadAudioSource(slug, sid);
  if (state.slug !== slug) return; // reading changed while loading
  renderSourceSelector();
  renderGuide();
  applyHighlight();
  if (state.aliyah) renderAliyahView();
  else if (state.selectedVerse != null) renderPractice();
  try {
    await offline.primeReading(readingAudioFiles());
  } catch (e) { /* offline store unavailable */ }
  refreshOfflineButton();
}

// A reading entry can be one of these kinds:
//   parashah  the default — its own text, recording and extracted pitch
//   haftarah  the week's passage from the Prophets: its own text and recording
//             like a parashah, but chanted to the haftarah melody and read
//             straight through, so it has one chunk instead of seven aliyot
//   excerpt   a named passage (the Shema, the Ten Commandments) that reuses a
//             parashah's files and simply narrows the verses on screen, so it
//             comes with the real recorded chant for free and its practice
//             counts toward that parashah's progress
//   drill     a synthetic exercise set with no recording; the coach line is
//             built from the trope motifs in trope.js (see buildSyntheticCoach)
//   custom    a range the reader picked out of any book of the Tanakh, assembled
//             at runtime from data/tanakh/ (see openCustomRange)
function readingKind(meta) { return (meta && meta.kind) || 'parashah'; }

// A haftarah is chanted straight through, so it has no aliyot to choose between
// and its verse range is fixed — the same as an excerpt or a drill in that
// respect, which is what the portion control and the aliyot pane key off.
function hasAliyotCycle(kind) { return kind === 'parashah'; }

// Which melody a reading is taught in. Carried by the manifest entry and by the
// data file (either is enough), defaulting to the Torah reading style.
function tropeStyleOf(meta, data) {
  return (meta && meta.tropeStyle) || (data && data.tropeStyle) || DEFAULT_STYLE;
}

// Every melody the app draws or sings is built for the style of the open
// reading, so this is the only place buildLineMelody is called from.
function lineMelody(tokens) { return buildLineMelody(tokens, state.tropeStyle); }

// tokenize + lineMelody for one pasuk, remembered. Both are pure functions of
// the text and the melody, and the pesukim list is rebuilt whole on every tap —
// so a forty-pasuk haftarah was being re-parsed and re-set to a tune dozens of
// times a sitting. Cleared when the reading (and with it the melody) changes.
// The segments are shared, so treat them as read-only.
const _verseSegs = new Map();

function verseSegments(n) {
  let segs = _verseSegs.get(n);
  if (segs) return segs;
  const v = state.data && state.data.verses[n - 1];
  if (!v) return [];
  segs = lineMelody(tokenize(v.text));
  _verseSegs.set(n, segs);
  return segs;
}

// Where a reading's data files live. An excerpt borrows its parent's.
function dataSlugOf(meta) { return (meta && meta.base) || (meta && meta.slug); }

// The fixed Davidovich page data is the whole Torah in one half-megabyte
// payload, and the STA"M column it lays out is a view the reader opts into — so
// it is never on the critical path. Whichever comes first wins: the idle
// prefetch queued once a reading is interactive, or the reader opening the
// column. Until it lands renderTikkunPages returns null and the pane draws its
// reflowed fallback (the browser's line breaks rather than the scroll's), so
// there is no empty pane and no spinner standing between the reader and the
// text. `_tikkunData` outlives a reading switch because the payload covers every
// reading; loadTikkunData memoizes the fetch itself.
let _tikkunData = null;
let _tikkunFailed = false;

async function ensureTikkunData() {
  if (state.tikkun || _tikkunFailed) return;
  const slug = state.slug;
  try {
    _tikkunData = await loadTikkunData();
  } catch (e) {
    _tikkunFailed = true;
    console.warn('[tikkun] fixed page data unavailable; using continuous fallback', e);
    return;
  }
  state.tikkun = _tikkunData;
  // A reading switch while the payload was in flight doesn't invalidate it, only
  // this redraw: that reading's own pane will have queued its own upgrade.
  if (state.slug !== slug) return;
  if (window.__cantillateBusy || state.playingReal) return;
  if (state.scrollView || state.aliyah) renderScrollPane();
}

// What the pesukim pane calls the open reading. A parashah and a haftarah are
// known by name (with the passage after it); a passage the reader picked is known
// by its reference in both languages, led by whatever they named it if they did.
function readingTitle(kind, meta) {
  const par = state.data.parashah;
  if (kind === 'custom') {
    const ref = `${state.data.ref} — ${state.data.heRef}`;
    return meta && meta.name ? `${meta.name} · ${ref}` : ref;
  }
  if (kind === 'haftarah' && par) return `${par.en} — ${par.he} · ${state.data.ref || ''}`.trim();
  if (kind !== 'parashah') return meta.label;
  if (par) return `${par.en} — ${par.he}`;
  return `${state.data.book.en} ${state.data.chapter} — ${state.data.book.he}`;
}

// The reading's text. Every shipped reading has a built data file; a custom
// passage has none, so it is assembled from the book's text in data/tanakh/
// (see js/tanakh.js) — which is also what lets a passage the reader opened last
// week be restored from a menu entry alone.
async function readingDocFor(meta) {
  if (readingKind(meta) === 'custom' && meta.custom) {
    const { book, from, to } = meta.custom;
    await corpus.loadIndex();
    const entry = corpus.bookEntry(book);
    if (!entry) throw new Error(`unknown book: ${book}`);
    // Only the chapters the passage runs through: a haftarah out of Isaiah is
    // three chapters, where the book is five hundred KB.
    const heDoc = await corpus.loadBookRange(entry, from[0], to[0]);
    const enDoc = corpus.rangeIfLoaded(entry, from[0], to[0], true);
    return corpus.buildReading(entry, heDoc, from, to, enDoc, meta.name);
  }
  const resp = await fetch(meta.file);
  return resp.json();
}

async function loadData(readingId) {
  const meta = AVAILABLE.find((p) => p.slug === readingId);
  const kind = readingKind(meta);
  const dataSlug = dataSlugOf(meta);
  state.data = await readingDocFor(meta);
  _verseSegs.clear();
  state.tikkun = _tikkunData;
  state.readingId = readingId;
  // Progress is filed under the DATA slug, so working through the Shema also
  // advances the pesukim of Va'etchanan rather than starting a parallel tally.
  // A custom passage brings its own slug (the book plus where it starts), so
  // every range that opens on the same pasuk shares one tally.
  state.slug = (kind === 'custom' && state.data.slug) || dataSlug;
  state.readingKind = kind;
  state.excerpt = kind === 'excerpt' ? meta : null;
  state.drill = kind === 'drill' ? meta : null;
  state.custom = kind === 'custom' ? (state.data.custom || meta.custom) : null;
  // Set before the audio source loads: it decides which measured trope corpus is
  // the fallback for the coach line.
  state.tropeStyle = tropeStyleOf(meta, state.data);
  state.selectedVerse = null;
  if (state.aliyah) setAliyahLayout(false); // leave aliyah layout when the reading changes
  state.aliyah = null;
  // An excerpt or a haftarah is a fixed passage, so the annual/triennial portion
  // control has nothing to choose; pin it to annual and hide the picker (see
  // syncPortionUI).
  if (!hasAliyotCycle(kind)) { state.cycle = 'annual'; state.triYear = 1; }
  syncPortionUI();
  // Resolve which recorded voice (audio source) to load for this reading, then
  // fetch its recorded-chant / pitch / shapes data. Honours the user's saved
  // voice preference when this reading offers it, else the reading's default.
  state.sources = readingSources(meta);
  const effectiveSource = resolveAudioSource(state.sources);
  await loadAudioSource(dataSlug, effectiveSource);
  renderSourceSelector();
  $('textTitle').textContent = readingTitle(kind, meta);
  $('srcVersion').textContent = state.data.heVersionTitle || state.data.versionTitle || 'Masoretic text';
  renderVerses();
  renderAliyot();
  renderStageBar();
  renderGuide();   // redraw the trope diagrams now that this reading's averaged shapes are in
  applyHighlight();
  $('practice').classList.remove('aliyah-fill');
  $('practice').innerHTML = '<p class="empty">Select a verse on the left to begin practicing.</p>';
  // Now that the reading is on screen and interactive, fetch what was kept off
  // its critical path: the opening pesukim's pitch shards and the tikkun page
  // data, so the first pasuk tapped and the first opening of the Torah column
  // usually find their data already in hand.
  whenIdle(() => {
    if (state.readingId !== readingId) return; // reading changed meanwhile
    warmPitchShards(divisionRange()[0]);
    ensureTikkunData();
    // The translation of a whole book is a separate download from its text, so a
    // custom passage only fetches it if the English column is actually open.
    if (state.showEnglish) ensureCustomEnglish();
  });
  // Offline: register any already-downloaded audio for this reading so playback
  // uses local blobs, and refresh the "⬇ Offline" button to reflect its state.
  try {
    await offline.primeReading(readingAudioFiles());
  } catch (e) { /* offline store unavailable */ }
  refreshOfflineButton();
}

// ---------------------------------------------------------------------------
// Any passage, any book. The shipped readings are the recorded ones; this opens
// the rest of the canon — pick a book, then (in the Torah) a parashah or
// (elsewhere) a chapter, then the first and last pasuk. The text comes from
// data/tanakh/ (see js/tanakh.js) and is chanted in the haftarah melody, the
// chant for reading from a book rather than from the scroll. A picked passage
// becomes an ordinary entry in the Reading menu, so everything else — the
// pesukim list, the verse stages, the whole-passage challenge, the leaderboard —
// treats it like any other reading.
// ---------------------------------------------------------------------------

const CUSTOM_GROUP = 'Any passage';
const CUSTOM_RECENT_KEY = 'cantillate.customRanges';
const CUSTOM_RECENT_MAX = 8;
// Long enough for "Yaakov's bar mitzvah haftarah", short enough to read in the
// menu without the reference it stands for being pushed off the end.
const CUSTOM_NAME_MAX = 60;
// Psalms, Proverbs and Job are pointed with the other Masoretic accent system:
// the same words and marks are here, but neither melody was ever sung to those
// accents, so the guide is a reading of the shapes rather than a tradition.
const POETIC_NOTE = 'Poetic accents (Psalms · Proverbs · Job) — a different accent '
  + 'system from the one the Torah and haftarah melodies belong to, so the '
  + 'synthesized guide is an approximation here.';

function loadCustomRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_RECENT_KEY));
    return Array.isArray(raw) ? raw.filter((r) => r && r.book && r.from && r.to) : [];
  } catch (e) { return []; }
}

function saveCustomRecents(list) {
  try { localStorage.setItem(CUSTOM_RECENT_KEY, JSON.stringify(list.slice(0, CUSTOM_RECENT_MAX))); }
  catch (e) { /* private mode: the passage just won't be remembered */ }
}

// Keep the passage in the menu across reloads, most recent first, so a range
// worked on over several sittings is one click away (and its progress with it).
function rememberCustomRange(desc) {
  const id = corpus.readingId(desc.book, desc.from, desc.to);
  const list = loadCustomRecents().filter((r) => corpus.readingId(r.book, r.from, r.to) !== id);
  list.unshift(desc);
  saveCustomRecents(list);
}

// A reference is how a passage is found; a name is what the reader calls it.
// Naming one ("Bar mitzvah haftarah") keeps it in the menu under that name for
// good, where the recents above age out after CUSTOM_RECENT_MAX. Names are saved
// with the reader's progress rather than in a key of their own, so they follow a
// signed-in reader to their other devices (see store.getSavedPassages).
function loadSavedPassages() {
  return store.getSavedPassages().filter((p) => p && p.book && p.from && p.to && p.name);
}

const passageId = (p) => corpus.readingId(p.book, p.from, p.to);

// What the reader called this passage, or '' if they never named it.
function savedNameFor(bookSlug, from, to) {
  const id = corpus.readingId(bookSlug, from, to);
  const hit = loadSavedPassages().find((p) => passageId(p) === id);
  return hit ? hit.name : '';
}

// Name a passage, or rename one already named. Most recently named first, so the
// menu and the picker lead with what the reader is working on now.
function saveCustomPassage(desc, name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, CUSTOM_NAME_MAX);
  if (!clean) return '';
  const id = corpus.readingId(desc.book, desc.from, desc.to);
  const list = loadSavedPassages();
  // Re-saving the same name is what opening a named passage does; leave the list
  // (and its order) alone rather than shuffling it on every visit.
  if (list.some((p) => passageId(p) === id && p.name === clean)) return clean;
  const rest = list.filter((p) => passageId(p) !== id);
  store.setSavedPassages([{
    book: desc.book, from: desc.from, to: desc.to, name: clean, style: desc.style,
  }, ...rest]);
  return clean;
}

// Take the name off. The passage itself is untouched: it stays in the menu under
// its reference for as long as the recents hold it, and everything practiced in
// it is kept either way, since none of it was ever filed under the name.
function forgetCustomPassage(id) {
  store.setSavedPassages(loadSavedPassages().filter((p) => passageId(p) !== id));
}

// The manifest entry for a custom passage. Built from the book index alone (no
// text needed), so restoring a remembered passage costs nothing until it is
// opened. `sources: []` says there is no recording; `custom` is what
// readingDocFor uses to assemble the text.
// `style` names which melody the passage is taught in. It defaults to the
// haftarah — the chant for reading from a book, which is right for the bulk of
// the canon and for everything the ✦ Any passage picker offers. Guided mode is
// the exception: when the passage IS the reader's maftir, the words come from the
// chumash and the Torah melody is the correct one, so it asks for that explicitly
// rather than being taught the wrong tune (see loadPartReading in guided.js).
function customEntry(bookEntry, from, to, name = '', style = corpus.CUSTOM_TROPE_STYLE) {
  const { from: lo, to: hi, count } = corpus.normalizeRange(bookEntry, from, to);
  const ref = corpus.refFor(bookEntry.en, lo, hi);
  const heRef = corpus.heRefFor(bookEntry.he, lo, hi);
  // A named passage shows its name in the menu, so the reference it stands for
  // leads the tooltip instead of being lost.
  const melody = style === 'torah' ? 'Torah melody' : 'haftarah melody';
  const notes = [name ? ref : '', heRef,
    `${plural(count, 'pasuk', 'pesukim')} · ${melody}, synthesized guide`].filter(Boolean);
  if (bookEntry.accents === 'poetic') notes.push(POETIC_NOTE);
  return {
    slug: corpus.readingId(bookEntry.slug, lo, hi),
    kind: 'custom',
    tropeStyle: style,
    group: CUSTOM_GROUP,
    label: name || ref,
    name,
    note: notes.join(' · '),
    sources: [],
    custom: { book: bookEntry.slug, from: lo, to: hi, count, style },
  };
}

// Rebuild the Any passage group from what's persisted: the passages the reader
// named first, then the ones merely opened, each most recent first. Called after
// anything that changes either list, so naming, renaming, forgetting and opening
// all reach the menu by one path. `extra` is an entry to include regardless (a
// passage being opened right now, before it has been remembered).
function syncCustomMenu(select, extra) {
  if (!corpus.indexIfLoaded()) return;
  const keep = [];
  const seen = new Set();
  const add = (desc, name) => {
    const entry = corpus.bookEntry(desc.book);
    if (!entry || seen.has(corpus.readingId(desc.book, desc.from, desc.to))) return;
    // `style` rides along with the descriptor so a passage opened in the Torah
    // melody comes back in it after a reload, rather than silently reverting to
    // the haftarah default (see customEntry).
    const meta = customEntry(entry, desc.from, desc.to, name, desc.style);
    seen.add(meta.slug);
    keep.push(meta);
  };
  for (const p of loadSavedPassages()) add(p, p.name);
  for (const r of loadCustomRecents()) add(r, '');
  // Never take the open reading out from under the reader, listed or not.
  for (const p of AVAILABLE) {
    if (p.kind === 'custom' && p.slug === state.readingId && !seen.has(p.slug)) {
      seen.add(p.slug);
      keep.push(p);
    }
  }
  if (extra && !seen.has(extra.slug)) keep.push(extra);
  AVAILABLE = [...AVAILABLE.filter((p) => p.kind !== 'custom'), ...keep];
  // The leaderboard's snapshot of every reading is built once; a passage added or
  // renamed since then has to be picked up next time it is browsed.
  _readingsMetaCache = null;
  const sel = $('parashah');
  if (sel) {
    const value = select || sel.value;
    renderReadingMenu(sel);
    if (value) sel.value = value;
  }
}

async function openCustomRange(bookSlug, from, to,
  { remember = true, name = '', tropeStyle = corpus.CUSTOM_TROPE_STYLE } = {}) {
  await corpus.loadIndex();
  const entry = corpus.bookEntry(bookSlug);
  if (!entry) throw new Error(`unknown book: ${bookSlug}`);
  const norm = corpus.normalizeRange(entry, from, to);
  if (norm.count > corpus.MAX_VERSES) {
    throw new Error(`${norm.count} pesukim is more than one passage (max ${corpus.MAX_VERSES})`);
  }
  const desc = {
    book: entry.slug, from: norm.from, to: norm.to, count: norm.count, style: tropeStyle,
  };
  if (name) saveCustomPassage(desc, name);
  if (remember) rememberCustomRange(desc);
  const meta = customEntry(entry, norm.from, norm.to,
    savedNameFor(entry.slug, norm.from, norm.to), tropeStyle);
  syncCustomMenu(meta.slug, meta);
  await loadData(meta.slug);
  return meta;
}

// Named and remembered passages, back in the menu at startup without fetching
// any text.
async function restoreCustomRanges() {
  if (!loadCustomRecents().length && !loadSavedPassages().length) return;
  try { await corpus.loadIndex(); } catch (e) { return; } // corpus not deployed
  syncCustomMenu();
}

// The translation of a book is a separate file from its text, so a custom passage
// starts with an empty English column and fills it the first time the column is
// actually opened.
async function ensureCustomEnglish() {
  if (state.readingKind !== 'custom' || !state.custom) return;
  const book = state.custom.book;
  const { from, to } = state.custom;
  const entry = corpus.bookEntry(book);
  if (!entry || corpus.rangeIfLoaded(entry, from[0], to[0], true)) return;
  const readingId = state.readingId;
  let enDoc = null;
  try { enDoc = await corpus.loadEnglishRange(entry, from[0], to[0]); } catch (e) { return; }
  if (!enDoc || state.readingId !== readingId) return;
  corpus.fillEnglish(state.data, enDoc);
  $('srcVersion').textContent = state.data.heVersionTitle || state.data.versionTitle || 'Masoretic text';
  if (state.showEnglish) renderVerses();
}

// --- The picker -------------------------------------------------------------

function setupCustomPicker() {
  const btn = $('btnAnyPassage');
  const modal = $('customModal');
  if (!btn || !modal) return;
  btn.addEventListener('click', () => openCustomPicker());
  modal.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => { modal.hidden = true; });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });
  for (const id of ['crBook', 'crScope', 'crFromC', 'crFromV', 'crToC', 'crToV']) {
    const el = $(id);
    if (el) el.addEventListener('change', () => onPickerChange(id));
  }
  const name = $('crName');
  // Once the reader has typed something, the box is theirs: stop replacing it as
  // the range moves (see updateCustomPreview).
  name.addEventListener('input', () => { _crNameIsSaved = false; });
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveFromPicker(); }
  });
  $('crSave').addEventListener('click', () => saveFromPicker());
  $('crOpen').addEventListener('click', () => submitCustomPicker());
}

// Whether the name box holds a name we put there (a saved passage's) rather than
// one the reader is in the middle of typing.
let _crNameIsSaved = true;

// The book the picker is currently showing, straight from the index.
function pickerBook() {
  return corpus.bookEntry($('crBook').value);
}

async function openCustomPicker() {
  const modal = $('customModal');
  const status = $('crStatus');
  if (!modal) return;
  modal.hidden = false;
  status.textContent = '';
  let index;
  try {
    index = await corpus.loadIndex();
  } catch (e) {
    status.textContent = 'The Tanakh text isn\u2019t deployed yet — run scripts/build_tanakh.py.';
    $('crOpen').disabled = true;
    return;
  }
  $('crOpen').disabled = false;
  const sel = $('crBook');
  if (!sel.options.length) {
    for (const sec of index.sections) {
      const books = index.books.filter((b) => b.section === sec.id);
      if (!books.length) continue;
      const group = document.createElement('optgroup');
      group.label = sec.label;
      for (const b of books) {
        const o = document.createElement('option');
        o.value = b.slug;
        o.textContent = `${b.en} · ${b.he}`;
        group.appendChild(o);
      }
      sel.appendChild(group);
    }
    // Open on the book the reader is already in, so "the next chapter along" is
    // two clicks rather than a hunt through the list.
    const here = (state.custom && state.custom.book)
      || (state.data && state.data.book && bookSlugFor(state.data.book.en));
    if (here && index.books.some((b) => b.slug === here)) sel.value = here;
    onPickerChange('crBook');
  }
  updateCustomPreview();
  renderSavedPassages();
  renderCustomRecents();
}

function bookSlugFor(en) {
  const idx = corpus.indexIfLoaded();
  const hit = idx && idx.books.find((b) => b.en === en);
  return hit ? hit.slug : null;
}

function fillNumberSelect(el, count, value) {
  const want = Math.min(Math.max(1, value || 1), count);
  if (el.options.length !== count) {
    el.innerHTML = '';
    for (let i = 1; i <= count; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = String(i);
      el.appendChild(o);
    }
  }
  el.value = String(want);
  return want;
}

// Keep the four chapter/verse selectors consistent with the chosen book and with
// each other, and describe what is currently selected. `changed` is the control
// the reader just touched, which decides what follows what.
function onPickerChange(changed) {
  const entry = pickerBook();
  if (!entry) return;
  const chapters = entry.chapters;
  const note = $('crBookNote');
  note.textContent = entry.accents === 'poetic' ? 'poetic accents' : entry.sectionLabel;

  const scopeRow = $('crScopeRow');
  const scope = $('crScope');
  const scopeLabel = $('crScopeLabel');
  const parashiyot = entry.parashiyot || null;
  scopeLabel.textContent = parashiyot ? 'Parashah' : 'Chapter';
  scopeRow.hidden = false;

  if (changed === 'crBook') {
    // A new book: offer its parashiyot (Torah) or its chapters, and start at the
    // beginning of the first one.
    scope.innerHTML = '';
    if (parashiyot) {
      parashiyot.forEach((p, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = `${p.en} · ${p.he} (${p.start[0]}:${p.start[1]}\u2013${p.end[0]}:${p.end[1]})`;
        scope.appendChild(o);
      });
    } else {
      chapters.forEach((n, i) => {
        const o = document.createElement('option');
        o.value = String(i + 1);
        o.textContent = `${i + 1} (${plural(n, 'pasuk', 'pesukim')})`;
        scope.appendChild(o);
      });
    }
    scope.value = scope.options.length ? scope.options[0].value : '';
    changed = 'crScope';
  }

  if (changed === 'crScope') {
    // Selecting a parashah or a chapter proposes the whole of it, which is the
    // commonest thing to want and a sane starting point for narrowing.
    let from, to;
    if (parashiyot) {
      const p = parashiyot[+scope.value] || parashiyot[0];
      from = p.start; to = p.end;
    } else {
      const c = +scope.value || 1;
      from = [c, 1]; to = [c, chapters[c - 1]];
    }
    fillNumberSelect($('crFromC'), chapters.length, from[0]);
    fillNumberSelect($('crFromV'), chapters[from[0] - 1], from[1]);
    fillNumberSelect($('crToC'), chapters.length, to[0]);
    fillNumberSelect($('crToV'), chapters[to[0] - 1], to[1]);
  } else {
    // The verse lists depend on which chapter each end sits in.
    const fc = fillNumberSelect($('crFromC'), chapters.length, +$('crFromC').value);
    fillNumberSelect($('crFromV'), chapters[fc - 1], +$('crFromV').value);
    const tc = fillNumberSelect($('crToC'), chapters.length, +$('crToC').value);
    fillNumberSelect($('crToV'), chapters[tc - 1], +$('crToV').value);
    // Moving the start past the end drags the end along rather than refusing.
    if (changed === 'crFromC' || changed === 'crFromV') {
      const a = corpus.absIndex(chapters, fc, +$('crFromV').value);
      const b = corpus.absIndex(chapters, tc, +$('crToV').value);
      if (a > b) {
        fillNumberSelect($('crToC'), chapters.length, fc);
        fillNumberSelect($('crToV'), chapters[fc - 1], +$('crFromV').value);
      }
    }
    // Keep the scope selector pointing at wherever the start now is.
    const at = parashiyot
      ? parashiyot.indexOf(corpus.parashahAt(entry, fc, +$('crFromV').value))
      : fc - 1;
    if (at >= 0) scope.value = parashiyot ? String(at) : String(at + 1);
  }
  updateCustomPreview();
}

function pickerRange() {
  const entry = pickerBook();
  if (!entry) return null;
  const from = [+$('crFromC').value, +$('crFromV').value];
  const to = [+$('crToC').value, +$('crToV').value];
  return { entry, ...corpus.normalizeRange(entry, from, to) };
}

function updateCustomPreview() {
  const r = pickerRange();
  const box = $('crPreview');
  const status = $('crStatus');
  const open = $('crOpen');
  if (!r) { box.textContent = ''; return; }
  const ref = corpus.refFor(r.entry.en, r.from, r.to);
  const heRef = corpus.heRefFor(r.entry.he, r.from, r.to);
  box.innerHTML = `<b>${escapeHtml(ref)}</b> <span class="cr-he">${escapeHtml(heRef)}</span>`
    + `<span class="hint"> · ${plural(r.count, 'pasuk', 'pesukim')}</span>`;
  const tooLong = r.count > corpus.MAX_VERSES;
  open.disabled = tooLong;
  status.textContent = tooLong
    ? `Too long to practice as one passage — ${corpus.MAX_VERSES} pesukim at most.`
    : (r.entry.accents === 'poetic' ? POETIC_NOTE : '');
  // A passage that already has a name shows it, so Save doubles as Rename.
  const saved = savedNameFor(r.entry.slug, r.from, r.to);
  if (saved || _crNameIsSaved) { $('crName').value = saved; _crNameIsSaved = true; }
  $('crSave').textContent = saved ? 'Rename' : 'Save';
}

// Name the selected passage without opening it, so a reader setting themselves up
// can put several in the menu in one visit.
function saveFromPicker() {
  const r = pickerRange();
  if (!r) return;
  const status = $('crStatus');
  const typed = $('crName').value.trim();
  if (!typed) {
    status.textContent = 'Give the passage a name and it will keep it in the Reading menu.';
    $('crName').focus();
    return;
  }
  const name = saveCustomPassage({ book: r.entry.slug, from: r.from, to: r.to }, typed);
  _crNameIsSaved = true;
  afterCustomListChange();
  status.textContent = `Saved as \u201c${name}\u201d \u2014 it\u2019s in the Reading menu under that name.`;
}

// Both chip rows, the menu and the preview, after the saved or recent list moves.
// Nothing here loads text: a passage costs nothing until it is opened.
function afterCustomListChange() {
  syncCustomMenu();
  renderSavedPassages();
  renderCustomRecents();
  updateCustomPreview();
}

// The reader's named passages, above the recents: the fast way back to the one
// they are actually preparing.
function renderSavedPassages() {
  const box = $('crSaved');
  if (!box) return;
  const list = corpus.indexIfLoaded() ? loadSavedPassages() : [];
  const chips = list.map((p) => {
    const entry = corpus.bookEntry(p.book);
    if (!entry) return '';
    const ref = corpus.refFor(entry.en, p.from, p.to);
    return `<span class="cr-named">${chipHtml(p, `${escapeHtml(p.name)} <small>${escapeHtml(ref)}</small>`)}`
      + `<button class="cr-forget" data-id="${escapeHtml(passageId(p))}"`
      + ' title="Forget the name. Keeps the passage and everything practiced in it.">\u2715</button></span>';
  }).filter(Boolean).join('');
  if (!chips) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<span class="label">Saved</span>${chips}`;
  bindChips(box);
  box.querySelectorAll('.cr-forget').forEach((b) => {
    b.addEventListener('click', () => {
      forgetCustomPassage(b.dataset.id);
      afterCustomListChange();
      $('crStatus').textContent = 'Forgot the name \u2014 the passage and its progress are still here.';
    });
  });
}

function renderCustomRecents() {
  const box = $('crRecent');
  if (!box) return;
  const idx = corpus.indexIfLoaded();
  // A named passage is in the Saved row above; don't list it twice.
  const named = new Set(loadSavedPassages().map(passageId));
  const list = idx ? loadCustomRecents().filter((r) => !named.has(passageId(r))) : [];
  const chips = list.map((r) => {
    const entry = corpus.bookEntry(r.book);
    return entry ? chipHtml(r, escapeHtml(corpus.refFor(entry.en, r.from, r.to))) : '';
  }).filter(Boolean).join('');
  if (!chips) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<span class="label">Recent</span>${chips}`;
  bindChips(box);
}

function chipHtml(desc, inner) {
  return `<button class="cr-chip" data-book="${escapeHtml(desc.book)}"`
    + ` data-from="${desc.from.join('.')}" data-to="${desc.to.join('.')}">${inner}</button>`;
}

function bindChips(box) {
  box.querySelectorAll('.cr-chip').forEach((b) => {
    b.addEventListener('click', () => {
      const from = b.dataset.from.split('.').map(Number);
      const to = b.dataset.to.split('.').map(Number);
      openPassageFromPicker(b.dataset.book, from, to);
    });
  });
}

function submitCustomPicker() {
  const r = pickerRange();
  if (!r) return;
  // A name typed and then Open pressed means both, rather than losing the name.
  openPassageFromPicker(r.entry.slug, r.from, r.to, $('crName').value.trim());
}

async function openPassageFromPicker(bookSlug, from, to, name = '') {
  const status = $('crStatus');
  const open = $('crOpen');
  open.disabled = true;
  status.textContent = 'Loading the text\u2026';
  try {
    await openCustomRange(bookSlug, from, to, { name });
    _crNameIsSaved = true;
    $('customModal').hidden = true;
    status.textContent = '';
  } catch (e) {
    status.textContent = `Couldn\u2019t open that passage: ${e.message}`;
  } finally {
    open.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Offline mode. After a one-time "download", a reading's recorded chant is
// stored in IndexedDB and its text/pitch/shapes JSON is warmed in the service-
// worker cache, so the reading works with no network and no recurring data use.
// ---------------------------------------------------------------------------

// Unique recorded-chant MP3 paths referenced by the currently loaded reading.
function readingAudioFiles() {
  const out = new Set();
  const verses = state.audio && state.audio.verses;
  if (verses) {
    for (const k of Object.keys(verses)) {
      const f = verses[k] && verses[k].file;
      if (f) out.add(f);
    }
  }
  return Array.from(out);
}

// The reading's JSON payloads worth warming into the SW cache for offline use.
// Optional files (raw monolith, slim vs full pitch) are included best-effort;
// downloadReading swallows any that 404.
function readingDataFiles(slug) {
  const meta = AVAILABLE.find((p) => p.slug === slug);
  const files = [];
  if (meta && meta.file) files.push(meta.file);
  files.push(TIKKUN_DATA_URL);
  const sid = state.audioSource;
  files.push(
    srcPath(slug, sid, 'audio.json'),
    srcPath(slug, sid, 'pitch.slim.json'),
    srcPath(slug, sid, 'pitch.json'),
    srcPath(slug, sid, 'shapes.json'),
    srcPath(slug, sid, 'pitch.raw.json')
  );
  return files;
}

let _offlineBusy = false;

async function refreshOfflineButton() {
  const btn = $('btnOffline');
  if (!btn) return;
  if (!offline.offlineSupported()) { btn.hidden = true; return; }
  const files = readingAudioFiles();
  if (!files.length) { btn.hidden = true; return; } // no recorded chant for this reading
  btn.hidden = false;
  if (_offlineBusy) return;
  const st = await offline.readingStatus(files);
  btn.dataset.slug = state.slug;
  if (st.complete) {
    btn.textContent = '✓ Offline';
    btn.classList.add('on');
    btn.title = 'This reading is downloaded — its chant plays with no network. Click to remove the download and free space.';
  } else {
    const est = await offline.estimateReadingSize(files);
    const size = est.known && est.bytes ? ` (${offline.formatBytes(est.bytes)})` : '';
    btn.textContent = st.cached > 0 ? `⬇ Offline (${st.cached}/${st.total})` : `⬇ Offline${size}`;
    btn.classList.remove('on');
    btn.title = 'Download this reading\u2019s audio so it plays with no network (minimal data after the first download).';
  }
}

function setupOfflineButton() {
  const btn = $('btnOffline');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (_offlineBusy) return;
    const files = readingAudioFiles();
    if (!files.length) return;
    const slug = state.slug;
    const st = await offline.readingStatus(files);
    if (st.complete) {
      // Toggle off: remove the download to free space.
      _offlineBusy = true;
      btn.classList.add('working');
      btn.textContent = 'Removing…';
      try { await offline.removeReading(files); } catch (e) { /* ignore */ }
      _offlineBusy = false;
      btn.classList.remove('working');
      refreshOfflineButton();
      return;
    }
    // Download.
    _offlineBusy = true;
    btn.classList.add('working');
    btn.disabled = false;
    const spec = { audioFiles: files, dataFiles: readingDataFiles(slug) };
    try {
      await offline.downloadReading(spec, (p) => {
        if (state.slug !== slug) return;
        const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
        btn.textContent = `Downloading… ${pct}%`;
      });
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 900);
    } catch (e) {
      btn.textContent = '⚠ Retry download';
      btn.title = 'Download failed (are you offline?). Click to try again.';
      _offlineBusy = false;
      btn.classList.remove('working');
      return;
    }
    _offlineBusy = false;
    btn.classList.remove('working');
    refreshOfflineButton();
  });
}

// A small online/offline badge; also flips a body class so other UI (e.g. auth)
// can react. Sefaria word lookup already degrades gracefully when offline.
function setupNetBadge() {
  const badge = $('netBadge');
  if (!badge) return;
  const update = () => {
    const online = navigator.onLine;
    document.body.classList.toggle('is-offline', !online);
    badge.hidden = online;              // only show the badge when offline
    badge.textContent = '⚡ Offline';
    badge.title = online ? 'Online' : 'You are offline — downloaded readings still work.';
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

// Phase 3, slim pitch. `_pitchShards` is the manifest's verse set while this
// reading is being served a pasuk at a time, and null once the whole-reading
// monolith is resident (either because no shards are deployed or because a
// multi-verse view pulled it in) — so it doubles as "are shards still in play".
// `_pitchRequested` stops a re-render asking for the same shard twice. All three
// are reset per source in loadAudioSource.
let _pitchShards = null;
let _pitchRequested = new Set();
let _pitchMonolithPromise = null;

// The per-verse manifest: which pesukim of this reading have extracted pitch.
// A few hundred bytes, which is why it can be awaited before the first render.
async function loadPitchIndex(slug, sid) {
  try {
    const r = await fetch(pitchIndexPath(slug, sid));
    if (!r.ok) return null;
    const doc = await r.json();
    return doc && Array.isArray(doc.verses) && doc.verses.length ? doc : null;
  } catch (e) { return null; } // no shards deployed for this reading
}

// The whole-reading pitch payload. Prefer the slim variant (no heavy per-frame
// `raw` arrays ≈ 40% smaller); fall back to the original monolith if the slim
// file hasn't been generated yet.
async function loadPitchMonolith(slug, sid) {
  try {
    let pr = await fetch(srcPath(slug, sid, 'pitch.slim.json'));
    if (!pr.ok) pr = await fetch(srcPath(slug, sid, 'pitch.json'));
    if (!pr.ok) return null;
    return await pr.json();
  } catch (e) { return null; } // no extracted pitch available
}

// Fold a whole-reading payload into the resident pitch map WITHOUT clobbering
// verses that arrived as shards: those may already carry `raw` contours merged
// in by ensureRawForVerse, which the slim monolith has none of.
function mergePitchDoc(pitch, doc) {
  if (!pitch || !pitch.verses || !doc || !doc.verses) return;
  for (const k of Object.keys(doc)) {
    if (k !== 'verses' && pitch[k] === undefined) pitch[k] = doc[k];
  }
  for (const k of Object.keys(doc.verses)) {
    if (!pitch.verses[k]) pitch.verses[k] = doc.verses[k];
  }
}

// An aliyah or a chain needs every pasuk of its span at once, so it takes the
// one monolith rather than a shard per verse — the same trade-off, for the same
// reason, as loadRawContoursDeferred. Memoized as a promise rather than a flag
// so a second caller waits for the payload instead of running on ahead of it.
function ensurePitchMonolith(slug) {
  if (!_pitchShards) return Promise.resolve();
  if (!_pitchMonolithPromise) {
    const sid = state.audioSource;
    _pitchMonolithPromise = (async () => {
      const doc = await loadPitchMonolith(slug, sid);
      // Reading OR voice changed meanwhile: this payload is the wrong cantor's.
      if (!doc || state.slug !== slug || state.audioSource !== sid || !state.pitch) return;
      mergePitchDoc(state.pitch, doc);
      _pitchShards = null; // every pasuk is resident; no shard can add anything now
    })();
  }
  return _pitchMonolithPromise;
}

// Fetch just ONE pasuk's slim shard (a few KB) for single-verse practice, then
// redraw so its coach line, spectrogram window and word timings appear. The pane
// is never held back waiting for this: a verse with no extracted pitch already
// renders a bare timeline (see buildCoach), and that is exactly what the first
// paint shows for the moment before the shard lands.
//
// `warm` means nobody has opened this pasuk (see warmPitchShards), so the shard
// is banked on its own: no `raw` underlay, which is five times the bytes of the
// shard itself and shows nothing until the pasuk is on screen. renderPractice
// fetches it if the reader does open the pasuk.
async function ensurePitchForVerse(n, warm) {
  if (n == null || !_pitchShards || !state.pitch) return;
  if (!_pitchShards.has(n)) return; // this pasuk was never recorded / extracted
  const key = `${state.slug}:${n}`;
  if (_pitchRequested.has(key)) return;
  if (state.pitch.verses[String(n)]) return;
  _pitchRequested.add(key);
  const slug = state.slug;
  const sid = state.audioSource;
  try {
    const r = await fetch(pitchShardPath(slug, sid, n));
    if (r.ok) {
      const verse = await r.json();
      // Reading OR voice changed meanwhile: this pasuk is a different cantor's.
      if (state.slug !== slug || state.audioSource !== sid || !state.pitch) return;
      state.pitch.verses[String(n)] = verse;
      if (!warm) ensureRawForVerse(n); // the underlay can only merge into a resident verse
      // Redraws the pasuk in view and nothing else, so a warm landing behind the
      // reader's back leaves the screen alone — while a warm they have opened in
      // the meantime still upgrades the pane it is sitting in.
      refreshUnderlayFor(n);
      return;
    }
  } catch (e) { /* fall through to the monolith */ }
  // A background warm that misses stays quiet rather than escalating a whole
  // monolith nobody asked for; it just leaves the pasuk eligible to be loaded
  // for real, which is where the monolith fallback belongs.
  if (warm) { _pitchRequested.delete(key); return; }
  ensurePitchMonolith(slug); // shard missing → one payload for the whole reading
}

// Bank the shards for a short run of pesukim the reader has not opened: the top
// of a section they just expanded, and the reading's opening pesukim at idle. A
// tap on one of them then already has its coach line in hand, and nothing on
// screen moves in the meantime. Deliberately bounded — warming a whole aliyah
// would cost more requests, and more bytes, than the monolith.
const PITCH_WARM = 3;
function warmPitchShards(from, count = PITCH_WARM) {
  for (let n = from; n < from + count; n++) ensurePitchForVerse(n, true);
}

// Opening a multi-verse view: bring in the whole-reading pitch first and only
// then its `raw` underlay, because mergeRawContours can fill contours into
// resident verses only — and it runs once per reading, so a raw monolith that
// arrived while the verse map was still empty would be silently thrown away.
async function ensureAliyahPitch(slug) {
  const wasSharded = !!_pitchShards;
  if (wasSharded) await ensurePitchMonolith(slug);
  if (state.slug !== slug) return; // reading changed meanwhile
  loadRawContoursDeferred(slug);
  // Redraw only on the one transition from shards to a full map. The redraw
  // re-enters here, and this is what stops that from looping.
  if (!wasSharded || _pitchShards) return;
  if (window.__cantillateBusy || state.playingReal) return;
  if (state.aliyah) renderAliyahView();
}

// Verses whose `raw` underlay has been loaded (or attempted), so we never
// re-fetch. Reset per reading in loadData.
let _rawLoaded = new Set();
let _rawMonolithTried = false;

// Does a verse already carry per-frame `raw` data (from a shard, the monolith,
// or the original pitch file)?
function verseHasRaw(pv) {
  return pv && pv.words && pv.words.some((w) => Array.isArray(w.raw) && w.raw.length);
}

// Merge an array of { i, raw } word entries into a resident verse object.
function mergeRawWords(pv, words) {
  if (!pv || !pv.words || !Array.isArray(words)) return;
  const byI = {};
  words.forEach((w) => { byI[w.i] = w.raw; });
  pv.words.forEach((w) => { if (byI[w.i] != null) w.raw = byI[w.i]; });
}

// Phase 2: fetch just ONE verse's `raw` contour shard on demand (a few KB), for
// single-pasuk practice. Falls back to the whole-reading raw monolith if the
// shard isn't deployed. Re-renders the open view once, unless busy.
async function ensureRawForVerse(n) {
  if (n == null || !state.pitch || !state.pitch.verses) return;
  const key = `${state.slug}:${n}`;
  if (_rawLoaded.has(key)) return;
  const pv = state.pitch.verses[String(n)];
  if (!pv) return;
  if (verseHasRaw(pv)) { _rawLoaded.add(key); return; }
  _rawLoaded.add(key);
  const slug = state.slug;
  try {
    const rr = await fetch(rawShardPath(slug, state.audioSource, n));
    if (rr.ok) {
      const words = await rr.json();
      if (state.slug !== slug) return;
      mergeRawWords(state.pitch.verses[String(n)], words);
      refreshUnderlayFor(n);
      return;
    }
  } catch (e) { /* fall through to monolith */ }
  loadRawContoursDeferred(slug); // shard missing → try the monolith once
}

// Load the whole-reading `raw` monolith (used when an aliyah spanning many verses
// is opened, or as a fallback when per-verse shards aren't deployed). Merges and
// refreshes an open view unless a recording/playback is in progress.
async function loadRawContoursDeferred(slug) {
  if (_rawMonolithTried && slug === state.slug) return;
  _rawMonolithTried = true;
  try {
    const rr = await fetch(srcPath(slug, state.audioSource, 'pitch.raw.json'));
    if (!rr.ok) return;
    const raw = await rr.json();
    if (state.slug !== slug || !state.pitch) return; // reading changed meanwhile
    mergeRawContours(state.pitch, raw);
    if (window.__cantillateBusy || state.playingReal) return;
    if (state.aliyah) renderAliyahView();
    else if (state.selectedVerse != null) renderPractice();
  } catch (e) { /* underlay is optional */ }
}

function refreshUnderlayFor(n) {
  if (window.__cantillateBusy || state.playingReal) return;
  if (state.aliyah) { if (aliyahVerses(state.aliyah).some((v) => v === n)) renderAliyahView(); }
  else if (state.selectedVerse === n) renderPractice();
}

function mergeRawContours(pitch, raw) {
  if (!pitch || !pitch.verses || !raw || !raw.verses) return;
  for (const vn of Object.keys(raw.verses)) {
    const pv = pitch.verses[vn];
    const rv = raw.verses[vn];
    if (!pv || !pv.words || !rv || !rv.words) continue;
    mergeRawWords(pv, rv.words);
  }
}

function verseAudio(verseN) {
  return state.audio && state.audio.verses && state.audio.verses[String(verseN)];
}

// Tell the transport which stretches of this voice's files are not the reading.
// A recording made by a person has false starts and asides in it; whoever
// labelled it cut them out (scripts/label.html), leaving words that stop before
// the next one begins. Collected per file, because that is what plays.
function registerAudioCuts(doc) {
  const byFile = new Map();
  for (const v of Object.values((doc && doc.verses) || {})) {
    if (v && v.file) byFile.set(v.file, (byFile.get(v.file) || []).concat([v]));
  }
  for (const [file, verses] of byFile) {
    const list = [];
    for (const v of verses) {
      (v.ends || []).forEach((end, k) => {
        const next = k + 1 < v.onsets.length ? v.onsets[k + 1] : null;
        if (end != null && next != null && next - end > 0.01) list.push([end, next]);
      });
    }
    // A fumbled first word of a verse needs nothing here: the verse before it
    // already stops early and this one already starts late, and playback always
    // begins at a verse or a word, never in the seam between them.
    setAudioCuts(file, list);
  }
}

function pitchVerse(verseN) {
  return state.pitch && state.pitch.verses && state.pitch.verses[String(verseN)];
}

// Build the coach line (note steps derived from the recording) for a set of
// unit segments, laid out on a shared time window (the exact recorded times), so
// it aligns with the time-aligned spectrogram and the stretched word overlay.
function buildCoach(unitSegs, verseN = state.selectedVerse) {
  const pv = pitchVerse(verseN);
  // A drill line has no recording to derive steps from, so its coach is
  // synthesized from the trope motifs — which is exactly what it teaches. A real
  // reading with audio but no extracted pitch still gets no coach line, because a
  // synthetic one wouldn't line up with the cantor.
  if (!pv) return verseAudio(verseN) ? null : buildSyntheticCoach(unitSegs);
  const words = unitSegs
    .map((seg) => ({ seg, pw: pv.words.find((w) => w.i === seg.index) }))
    .filter((x) => x.pw && x.pw.start != null);
  if (!words.length) return null;
  const start = words[0].pw.start;
  const end = words[words.length - 1].pw.end;
  const dur = (end - start) || 1;
  const steps = [], raw = [], wordBounds = [], overlayWords = [], points = [];
  words.forEach(({ seg, pw }, wi) => {
    const w0 = (pw.start - start) / dur;
    const wdur = (pw.end - pw.start) / dur;
    wordBounds.push(w0);
    (pw.steps || []).forEach((s) => {
      const st = { t0: w0 + s.t0 * wdur, t1: w0 + s.t1 * wdur, p: s.p, color: seg.color, connector: seg.isConnector, w: wi };
      steps.push(st);
      points.push({ t: st.t0, p: st.p });
      points.push({ t: st.t1, p: st.p });
    });
    (pw.raw || []).forEach((r) => raw.push({ t: w0 + r.t * wdur, p: r.p }));
    overlayWords.push({ seg, t0: w0, t1: w0 + wdur, steps: pw.steps || [] });
  });
  return { start, end, dur, steps, raw, wordBounds, overlayWords, points, tonicHz: pv.tonicHz };
}

// How an accent is actually sung, measured across every recorded reading
// (data/trope-shapes.json). A drill has no recording of its own, so without this
// its coach line would be trope.js's hand-drawn sketch — and the reader would be
// taught a melody the cantor never sings. Loaded for drills in loadData.
function measuredShapeFor(seg) {
  const key = (seg.isSofPasuk || seg.taam === 'sof') ? 'sof'
    : (seg.taam == null ? 'none' : String(seg.taam));
  const sh = state.shapes && state.shapes[key];
  return sh && sh.steps && sh.steps.length ? sh : null;
}

// Turn one accent's motif — a handful of { t, p } control points — into the same
// staircase of held note steps that the pitch extractor produces from a
// recording, so a drill line drives the identical coach line, voice guide,
// spectrogram and scoring as a real pasuk does.
const SYNTH_SEC_PER_SYLLABLE = 0.5;
function motifSteps(contour) {
  const pts = (contour && contour.length ? contour : [{ t: 0, p: 0 }]);
  // Each control point is held until the next one; the last takes the remainder,
  // widened so a motif whose final point sits at t=1 still sounds.
  const widths = pts.map((pt, i) => (i + 1 < pts.length ? pts[i + 1].t - pt.t : Math.max(1 - pt.t, 1 / pts.length)));
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return pts.map((pt, i) => {
    const t0 = acc / total;
    acc += widths[i];
    return { t0, t1: acc / total, p: pt.p };
  });
}

// Lay a set of segments out on a timeline of their own. Each word is sung with
// the accent's MEASURED shape and MEASURED duration where the corpus has one
// (so a Shalshelet takes its real six and a half seconds, not a nominal two),
// falling back to the stylized motif for anything never recorded. `durOf` lets a
// caller override the timing — the spliced recitation uses the real length of the
// word actually being played.
function buildSyntheticCoach(unitSegs, durOf) {
  if (!unitSegs || !unitSegs.length) return null;
  const shapes = unitSegs.map(measuredShapeFor);
  const durs = unitSegs.map((seg, i) => (durOf && durOf(i))
    || (shapes[i] && shapes[i].dur)
    || Math.max(0.6, (seg.syllables || 1) * SYNTH_SEC_PER_SYLLABLE));
  const dur = durs.reduce((a, b) => a + b, 0);
  const steps = [], wordBounds = [], overlayWords = [], points = [];
  let acc = 0;
  unitSegs.forEach((seg, wi) => {
    const w0 = acc / dur;
    const wdur = durs[wi] / dur;
    acc += durs[wi];
    wordBounds.push(w0);
    const base = shapes[wi] ? shapes[wi].steps : motifSteps(seg.contour);
    const ws = base.map((s) => ({
      t0: w0 + s.t0 * wdur, t1: w0 + s.t1 * wdur, p: s.p,
      color: seg.color, connector: seg.isConnector, w: wi,
    }));
    ws.forEach((s) => { steps.push(s); points.push({ t: s.t0, p: s.p }, { t: s.t1, p: s.p }); });
    overlayWords.push({ seg, t0: w0, t1: w0 + wdur, steps: ws });
  });
  return { start: 0, end: dur, dur, steps, raw: [], wordBounds, overlayWords, points,
    tonicHz: state.tonicHz, synthetic: true, measured: shapes.some(Boolean) };
}

// The range of verses to show, derived from the current portion. Annual shows
// the whole parashah; a triennial year shows only that year's span. We use the
// year's actual aliyot (first start .. last end) so the verses on screen match
// exactly what you practice that year, falling back to even thirds only if a
// reading has no triennial aliyot data.
function divisionRange() {
  const n = state.data.verses.length;
  // An excerpt is a fixed passage carved out of its parent reading, so the range
  // is simply the verses it names.
  const ex = state.excerpt && state.excerpt.range;
  if (ex) return [Math.max(1, ex[0]), Math.min(n, ex[1])];
  if (state.cycle !== 'triennial') return [1, n];
  const list = aliyotForReading('triennial', state.triYear);
  if (list && list.length) {
    let start = Infinity, end = 0;
    list.forEach((a) => { start = Math.min(start, a.start); end = Math.max(end, a.end); });
    return [Math.max(1, start), Math.min(n, end)];
  }
  const third = Math.ceil(n / 3);
  const start = (state.triYear - 1) * third + 1;
  return [start, Math.min(n, state.triYear * third)];
}

function refreshText() {
  renderVerses();
  if (state.selectedVerse != null) renderPractice();
  applyHighlight();
}

function scoreColor(score) {
  // 0 -> red, 50 -> amber, 100 -> green
  const s = Math.max(0, Math.min(100, score)) / 100;
  const hue = s * 120; // 0=red .. 120=green
  return `hsla(${hue}, 65%, 45%, ${0.18 + s * 0.22})`;
}

// Vivid, fully-opaque variant for the verse section bar (spatial accuracy map).
function scoreColorSolid(score) {
  const s = Math.max(0, Math.min(100, score)) / 100;
  const hue = s * 120;
  return `hsl(${hue}, 70%, ${38 + s * 10}%)`;
}

// Adaptive red->green ramp: a score is colored by its position within a supplied
// [lo,hi] window rather than the absolute 0..100 scale. Because real scores
// cluster near the top, a fixed scale makes everything look the same green;
// stretching the ramp to the actual spread gives maximum contrast (weakest =
// red, strongest = green) so you can instantly see which parts to improve.
function rampColor(score, lo, hi, solid = false) {
  const span = Math.max(1, hi - lo);
  const c = Math.max(0, Math.min(1, (score - lo) / span));
  const hue = c * 120; // 0=red .. 120=green
  return solid
    ? `hsl(${hue}, 82%, ${44 + c * 8}%)`
    : `hsla(${hue}, 78%, 50%, ${0.28 + c * 0.42})`;
}

// The [lo,hi] window for the adaptive ramp: the min/max of the practiced scores,
// widened to a minimum span so a cluster of near-equal scores isn't blown up
// into a full red->green swing (and a lone score stays neutral).
function adaptiveRange(scores, minSpan = 16) {
  const v = scores.filter((s) => s > 0);
  if (!v.length) return [0, 100];
  let lo = Math.min(...v), hi = Math.max(...v);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  return [lo, hi];
}

// --- Left pesukim list: collapsible aliyah sections -------------------------
// The list is grouped into the reading's seven aliyot (plus any pesukim that fall
// outside them), each an accordion that opens to reveal its verses. Collapsed,
// the whole parashah is seven rows you can see at once; expanded, one aliyah's
// pesukim are in front of you without the rest of the reading pushing them off
// screen.

const ALIYOT_OPEN_KEY = 'cantillate.openAliyot';

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

function sectionKey(a) {
  return `${state.readingId}:${cycleKeyFor(state.cycle, state.triYear)}:${a ? a.n : 'free'}`;
}

// Drills and excerpts group their pesukim by their own named lessons/passages
// rather than by aliyot, so the accordion works the same for a trope drill set as
// it does for a parashah.
function readingGroups() {
  const meta = state.drill || state.excerpt;
  const list = meta && Array.isArray(meta.groups) ? meta.groups : null;
  if (list) return list;
  return state.data && Array.isArray(state.data.groups) ? state.data.groups : null;
}

function loadOpenSections() {
  try {
    const raw = JSON.parse(localStorage.getItem(ALIYOT_OPEN_KEY));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (e) { return new Set(); }
}

function saveOpenSections() {
  try { localStorage.setItem(ALIYOT_OPEN_KEY, JSON.stringify([...state.openAliyot])); }
  catch (e) { /* private mode: sections just won't be remembered */ }
}

function openSections() {
  if (!state.openAliyot) state.openAliyot = loadOpenSections();
  return state.openAliyot;
}

function toggleSection(key) {
  const open = openSections();
  if (open.has(key)) open.delete(key); else open.add(key);
  saveOpenSections();
  renderVerses();
}

// Cut the visible verse range into aliyah sections, with any pesukim that fall
// between (or outside) the aliyot kept as their own untitled group so no verse
// can disappear from the list.
function verseSections(start, end) {
  const groups = readingGroups();
  const source = groups
    ? groups.map((g, i) => ({ n: g.id || i + 1, title: g.title, note: g.note, ref: g.ref || '', start: g.start, end: g.end, plain: true }))
    : aliyotForReading(state.cycle, state.triYear);
  const list = source
    .map((a) => ({ ...a, start: Math.max(a.start, start), end: Math.min(a.end, end) }))
    .filter((a) => a.end >= a.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = start;
  for (const a of list) {
    if (a.start > cursor) out.push({ aliyah: null, start: cursor, end: a.start - 1 });
    out.push({ aliyah: a, start: a.start, end: a.end });
    cursor = a.end + 1;
  }
  if (cursor <= end) out.push({ aliyah: null, start: cursor, end });
  return out;
}

function renderVerses() {
  // The pointed per-verse list always renders here; the STA"M Torah column is a
  // separate, optional pane (renderScrollPane) shown alongside it in scroll view.
  renderScrollPane();
  const box = $('verses');
  box.innerHTML = '';
  const [start, end] = divisionRange();
  // The maftir repeats an aliyah's closing pesukim rather than owning its own
  // span, so it stays a card pinned inside whichever section ends where it does.
  const maxV = state.data.verses.length;
  const maftir = maftirForReading(state.cycle, state.triYear);
  const open = openSections();
  const sections = verseSections(start, end);
  // Always show the section holding the selected verse, even if it was collapsed
  // — otherwise selecting a verse from elsewhere would hide it.
  const active = sections.find((s) => state.selectedVerse != null
    && state.selectedVerse >= s.start && state.selectedVerse <= s.end);

  for (const sec of sections) {
    const key = sectionKey(sec.aliyah);
    const isOpen = open.has(key) || sec === active || sections.length === 1;
    box.appendChild(buildVerseSection(sec, key, isOpen, maftir, maxV));
  }
}

// One accordion: a summary head (always visible) plus the pesukim, verse chains
// and aliyah card, which only render when the section is open.
function buildVerseSection(sec, key, isOpen, maftir, maxV) {
  const wrap = document.createElement('div');
  const a = sec.aliyah;
  wrap.className = `alsec${isOpen ? ' open' : ''}${a ? '' : ' untitled'}`;
  wrap.dataset.key = key;

  const count = sec.end - sec.start + 1;
  if (a && a.plain) {
    // A drill lesson or a named passage: a title and its pesukim, with none of the
    // aliyah machinery (no readiness gate, no chant-the-whole-thing challenge).
    const head = document.createElement('button');
    head.className = 'alsec-head';
    head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    head.innerHTML = `<span class="alsec-caret" aria-hidden="true">▸</span>
      <span class="alsec-label">${escapeHtml(a.title || '')} <span class="hint">${a.ref ? a.ref + ' · ' : ''}${plural(count, state.drill ? 'line' : 'pasuk', state.drill ? 'lines' : 'pesukim')}</span></span>`;
    head.addEventListener('click', () => toggleSection(key));
    wrap.appendChild(head);
  } else if (a) {
    const r = aliyahReadiness(a);
    const score = store.getAliyahScore(state.slug, state.cycle, state.triYear, a.n);
    const pct = r.total ? Math.round((r.ready / r.total) * 100) : 0;
    const head = document.createElement('button');
    head.className = `alsec-head${r.done ? ' ready' : ''}`;
    head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    head.innerHTML = `
      <span class="alsec-caret" aria-hidden="true">▸</span>
      <span class="al-n">${chunkBadge(a)}</span>
      <span class="alsec-label">${chunkTitle(a)} <span class="hint">${a.ref} · ${plural(count, 'pasuk', 'pesukim')}</span></span>
      ${score > 0 ? `<span class="al-score" style="background:${scoreColor(score)}">${score}</span>` : ''}
      <span class="alsec-prog" title="${r.ready}/${r.total} pesukim at the whole-verse stage"><span style="width:${pct}%;background:${r.done ? 'var(--good)' : 'var(--accent-2)'}"></span></span>`;
    head.addEventListener('click', () => toggleSection(key));
    wrap.appendChild(head);
  } else {
    const head = document.createElement('button');
    head.className = 'alsec-head';
    head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    head.innerHTML = `<span class="alsec-caret" aria-hidden="true">▸</span>
      <span class="alsec-label">Pesukim <span class="hint">${rangeRef(sec.start, sec.end)} · ${count}</span></span>`;
    head.addEventListener('click', () => toggleSection(key));
    wrap.appendChild(head);
  }

  if (!isOpen) return wrap;

  // These pesukim have just been revealed, so the top of the section is the
  // likeliest next tap: warm its pitch shards while the reader looks at the list.
  warmPitchShards(sec.start);

  const body = document.createElement('div');
  body.className = 'alsec-body';
  if (a && a.note) {
    const note = document.createElement('p');
    note.className = 'hint alsec-note';
    note.textContent = a.note;
    body.appendChild(note);
  }
  for (let i = sec.start; i <= sec.end; i++) body.appendChild(buildVerseRow(i));
  if (a && !a.plain) {
    body.appendChild(buildChainStrip(a));
    body.appendChild(buildAliyahCard(a));
    if (maftir && Math.min(maftir.end, maxV) >= sec.start && Math.min(maftir.end, maxV) <= sec.end) {
      body.appendChild(buildAliyahCard(maftir));
    }
  }
  wrap.appendChild(body);
  return wrap;
}

function buildVerseRow(i) {
  const v = state.data.verses[i - 1];
  const div = document.createElement('div');
  div.className = 'verse' + (state.selectedVerse === i ? ' active' : '');
  div.dataset.v = i;
  // No single summed verse score: show the base full-verse accuracy as the
  // badge, with a pip per earned handicap skill (each its own score).
  const modeScores = store.getVerseModeScores(state.slug, i);
  const base = modeScores.base || 0;
  const segs = verseSegments(i);
  // Per-token overlay score, chosen by the current overlay mode, so the left
  // column can show word / phrase / whole-verse skill on the text itself.
  const ov = overlayScorer(i, segs);
  const heHtml = segs
    .map((s, wi) => wordSpan(s.token, s, state, wi, ov.score(wi), ov.lo, ov.hi))
    .join(' ');
  const pips = VERSE_MODES.filter((m) => m.key !== 'base').map((m) => {
    const sc = modeScores[m.key] || 0;
    return sc > 0 ? `<span class="vpip" style="background:${scoreColor(sc)}" title="${m.label}: ${sc}"></span>` : '';
  }).join('');
  const badge = (base > 0 || pips)
    ? `<span class="vscore-wrap">${base > 0 ? `<span class="vscore" style="background:${scoreColor(base)};color:#fff" title="Full-verse accuracy">${base}</span>` : ''}${pips ? `<span class="vpips">${pips}</span>` : ''}</span>`
    : '';
  const enHtml = state.showEnglish && v.en
    ? `<div class="ventext">${escapeHtml(v.en)}</div>` : '';
  div.innerHTML = `<span class="vnum">${state.data.book.he} ${verseRefLabel(v, i)}${verseIndexSuffix(v, i)}</span>${badge}
    <div class="vbody${state.showEnglish ? ' bilingual' : ''}">${enHtml}<div class="hebrew ${state.scroll ? 'scroll' : ''}">${heHtml}</div></div>`;
  // Clicking a single word jumps to word practice for that word; clicking
  // elsewhere in the verse just selects the verse.
  div.addEventListener('click', (e) => {
    const wEl = e.target.closest('.w');
    if (wEl && wEl.dataset.wi != null) practiceWord(i, parseInt(wEl.dataset.wi, 10));
    else selectVerse(i);
  });
  return div;
}

// Build the per-token score accessor for the current left-column overlay mode:
//  - word:   each word tinted by its own best accuracy
//  - phrase: each word tinted by the score of the phrase it belongs to
//  - verse:  every word tinted by the verse's base full-verse accuracy
// so you can see skill at the composite parts, not just single words.
function overlayScorer(verseN, segs) {
  const mode = state.overlay;
  if (mode === 'word') {
    const ws = store.getWordScores(state.slug, verseN);
    const [lo, hi] = adaptiveRange(Object.values(ws));
    return { score: (wi) => ws[wi], lo, hi };
  }
  if (mode === 'phrase') {
    const ps = store.getPhraseScores(state.slug, verseN);
    const [lo, hi] = adaptiveRange(Object.values(ps));
    const tok2ph = {};
    splitPhrases(segs).forEach((ph, pi) => ph.forEach((s) => { tok2ph[s.index] = pi; }));
    return { score: (wi) => ps[tok2ph[wi]], lo, hi };
  }
  if (mode === 'verse') {
    // Tint each word by the per-word good/bad shape of your best full-verse runs
    // — the same gradient used for the whole-verse bar — falling back to a flat
    // best whole-verse score if no full-verse take has been recorded yet.
    const profile = bestVerseProfile(verseN);
    if (profile) {
      const [lo, hi] = adaptiveRange(Object.values(profile));
      return { score: (wi) => profile[wi], lo, hi };
    }
    const best = bestVerseScore(verseN);
    return { score: () => (best > 0 ? best : undefined), lo: 0, hi: 100 };
  }
  return { score: () => undefined, lo: 0, hi: 100 };
}

// Jump straight into single-word practice for the clicked word: select its verse,
// drop to a word stage, and open the maqaf-group unit that contains it.
function practiceWord(verseN, wi) {
  state.selectedVerse = verseN;
  const unlocked = store.getVerseLevel(state.slug, verseN);
  state.level = unlocked >= 2 ? 2 : 1; // prefer "sing the word", else "listen & repeat"
  const segs = verseSegments(verseN);
  const groups = groupByMaqaf(segs);
  const idx = groups.findIndex((g) => g.some((s) => s.index === wi));
  gotoPractice(verseN, state.level, idx < 0 ? 0 : idx);
}

// Jump into phrase practice (stage 3) for the clicked phrase.
function practicePhrase(verseN, pi) {
  gotoPractice(verseN, 3, pi);
}

// Jump into whole-verse practice: stay on the current line stage if already on
// one, else the base full-verse stage (4).
function practiceVerse(verseN) {
  const cur = levelById(state.level);
  gotoPractice(verseN, cur.unit === 'line' ? cur.id : FULL_VERSE_LEVEL, 0);
}

// Jump to a specific stage (e.g. a handicap skill badge).
function practiceStage(verseN, levelId) {
  gotoPractice(verseN, levelId, 0);
}

function gotoPractice(verseN, levelId, unitIndex) {
  state.selectedVerse = verseN;
  state.level = levelId;
  state.unitIndex = unitIndex;
  state.divideRank = null;
  closePasukDrawer();
  renderVerses();
  renderStageBar();
  renderPractice();
}

// Delegated click handling for the accuracy panel: text words and bar segments
// (and skill badges) jump into the matching practice.
function wireAccPanel() {
  const el = $('accPanel');
  if (!el) return;
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-kind]');
    if (!t) return;
    const v = state.selectedVerse;
    if (v == null) return;
    switch (t.dataset.kind) {
      case 'word': practiceWord(v, parseInt(t.dataset.idx, 10)); break;
      case 'phrase': practicePhrase(v, parseInt(t.dataset.idx, 10)); break;
      case 'verse': practiceVerse(v); break;
      case 'skill': practiceStage(v, parseInt(t.dataset.level, 10)); break;
    }
  });
}

function bindScrollWordSelection(box) {
  box.querySelectorAll('.sw').forEach((el) => {
    el.addEventListener('click', () => selectVerse(parseInt(el.dataset.verse, 10)));
  });
}

function scrollTikkunStartIntoView() {
  const pane = $('scrollpane');
  const box = $('scrollVerses');
  if (!pane || !box) return;
  const tracks = [...box.querySelectorAll('.scroll-track')];
  if (tracks.length) {
    tracks.forEach((track) => {
      const start = track.querySelector('.range-start');
      if (!start || !track.clientHeight) return;
      const delta = start.getBoundingClientRect().top - track.getBoundingClientRect().top;
      track.scrollTop = Math.max(0, track.scrollTop + delta - 34);
    });
  } else {
    const scroller = pane.querySelector('.pane-body') || pane;
    const start = box.querySelector('.range-start');
    if (!start || !scroller.clientHeight) return;
    const delta = start.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 48);
  }
  delete box.dataset.scrollToStart;
}

function pointedScrollWordHtml(seg, verseN, inFocus, selected, rangeStart) {
  const ctx = { showVowels: true, showTaamim: true, scroll: false };
  const mode = state.colorMode;
  const inner = mode === 'trope'
    ? renderWordTropeColored(seg.token, ctx, seg.color)
    : escapeHtml(renderWord(seg.token, ctx));
  const color = mode === 'full' ? seg.color : INK_GREY;
  const classes = ['sw', 'w'];
  if (!inFocus) classes.push('ctx');
  if (selected) classes.push('sel');
  if (rangeStart) classes.push('range-start');
  return `<span class="${classes.join(' ')}" data-verse="${verseN}" data-widx="${seg.index}"`
    + ` data-wi="${seg.index}" data-taam="${seg.taam == null ? 'none' : seg.taam}"`
    + ` data-fam="${seg.familyId}" style="color:${color}">${inner}</span>`;
}

// Word-content override for renderTikkunPages(): builds the pointed (vowels +
// cantillation, trope-coloured) counterpart of a STA"M word in place of its
// bare letters, so the pointed surface can reuse the exact same page/line
// breaks as the STA"M column instead of reflowing on its own. A context word
// that falls outside the loaded reading (unmapped verse/widx) has no pointed
// source to draw from, so it keeps the default STA"M glyph.
function pointedTikkunWordRender(word) {
  if (word.verse == null || word.widx == null) return null;
  const seg = verseSegments(word.verse)[word.widx];
  if (!seg) return null;
  const ctx = { showVowels: true, showTaamim: true, scroll: false };
  const mode = state.colorMode;
  const html = mode === 'trope'
    ? renderWordTropeColored(seg.token, ctx, seg.color)
    : escapeHtml(renderWord(seg.token, ctx));
  const color = mode === 'full' ? seg.color : INK_GREY;
  return {
    html,
    classes: ['w'],
    attrs: [
      `data-taam="${seg.taam == null ? 'none' : seg.taam}"`,
      `data-fam="${seg.familyId}"`,
      `style="color:${color}"`,
    ],
  };
}

// Paginated pointed counterpart of renderTikkunPages(): identical page and
// line breaks (a real column doesn't reflow to make room for niqqud), but with
// each word's vowelled/accented form in place of the bare STA"M letters. Falls
// back to null exactly when renderTikkunPages does (fixed page data not yet
// loaded, or the range isn't covered by it), so callers can chain their own
// naturally-wrapping fallback.
function renderPointedTikkunHtml({ focusStart, focusEnd, contextStart, contextEnd, selectedVerse, columnClass, columnId }) {
  const tikkun = renderTikkunPages(state.tikkun, state.data, {
    focusStart, focusEnd, contextStart, contextEnd, selectedVerse,
    columnClass: `pointed-tikkun${columnClass ? ` ${columnClass}` : ''}`,
    columnId,
    renderWord: pointedTikkunWordRender,
  });
  return tikkun ? tikkun.html : null;
}

// A full-reading counterpart to the STA"M column: the same verse/word mapping,
// but in the regular font with vowels, accents and trope colour. Used only as
// a fallback when the fixed tikkun page data can't lay out a paginated match
// (not loaded yet, or the range falls outside it) — it wraps naturally rather
// than trying to fake a sofer's fixed 42-line layout on its own.
function renderPointedScrollColumn({ from, to, focusStart, focusEnd, selectedVerse, id }) {
  const verses = [];
  for (let n = from; n <= to; n++) {
    const inFocus = n >= focusStart && n <= focusEnd;
    const words = verseSegments(n).map((seg) => pointedScrollWordHtml(
      seg, n, inFocus, selectedVerse === n, n === focusStart && seg.index === 0,
    )).join(' ');
    verses.push(`<span class="al-verse${inFocus ? '' : ' ctx'}" data-pointed-verse="${n}">${words}</span>`);
  }
  return `<div class="scroll-column pointed-scroll aliyah-scroll" id="${id}">${verses.join(' ')}</div>`;
}

function scrollSurfaceHtml(stamHtml, pointedHtml) {
  if (state.scrollTextMode === 'pointed') return pointedHtml;
  if (state.scrollTextMode !== 'dual') return stamHtml;
  return `<div class="scroll-dual" id="scrollDual">
    <div class="scroll-track scroll-track-stam" id="scrollStamTrack">
      <div class="scroll-track-label">STA&ldquo;M</div>${stamHtml}
    </div>
    <div class="scroll-track scroll-track-pointed" id="scrollPointedTrack">
      <div class="scroll-track-label">Vowels &amp; cantillation</div>${pointedHtml}
    </div>
  </div>`;
}

let dualScrollSyncing = false;
function nearestScrollWord(track) {
  const top = track.getBoundingClientRect().top + 30;
  let best = null;
  let distance = Infinity;
  track.querySelectorAll('.sw[data-verse][data-widx]').forEach((word) => {
    const r = word.getBoundingClientRect();
    if (r.bottom < top) return;
    const d = Math.abs(r.top - top);
    if (d < distance) { best = word; distance = d; }
  });
  return best;
}

function alignScrollTrack(source, target) {
  const anchor = nearestScrollWord(source);
  if (!anchor) return;
  const twin = target.querySelector(`.sw[data-verse="${anchor.dataset.verse}"][data-widx="${anchor.dataset.widx}"]`);
  if (!twin) return;
  const sourceOffset = anchor.getBoundingClientRect().top - source.getBoundingClientRect().top;
  const targetOffset = twin.getBoundingClientRect().top - target.getBoundingClientRect().top;
  target.scrollTop = Math.max(0, target.scrollTop + targetOffset - sourceOffset);
}

function wireDualScrollSync(box) {
  const stam = box.querySelector('#scrollStamTrack');
  const pointed = box.querySelector('#scrollPointedTrack');
  if (!stam || !pointed) return;
  const mirror = (source, target) => {
    if (!state.scrollSync || dualScrollSyncing) return;
    dualScrollSyncing = true;
    alignScrollTrack(source, target);
    requestAnimationFrame(() => { dualScrollSyncing = false; });
  };
  stam.addEventListener('scroll', () => mirror(stam, pointed), { passive: true });
  pointed.addEventListener('scroll', () => mirror(pointed, stam), { passive: true });
}

// Render explicit Davidovich tikkun pages and line boundaries. Every line is a
// fixed, non-wrapping row; resize scales the completed page as one canvas. The
// old continuous flow remains as a data-unavailable fallback.
function renderScrollPane() {
  const box = $('scrollVerses');
  if (!box) return;
  const title = document.querySelector('#scrollpane .pane-title');
  // In aliyah mode the shared STA"M pane shows the open aliyah (with surrounding
  // context) instead of the whole reading, so the scroll stays put in the same
  // window whether you're referencing a verse or chanting an aliyah.
  if (state.aliyah) { renderAliyahScroll(box); return; }
  if (title) {
    title.innerHTML = state.scrollTextMode === 'pointed'
      ? 'Full reading (vowels &amp; cantillation)'
      : state.scrollTextMode === 'dual'
        ? 'Full reading (STA&ldquo;M + pointed)'
        : 'Torah column (STA&ldquo;M)';
  }
  if (!state.scrollView) { box.innerHTML = ''; return; }
  const [start, end] = divisionRange();
  const layoutKey = `${state.slug}:${start}-${end}:${state.scrollTextMode}`;
  const previousKey = box.dataset.layoutKey;
  ensureTikkunData(); // both surfaces below want the fixed page layout
  let stamHtml = '';
  if (state.scrollTextMode !== 'pointed') {
    const tikkun = renderTikkunPages(state.tikkun, state.data, {
      focusStart: start,
      focusEnd: end,
      contextStart: start,
      contextEnd: end,
      selectedVerse: state.selectedVerse,
    });
    if (tikkun) {
      stamHtml = tikkun.html;
    } else {
      let fallback = '<div class="scroll-column">';
      for (let i = start; i <= end; i++) {
        verseSegments(i).forEach((s) => {
          const sel = state.selectedVerse === i ? ' sel' : '';
          const first = i === start && s.index === 0 ? ' range-start' : '';
          fallback += `<span class="sw${sel}${first}" data-verse="${i}" data-widx="${s.index}"`
            + ` data-taam="${s.taam == null ? 'none' : s.taam}" data-fam="${s.familyId}">`
            + `${escapeHtml(toScroll(s.token))}</span> `;
        });
      }
      stamHtml = fallback + '</div>';
    }
  }
  const pointedHtml = state.scrollTextMode === 'stam' ? '' : (renderPointedTikkunHtml({
    focusStart: start, focusEnd: end, contextStart: start, contextEnd: end,
    selectedVerse: state.selectedVerse, columnId: 'pointedScroll',
  }) || renderPointedScrollColumn({
    from: start, to: end, focusStart: start, focusEnd: end,
    selectedVerse: state.selectedVerse, id: 'pointedScroll',
  }));
  box.innerHTML = scrollSurfaceHtml(stamHtml, pointedHtml);
  box.dataset.layoutKey = layoutKey;
  if (previousKey !== layoutKey) box.dataset.scrollToStart = '1';
  bindScrollWordSelection(box);
  wireDualScrollSync(box);
  fitScrollPages();
  if (box.dataset.scrollToStart === '1') requestAnimationFrame(scrollTikkunStartIntoView);
  // Re-apply the per-word accuracy shading after any rebuild (a toolbar toggle,
  // pasuk change, etc.), so the STA"M column keeps its last take's clue.
  applyScrollWordHits();
  applyScrollOverlay();
}

// Mirror the aliyah reader's per-word "notes hit" clue onto the single-verse
// STA"M column: after a take, tint each word green (mostly hit) / amber (partial)
// / red (missed) with a colored underline. `scoreByGi` maps a verse-local word
// index to its 0..100 score. Kept in state so pane rebuilds can re-apply it.
function paintScrollWordHits(verseN, scoreByGi) {
  state._scrollWordHits = { verse: verseN, scores: scoreByGi || {} };
  applyScrollWordHits();
}
function clearScrollWordHits(box) {
  box = box || $('scrollVerses');
  if (!box) return;
  box.querySelectorAll('.sw.word-hit, .sw.word-partial, .sw.word-miss')
    .forEach((e) => e.classList.remove('word-hit', 'word-partial', 'word-miss'));
}
function applyScrollWordHits() {
  const box = $('scrollVerses');
  if (!box || state.aliyah) return; // aliyah paints via applyAliyahWordHits
  clearScrollWordHits(box);
  const wh = state._scrollWordHits;
  if (!wh) return;
  for (const gi in wh.scores) paintWordTint(box, wh.verse, parseInt(gi, 10), wh.scores[gi] / 100);
}

// Mirror the pesukim pane's word/phrase/whole-verse score heatmap (wordSpan(),
// gated on state.overlay) onto the selected verse's words in the full-reading
// scroll surface(s), so switching to the STA"M/pointed/dual view to keep
// reading doesn't lose the "where did I struggle" clue you had in verse mode.
// Painted as an inline background on every matching .sw (STA"M and pointed
// both carry data-verse/data-widx, so in dual view both tracks pick it up).
function clearScrollOverlay(box) {
  box = box || $('scrollVerses');
  if (!box) return;
  box.querySelectorAll('.sw[data-ov]').forEach((el) => {
    el.style.removeProperty('background');
    el.removeAttribute('data-ov');
  });
}
function applyScrollOverlay() {
  const box = $('scrollVerses');
  if (!box || state.aliyah) return; // aliyah practice has its own live clue
  clearScrollOverlay(box);
  const verseN = state.selectedVerse;
  if (state.overlay === 'off' || verseN == null) return;
  const segs = verseSegments(verseN);
  const ov = overlayScorer(verseN, segs);
  segs.forEach((s, wi) => {
    const score = ov.score(wi);
    if (score == null || score <= 0) return;
    const col = ov.lo != null && ov.hi != null ? rampColor(score, ov.lo, ov.hi) : scoreColor(score);
    box.querySelectorAll(`.sw[data-verse="${verseN}"][data-widx="${wi}"]`).forEach((el) => {
      el.style.background = col;
      el.setAttribute('data-ov', '1');
    });
  });
}

// Populate the shared STA"M scroll pane (#scrollVerses) with the open aliyah:
// the aliyah's verses plus surrounding context (dimmed), each word tagged so the
// yad cues (start / end / current spot) can highlight it. Reuses the same
// left-hand "Torah column" window and .scroll-column styling (word-level
// no-wrap, parchment) as regular reference, so entering/leaving aliyah mode
// doesn't move the scroll — only the practice pane's controls swap in.
function renderAliyahScroll(box) {
  box = box || $('scrollVerses');
  if (!box) return;
  const a = state.aliyah;
  if (!a) { box.innerHTML = ''; return; }
  const maxV = state.data.verses.length;
  const first = a.start, last = Math.min(a.end, maxV);
  const from = Math.max(1, first - ALIYAH_CONTEXT);
  const to = Math.min(maxV, last + ALIYAH_CONTEXT);
  ensureTikkunData(); // reachable without going through renderScrollPane
  let stamHtml = '';
  if (state.scrollTextMode !== 'pointed') {
    const tikkun = renderTikkunPages(state.tikkun, state.data, {
      focusStart: first,
      focusEnd: last,
      contextStart: from,
      contextEnd: to,
      selectedVerse: state.selectedVerse,
      columnClass: 'aliyah-scroll',
      columnId: 'aliyahScroll',
    });
    if (tikkun) {
      stamHtml = tikkun.html;
    } else {
      const scrollHtml = [];
      for (let n = from; n <= to; n++) {
        const segs = verseSegments(n);
        const inAliyah = n >= first && n <= last;
        const words = segs.map((s, wi) => {
          const rangeStart = n === first && wi === 0 ? ' range-start' : '';
          return `<span class="sw${inAliyah ? '' : ' ctx'}${rangeStart}" data-verse="${n}" data-widx="${wi}">${escapeHtml(toScroll(s.token))}</span>`;
        }).join(' ');
        scrollHtml.push(`<span class="al-verse${inAliyah ? '' : ' ctx'}">${words}</span>`);
      }
      stamHtml = `<div class="scroll-column aliyah-scroll" id="aliyahScroll">${scrollHtml.join(' ')}</div>`;
    }
  }
  const pointedHtml = state.scrollTextMode === 'stam' ? '' : (renderPointedTikkunHtml({
    focusStart: first, focusEnd: last, contextStart: from, contextEnd: to,
    selectedVerse: state.selectedVerse, columnClass: 'aliyah-scroll', columnId: 'aliyahPointed',
  }) || renderPointedScrollColumn({
    from, to, focusStart: first, focusEnd: last,
    selectedVerse: state.selectedVerse, id: 'aliyahPointed',
  }));
  box.innerHTML = scrollSurfaceHtml(stamHtml, pointedHtml);
  wireDualScrollSync(box);
  const title = document.querySelector('#scrollpane .pane-title');
  if (title) {
    const surface = state.scrollTextMode === 'pointed'
      ? 'Vowels &amp; cantillation'
      : state.scrollTextMode === 'dual' ? 'STA&ldquo;M + pointed' : 'STA&ldquo;M';
    title.innerHTML = `${chunkTitle(a)} <span class="hint" style="text-transform:none;letter-spacing:0">${surface}</span>`;
  }
  fitScrollPages();
  // Re-apply the start/end cues after any rebuild (e.g. a toolbar toggle) so the
  // yad markers survive re-renders of either full-reading surface.
  if (state._aliyaTl) markAliyahEnds(state._aliyaTl, !!state._aliyaEnded);
  // Re-apply the per-word "notes hit" tint too, so a toolbar toggle / rebuild
  // after a finished run doesn't wipe the clue.
  if (state._aliyaWordHits) applyAliyahWordHits(state._aliyaWordHits);
}

function selectVerse(n) {
  if (state.aliyah) setAliyahLayout(false);
  state.selectedVerse = n;
  state.aliyah = null; // leave aliyah mode when a single verse is chosen
  closePasukDrawer();
  tryLockLandscape(); // best-effort; ignored where the platform disallows it
  // Open the highest level this pasuk has unlocked, so returning to a verse
  // resumes at its hardest reached stage rather than a fixed earlier one.
  state.level = store.getVerseLevel(state.slug, n);
  state.unitIndex = 0;
  state.divideRank = null;
  renderVerses();
  renderAliyot();
  renderStageBar();
  renderPractice();
}

// ---------------------------------------------------------------------------
// Aliyah tier: a higher-level challenge above the per-verse stages. Each aliyah
// (a Torah-reading section) can be chanted from the bare scroll with a virtual
// yad cueing its start and end — but only once every pasuk in it has been worked
// up to at least the whole-verse stage.
// ---------------------------------------------------------------------------

// Verse numbers of an aliyah that actually exist in the loaded chapter.
function aliyahVerses(a) {
  const max = (state.data && state.data.verses.length) || a.end;
  const out = [];
  for (let n = a.start; n <= Math.min(a.end, max); n++) out.push(n);
  return out;
}

// Readiness = how many of the aliyah's pesukim have reached ALIYAH_READY_LEVEL.
function aliyahReadiness(a) {
  const vs = aliyahVerses(a);
  const ready = vs.filter((n) => store.getVerseLevel(state.slug, n) >= ALIYAH_READY_LEVEL).length;
  return { ready, total: vs.length, done: vs.length > 0 && ready === vs.length };
}

// Top panel now holds only the parashah/cycle context; the individual aliyah
// cards are woven into the verse list (each after the pesukim that unlock it).
function renderAliyot() {
  const box = $('aliyot');
  if (!box) return;
  const meta = state.drill || state.excerpt;
  if (meta) {
    // A drill set or a named passage: say what it is and where it comes from,
    // rather than which aliyot it covers.
    const par = parashahForReading();
    const from = state.excerpt ? ` <span class="hint">from ${par ? par.en : state.slug}</span>` : '';
    box.innerHTML = `<div class="aliyot-head">${escapeHtml(meta.label)}${from}</div>`
      + (meta.note ? `<p class="hint aliyot-note">${escapeHtml(meta.note)}</p>` : '')
      + (state.drill ? '<p class="hint aliyot-note">These words were never recorded, so the voice is synthesized \u2014 but the melody and the timing of every accent are measured from the cantor across all the recorded readings, not guessed. <b>▶ Sing these words</b> chants the drill itself; <b>🎤 Same tropes, real voice</b> finds the same accents in the readings and splices a human recitation of them (different words, same tune).</p>' : '');
    return;
  }
  const par = parashahForReading();
  if (!par) { box.innerHTML = ''; return; }
  // A haftarah is read straight through by one reader, so there is no cycle and
  // no aliyot to choose between — say which parashah it belongs to and which
  // rite's boundaries these are, which is what a reader preparing it needs.
  if (state.readingKind === 'haftarah') {
    const h = state.data.haftarah || {};
    const entry = AVAILABLE.find((p) => p.slug === state.readingId) || {};
    const rite = h.traditionLabel ? `${h.traditionLabel} rite` : '';
    const where = [state.data.ref, rite].filter(Boolean).join(' · ');
    box.innerHTML = `<div class="aliyot-head">${par.he} <span class="hint">${escapeHtml(where)}</span></div>`
      + (entry.note ? `<p class="hint aliyot-note">${escapeHtml(entry.note)}</p>` : '')
      + '<p class="hint aliyot-note">Chanted straight through to the haftarah melody \u2014 the same accents as the Torah, a different tune for each of them. Work the pesukim up as usual, then chant the whole haftarah in one go.</p>';
    return;
  }
  // A passage the reader picked: name it, say where in the book it sits, and be
  // honest that nobody recorded it.
  if (state.readingKind === 'custom' && state.custom) {
    const c = state.custom;
    // Named, the name is the heading and the reference joins what follows it —
    // which is the reader's own shorthand for where they are, so it leads.
    const where = [c.name ? state.data.ref : '', c.sectionLabel,
      c.parashah ? `parashat ${c.parashah.en}` : '',
      plural(c.count, 'pasuk', 'pesukim')].filter(Boolean).join(' · ');
    box.innerHTML = `<div class="aliyot-head">${escapeHtml(c.name || state.data.ref)} <span class="hint">${escapeHtml(where)}</span></div>`
      + `<p class="hint aliyot-note">${escapeHtml(state.data.heRef)}</p>`
      + '<p class="hint aliyot-note">No cantor recorded these pesukim, so the guide voice is synthesized \u2014 from how each accent is really sung, measured across every recorded haftarah. Work the pesukim up as usual, then chant the whole passage in one go.</p>'
      + (c.accents === 'poetic' ? `<p class="hint aliyot-note">${escapeHtml(POETIC_NOTE)}</p>` : '');
    return;
  }
  const list = aliyotForReading(state.cycle, state.triYear);
  const cycleLabel = state.cycle === 'triennial' ? `Triennial · Year ${state.triYear}` : 'Annual';
  let html = `<div class="aliyot-head">${par.he} <span class="hint">${cycleLabel} · ${par.ref}</span></div>`;
  html += list.length
    ? '<p class="hint aliyot-note">Tap an aliyah below to open its pesukim.</p>'
    : `<p class="hint aliyot-note">This cycle's reading falls outside the loaded chapter (${state.data.book.en} ${state.data.chapter}). Switch cycle or add more chapters.</p>`;
  box.innerHTML = html;
}

// --- Verse chains -----------------------------------------------------------
// Knowing every pasuk of an aliyah cold still leaves the joins between them
// unrehearsed, which is where a long aliyah usually falls apart. A chain is a
// short run of consecutive pesukim — pairs by default, or triples — chanted
// straight through, so the seams get their own practice before the whole aliyah
// is attempted. Chains reuse the aliyah reader (bare scroll + yad) with a verse
// range of their own.

const CHAIN_SIZES = [2, 3, 4];

// Split an aliyah into back-to-back runs of `size` pesukim. A trailing remainder
// of one verse is absorbed into the previous run rather than offered as a
// pointless one-verse "chain".
function chainRuns(a, size) {
  const verses = aliyahVerses(a);
  const runs = [];
  for (let i = 0; i < verses.length; i += size) {
    runs.push({ start: verses[i], end: verses[Math.min(i + size - 1, verses.length - 1)] });
  }
  if (runs.length > 1) {
    const last = runs[runs.length - 1];
    if (last.start === last.end) { runs[runs.length - 2].end = last.end; runs.pop(); }
  }
  return runs.filter((r) => r.end > r.start);
}

function buildChainStrip(a) {
  const el = document.createElement('div');
  el.className = 'chains';
  const runs = chainRuns(a, state.chainSize);
  if (!runs.length) { el.hidden = true; return el; }
  const sizes = CHAIN_SIZES.map((n) => `<button class="cs${n === state.chainSize ? ' on' : ''}" data-size="${n}">${n}</button>`).join('');
  // A run keeps a best per surface, so the chip shows the one for the text on
  // screen and names both in its tooltip — otherwise switching the Torah column
  // to the pointed text would look like the run's score had vanished.
  const surface = chainSurfaceNow();
  const chips = runs.map((r) => {
    const score = store.getChainScore(state.slug, r.start, r.end, surface);
    const pointed = store.getChainScore(state.slug, r.start, r.end, 'pointed');
    const stam = store.getChainScore(state.slug, r.start, r.end, 'stam');
    const ready = chainReadiness(r);
    const bests = `${pointed ? `\nWith the vowels: ${pointed}` : ''}${stam ? `\nFrom the scroll: ${stam}` : ''}`;
    return `<button class="chain${ready ? ' ready' : ''}" data-start="${r.start}" data-end="${r.end}"`
      + ` title="Chant pesukim ${rangeRef(r.start, r.end)} straight through${bests}">`
      + `${rangeRef(r.start, r.end)}`
      + `${score > 0 ? `<span class="chain-score" style="background:${scoreColor(score)}">${score}</span>` : ''}`
      + `</button>`;
  }).join('');
  el.innerHTML = `<div class="chains-head">
      <span class="chains-title">🔗 Chain pesukim</span>
      <span class="seg chain-sizes">${sizes}</span>
    </div>
    <div class="chain-list">${chips}</div>
    <p class="hint chains-note">Chant a run of pesukim without stopping, so the joins between them get practiced before the whole aliyah. Each run keeps a separate best for the pointed text and for the bare scroll — the joins are easier to hear when the letters aren't also work.</p>`;
  el.querySelectorAll('.cs').forEach((b) => b.addEventListener('click', () => {
    state.chainSize = parseInt(b.dataset.size, 10);
    renderVerses();
  }));
  el.querySelectorAll('.chain').forEach((b) => b.addEventListener('click', () => {
    openChain(parseInt(b.dataset.start, 10), parseInt(b.dataset.end, 10));
  }));
  return el;
}

// A chain is "ready" once every pasuk in it has reached the whole-verse stage.
// Unlike an aliyah this is only a cue, not a lock — chaining verses is how you
// get them there.
function chainReadiness(r) {
  for (let n = r.start; n <= r.end; n++) {
    if (store.getVerseLevel(state.slug, n) < ALIYAH_READY_LEVEL) return false;
  }
  return true;
}

// `surface` asks for the run to be read from a particular text — 'pointed' for
// the vowels-and-accents tier of guided mode's chaining round, 'stam' for the
// bare scroll above it. Expert mode passes nothing and the run opens in whatever
// text the reader has chosen, as it always has.
function openChain(startV, endV, opts = {}) {
  const surface = opts.surface;
  if (surface === 'pointed' || surface === 'stam') {
    if (state._scrollTextModeBeforeChain == null) {
      state._scrollTextModeBeforeChain = state.scrollTextMode;
    }
    applyScrollTextMode(surface, false);
  }
  openAliyah({
    n: `C${startV}-${endV}`,
    kind: 'chain',
    start: startV,
    end: endV,
    ref: rangeRef(startV, endV),
  });
}

// Put the reader's own choice of text back once they leave a run that was opened
// on a surface of the app's choosing. Only the state: this runs while the reader
// is on their way somewhere else (a pasuk, another reading), and every caller
// draws what they asked for straight afterwards.
function restoreScrollTextMode() {
  if (state._scrollTextModeBeforeChain == null) return;
  state.scrollTextMode = state._scrollTextModeBeforeChain;
  state._scrollTextModeBeforeChain = null;
}

// A single aliyah card element, inserted inline after its last unlocking pasuk.
// Two variants share it: the maftir (a.n === 'M'), which repeats the closing
// pesukim, and a whole haftarah (a.n === 'H'), which is the entire reading in one
// go because a haftarah is chanted straight through. Both are labelled distinctly
// but otherwise practised and scored exactly like an aliyah.
function buildAliyahCard(a) {
  const kind = chunkKind(a);
  const isMaftir = kind === 'maftir';
  const whole = kind === 'haftarah' || kind === 'passage';
  const r = aliyahReadiness(a);
  const score = store.getAliyahScore(state.slug, state.cycle, state.triYear, a.n);
  const pct = r.total ? Math.round((r.ready / r.total) * 100) : 0;
  const open = state.aliyah && state.aliyah.n === a.n && state.aliyah.cycle === state.cycle && state.aliyah.year === state.triYear;
  const badge = score > 0 ? `<span class="al-score" style="background:${scoreColor(score)}">${score}</span>` : '';
  const action = r.done
    ? `<button class="al-go">${score > 0 ? '↻ Chant again' : `▶ Chant ${chunkNoun(a)}`}</button>`
    : `<span class="al-lock" title="Reach stage ${ALIYAH_READY_LEVEL} on every pasuk first">🔒 ${r.ready}/${r.total} pesukim ready</span>`;
  const el = document.createElement('div');
  el.className = `aliyah${isMaftir ? ' maftir' : ''}${whole ? ` ${kind}` : ''}${open ? ' open' : ''}${r.done ? ' ready' : ''}`;
  const label = isMaftir
    ? `Maftir <span class="hint">${a.ref}</span>`
    : whole
      ? `Whole ${chunkNoun(a)} <span class="hint">${a.ref}</span>`
      : `Aliyah ${a.n} <span class="hint">ends ${a.ref}</span>`;
  el.innerHTML = `
    <div class="al-main">
      <span class="al-n">${chunkBadge(a)}</span>
      <span class="al-label">${label}</span>
      ${badge}
    </div>
    <div class="al-prog"><span style="width:${pct}%;background:${r.done ? 'var(--good)' : 'var(--accent-2)'}"></span></div>
    <div class="al-actions">${action}</div>`;
  const go = el.querySelector('.al-go');
  if (go) go.addEventListener('click', () => openAliyah(a));
  return el;
}

// What kind of multi-verse unit is open: a numbered aliyah, the maftir, a whole
// haftarah, or a short verse chain. They share the whole reader, so this is only
// about wording and where the score is filed.
function chunkKind(a) {
  if (!a) return 'aliyah';
  if (a.kind) return a.kind;
  if (a.n === 'M') return 'maftir';
  if (a.n === 'H') return 'haftarah';
  if (a.n === 'C') return 'passage';
  return 'aliyah';
}

function chunkTitle(a) {
  const kind = chunkKind(a);
  if (kind === 'maftir') return 'Maftir';
  if (kind === 'haftarah') return 'Haftarah';
  if (kind === 'passage') return 'Whole passage';
  if (kind === 'chain') return `Pesukim ${a.ref}`;
  return `Aliyah ${a.n}`;
}

// The word for the unit in button labels and prompts ("Chant the whole …").
function chunkNoun(a) {
  const kind = chunkKind(a);
  if (kind === 'chain') return 'chain';
  if (kind === 'haftarah') return 'haftarah';
  if (kind === 'maftir') return 'maftir';
  if (kind === 'passage') return 'passage';
  return 'aliyah';
}

// The small Hebrew tag on a chunk's row. A numbered aliyah gets its numeral; the
// units that have no number get an abbreviation of their name.
function chunkBadge(a) {
  const kind = chunkKind(a);
  if (kind === 'maftir') return '\u05de\u05e4';       // מפ, maftir
  if (kind === 'haftarah') return '\u05d4\u05e4';     // הפ, haftarah
  if (kind === 'passage') return '\u05e4\u05e1';      // פס, pesukim
  return toHebrewNum(a.n);
}

// The cycle prefix on a chunk's header tag. Only a parashah has a cycle to name;
// a haftarah is read whole every year, so saying "Annual" would be noise.
function cycleTag(a) {
  if (!hasAliyotCycle(state.readingKind)) return '';
  return `${a.cycle === 'triennial' ? `Triennial Yr ${a.year}` : 'Annual'} · `;
}

function openAliyah(a) {
  stopAll();
  closePasukDrawer();
  state.aliyah = { ...a, cycle: state.cycle, year: state.triYear };
  state._aliyaEnded = false;
  setAliyahLayout(true);
  renderAliyot();
  renderAliyahView();
}

// Toggle the aliyah reading layout: reveal the shared STA"M pane (remembering
// whether scroll view was on so we can restore it on exit) and flag the body so
// the CSS can re-flow the panes (a control panel on desktop; a stacked scroll +
// controls on mobile).
function setAliyahLayout(on) {
  document.body.classList.toggle('aliyah-open', on);
  if (on) {
    if (state._scrollViewBeforeAliyah == null) state._scrollViewBeforeAliyah = state.scrollView;
    state.scrollView = true;
    if (state._practiceCollapsedBeforeAliyah == null) {
      state._practiceCollapsedBeforeAliyah = state.practiceCollapsed;
    }
    state.practiceCollapsed = false;
  } else {
    restoreScrollTextMode();
    if (state._scrollViewBeforeAliyah != null) {
      state.scrollView = state._scrollViewBeforeAliyah;
      state._scrollViewBeforeAliyah = null;
    }
    if (state._practiceCollapsedBeforeAliyah != null) {
      state.practiceCollapsed = state._practiceCollapsedBeforeAliyah;
      state._practiceCollapsedBeforeAliyah = null;
    }
  }
  syncToggleUI();
}

// Concatenate the aliyah's verses into one timeline: each segment carries its
// audio window, coach line, duration, and global start/end (with a small gap
// between verses), so the yad and the recording clock can run continuously.
function aliyahTimeline(a) {
  const GAP = 0.35;
  let tAcc = 0;
  const segs = [];
  for (const n of aliyahVerses(a)) {
    const info = verseAudio(n);
    const vsegs = verseSegments(n);
    const coach = buildCoach(vsegs, n);
    const aStart = coach ? coach.start : (info ? info.start : 0);
    const aEnd = coach ? coach.end : (info ? info.end : 0);
    const dur = coach ? coach.dur : Math.max(1.2, (aEnd - aStart) || vsegs.length * 0.5);
    segs.push({ n, file: info && info.file, vsegs, coach, aStart, aEnd, dur, gStart: tAcc, gEnd: tAcc + dur });
    tAcc += dur + GAP;
  }
  return { segs, total: tAcc };
}

const ALIYAH_CONTEXT = 8; // verses of surrounding scroll shown before/after

function renderAliyahView() {
  const a = state.aliyah;
  ensureAliyahPitch(state.slug); // an aliyah spans many verses → load the monoliths, not shards
  const par = parashahForReading();
  // The STA"M scroll itself lives in the shared left "Torah column" pane
  // (renderAliyahScroll); this practice pane holds only the aliyah's controls —
  // header, outline cues, transport, live meter and result — so switching to and
  // from a single-verse view leaves the scroll in place rather than replacing it.
  const p = $('practice');
  p.classList.add('aliyah-fill');
  p.innerHTML = `
    <div class="aliyah-view">
    <div class="phead">
      <h2>${par.he} · ${chunkTitle(a)} <span class="stagetag">${cycleTag(a)}${a.ref}</span></h2>
      <button id="alBack">← Verses</button>
    </div>
    <p class="leveldesc">${chunkKind(a) === 'chain'
      ? (chainSurfaceNow() === 'pointed'
        ? 'Chant these pesukim straight through from the pointed text on the left, without pausing at the verse joins — that seam is what a whole aliyah is built from. The vowels and accents are there so the joins are the only hard part; the same run comes back off the bare scroll.'
        : 'Chant these pesukim straight through from the bare scroll on the left, without pausing at the verse joins — that seam is what a whole aliyah is built from.')
      : chunkKind(a) === 'haftarah' || chunkKind(a) === 'passage'
        ? `Chant the whole ${chunkNoun(a)} from the bare text on the left, straight through, as it is read. A grey outline marks the current spot and, subtly, where to begin and end.`
        : 'Chant the whole aliyah from the bare scroll on the left. A grey outline marks the current spot and, subtly, where to begin and end — as in a real reading. Faded text is the surrounding scroll for context.'}</p>
    <div class="al-cuebar">
      <span class="label">Outline:</span>
      <span class="seg" id="aliyaCueSeg">
        <button class="cue" data-cue="word">Word</button>
        <button class="cue" data-cue="phrase">Phrase</button>
      </span>
    </div>
    <div class="aliyah-top">
    <div class="transport">
      <button class="primary" id="alGuide" title="Play the real chant across the whole ${chunkNoun(a)} (Space)">▶ Guided read (real chant)</button>
      <button class="warn" id="alRec" title="Record your solo chant (↓)">● Record my ${chunkNoun(a)}</button>
      <button id="alDuet" title="Sing along with the real chant while recording (↑)">⇅ Duet (sing along)</button>
      <span class="transport-scrub">
        <button id="alStepBack" disabled title="Back one word — key: ,">⟲ Word <kbd>,</kbd></button>
        <button id="alPause" disabled aria-pressed="false" title="Pause / resume — key: Space">⏸ Pause</button>
        <button id="alStepFwd" disabled title="Forward one word — key: .">Word ⟳ <kbd>.</kbd></button>
      </span>
      <button id="alStop" disabled title="Stop (Esc)">■ Stop</button>
    </div>
    <div class="livemeter" id="aliyaMeter" hidden>
      <span class="lm-label">Live aliyah</span>
      <div class="lm-track"><div class="lm-fill" id="aliyaMeterFill"></div></div>
      <span class="lm-val"><b id="aliyaMeterVal">0</b>%</span>
    </div>
    </div>
    <div class="aliyah-dock">
    <div class="result" id="aliyaResult"><span class="hint">Listen to the guided read to learn the flow, then record your own chant — or sing a duet along with the real chant.</span></div>
    </div>
    </div>
  `;
  const tl = aliyahTimeline(a);
  state._aliyaTl = tl;
  // Build the scroll in the shared pane (this also applies the start cue).
  renderAliyahScroll();
  // One-time: bring the aliyah's start into view in every visible reading
  // surface. Dual mode gives each column its own scroll container.
  requestAnimationFrame(scrollTikkunStartIntoView);
  $('aliyaCueSeg').querySelectorAll('.cue').forEach((b) => {
    b.classList.toggle('on', b.dataset.cue === state.aliyahCue);
    b.addEventListener('click', () => {
      state.aliyahCue = b.dataset.cue;
      $('aliyaCueSeg').querySelectorAll('.cue').forEach((x) => x.classList.toggle('on', x.dataset.cue === state.aliyahCue));
    });
  });
  $('alBack').addEventListener('click', () => {
    stopAliyah();
    state.aliyah = null;
    setAliyahLayout(false);
    renderAliyot();
    renderScrollPane();
    if (state.selectedVerse) renderPractice();
    else { $('practice').classList.remove('aliyah-fill'); $('practice').innerHTML = '<p class="empty">Select a verse on the left to begin practicing.</p>'; }
  });
  $('alGuide').addEventListener('click', () => playAliyahGuided(tl));
  $('alRec').addEventListener('click', () => recordAliyahRun(tl));
  $('alDuet').addEventListener('click', () => recordAliyahRun(tl, { duet: true }));
  $('alStop').addEventListener('click', () => { stopAliyah(); setAliyahButtons(false); });
  $('alPause').addEventListener('click', togglePause);
  $('alStepBack').addEventListener('click', () => stepWord(-1));
  $('alStepFwd').addEventListener('click', () => stepWord(1));
  syncTransportUI();
}

function setAliyahButtons(running) {
  const g = $('alGuide'), r = $('alRec'), d = $('alDuet'), s = $('alStop');
  if (g) g.disabled = running;
  if (r) r.disabled = running;
  if (d) d.disabled = running;
  if (s) s.disabled = !running;
  syncTransportUI();
}

// Subtle start/end cueing: glow the aliyah's first word (where to begin) always,
// and its last word (where to end) once the read/recording completes.
function markAliyahEnds(tl, atEnd) {
  const box = $('scrollVerses');
  if (!box) return;
  box.querySelectorAll('.yad-start,.yad-end').forEach((e) => e.classList.remove('yad-start', 'yad-end'));
  const first = tl.segs[0];
  if (first) {
    box.querySelectorAll(`.sw[data-verse="${first.n}"][data-widx="0"]`)
      .forEach((el) => el.classList.add('yad-start'));
  }
  if (atEnd) {
    const last = tl.segs[tl.segs.length - 1];
    if (last && last.vsegs.length) {
      box.querySelectorAll(`.sw[data-verse="${last.n}"][data-widx="${last.vsegs.length - 1}"]`)
        .forEach((el) => el.classList.add('yad-end'));
    }
  }
}

// Local word indices belonging to the same phrase as `widx` within a verse
// segment (memoized on the segment). Phrases split at disjunctive accents.
function aliyahPhraseMembers(seg, widx) {
  if (!seg._phraseByWidx) {
    seg._phraseByWidx = {};
    splitPhrases(seg.vsegs).forEach((ph) => {
      const members = ph.map((s) => seg.vsegs.indexOf(s)).filter((x) => x >= 0);
      members.forEach((wi) => { seg._phraseByWidx[wi] = members; });
    });
  }
  return seg._phraseByWidx[widx] || [widx];
}

// Outline the current spot with a grey box (no layout shift, no auto-scroll).
// Granularity follows state.aliyahCue: a single word or its whole phrase.
function highlightAliyah(verseN, widx) {
  const box = $('scrollVerses');
  if (!box) return;
  box.querySelectorAll('.yad-cur').forEach((e) => e.classList.remove('yad-cur'));
  if (verseN == null) return;
  let members = [widx];
  if (state.aliyahCue === 'phrase' && state._aliyaTl) {
    const seg = state._aliyaTl.segs.find((s) => s.n === verseN);
    if (seg) members = aliyahPhraseMembers(seg, widx);
  }
  members.forEach((wi) => {
    box.querySelectorAll(`.sw[data-verse="${verseN}"][data-widx="${wi}"]`)
      .forEach((el) => el.classList.add('yad-cur'));
  });
}

// Live per-word accuracy while recording an aliyah: accumulate whether each frame
// of the CURRENT (yad-pointed) word lands within the note band, and tint that
// word by its running in-band fraction so accuracy shows up as it's sung. When
// the yad moves on, the previous word keeps its live tint; the post-run pass
// (applyAliyahWordHits) later repaints every word with the authoritative score.
const LIVE_HIT_BAND_GH = 1.5;      // note-hit band (matches scoreNotes' default)
const LIVE_HIT_BAND_MELODY = 0.9;  // contour "perfect" zone (matches DEADZONE)
function trackLiveWordHit(verseN, widx, inBand) {
  const cur = state._aliyaLiveWord;
  if (!cur || cur.verseN !== verseN || cur.widx !== widx) {
    state._aliyaLiveWord = { verseN, widx, inband: 0, total: 0 };
  }
  const w = state._aliyaLiveWord;
  w.total++;
  if (inBand) w.inband++;
  paintWordTint($('scrollVerses'), verseN, widx, w.inband / w.total);
}
// Single-verse (non-aliyah) twin of trackLiveWordHit: while recording one pasuk,
// tint the yad-pointed word in the STA"M column (#scrollVerses) live by its
// running in-band fraction, so the same green/amber/red clue shows up AS it's
// sung (level 8 etc.) instead of only after the take. finishRecording ->
// paintScrollWordHits repaints every word with the authoritative score, so the
// clue stays (and is corrected) once the run ends — exactly like aliyah mode.
function trackLiveScrollWordHit(verseN, gi, inBand) {
  if (verseN == null || gi == null || gi < 0) return;
  const cur = state._scrollLiveWord;
  if (!cur || cur.verseN !== verseN || cur.gi !== gi) {
    state._scrollLiveWord = { verseN, gi, inband: 0, total: 0 };
  }
  const w = state._scrollLiveWord;
  w.total++;
  if (inBand) w.inband++;
  paintWordTint($('scrollVerses'), verseN, gi, w.inband / w.total);
}
// Score ONE word with the contour (melody) model: restrict the trail and the
// word's steps to the word's own time window and re-normalize both to [0,1] so
// scoreTrail grades just that word's shape (rather than the word's tiny slice of
// the whole-verse timeline). Returns 0..100, matching scoreNotes' scale.
function wordContourScore(trail, wSteps) {
  if (!wSteps || !wSteps.length) return 0;
  let wt0 = Infinity, wt1 = -Infinity;
  for (const s of wSteps) { if (s.t0 < wt0) wt0 = s.t0; if (s.t1 > wt1) wt1 = s.t1; }
  const span = wt1 - wt0;
  if (!(span > 0)) return 0;
  const remTrail = [];
  for (const p of trail) {
    if (p.t < wt0 || p.t > wt1) continue;
    remTrail.push({ t: (p.t - wt0) / span, sp: p.sp, rms: p.rms });
  }
  const remPts = stepsToPoints(wSteps).map((pt) => ({ t: (pt.t - wt0) / span, p: pt.p }));
  return scoreTrail(remTrail, remPts);
}

function paintWordTint(box, verseN, widx, frac) {
  if (!box) return;
  box.querySelectorAll(`.sw[data-verse="${verseN}"][data-widx="${widx}"]`).forEach((el) => {
    el.classList.remove('word-hit', 'word-partial', 'word-miss');
    el.classList.add(frac >= 0.66 ? 'word-hit' : frac >= 0.33 ? 'word-partial' : 'word-miss');
  });
}

function stopAliyah() {
  state._aliyaRunning = null;
  state._aliyaDuet = false;
  window.__cantillateBusy = false;
  clearTimeout(state._aliyaTimer);
  if (state._aliyaGuideTimers) { state._aliyaGuideTimers.forEach(clearTimeout); state._aliyaGuideTimers = []; }
  stopVerseAudio();
  stopMic();
  stopLiveMeter();
  resetTransport();
}

// Guided read: play the real chant across the whole aliyah, chaining verses, the
// yad following the current word — a listening/reading run to learn the flow.
function playAliyahGuided(tl) {
  stopAliyah();
  state._aliyaRunning = 'guide';
  state._aliyaEnded = false;
  state._aliyaDuet = false;
  resetTransport();
  setAliyahButtons(true);
  markAliyahEnds(tl, false);
  let i = 0;
  const playNext = () => {
    if (state._aliyaRunning !== 'guide') return;
    if (i >= tl.segs.length) { finishGuide(tl); return; }
    const seg = tl.segs[i];
    if (!seg.file) { i++; playNext(); return; }
    // Anchor the shared clock to this verse's slot so pausing and stepping resolve
    // to the right segment while the guided read chains through the aliyah.
    state._aliyaT0 = performance.now() - seg.gStart * 1000;
    $('aliyaResult').innerHTML = `<span class="hint">Reading verse ${seg.n}… Space holds it, <b>,</b> / <b>.</b> step a word.</span>`;
    playSegment(seg.file, seg.aStart, seg.aEnd, {
      onProgress: (t01) => { if (seg.coach) highlightAliyah(seg.n, wordAtTime(seg.coach, t01)); },
      onEnd: () => { i += 1; playNext(); },
      onError: () => { i += 1; playNext(); },
    });
    syncTransportUI();
  };
  playNext();
}

function finishGuide(tl) {
  if (state._aliyaRunning !== 'guide') return;
  state._aliyaRunning = null;
  state._aliyaEnded = true;
  resetTransport();
  setAliyahButtons(false);
  highlightAliyah(null);
  markAliyahEnds(tl, true);
  $('aliyaResult').innerHTML = '<span class="hint">That\'s the whole aliyah. Now record your own chant.</span>';
}

// Record run: one continuous mic session over the aliyah timeline. The yad paces
// you (start cue → moving pointer → end cue); afterward each verse slice is
// scored against its coach and averaged into the aliyah accuracy.
async function recordAliyahRun(tl, opts = {}) {
  const duet = !!(opts && opts.duet);
  stopAliyah();
  state._aliyaRunning = 'rec';
  state._aliyaEnded = false;
  state._aliyaAssisted = duet; // a duet (sing-along) take is scaled down + capped
  state._aliyaGuideTimers = [];
  window.__cantillateBusy = true; // hold off any service-worker auto-reload
  state._aliyaSamples = [];
  state._aliyaDiffs = [];
  state._aliyaWordHits = null; // wipe any prior take's per-word hit tint
  state._aliyaLiveWord = null; // reset the live per-word accuracy accumulator
  clearAliyahWordHits();
  setAliyahButtons(true);
  markAliyahEnds(tl, false);
  startLiveMeter('aliyaMeter', 'aliyaMeterFill', 'aliyaMeterVal');
  // Mark your best + the record holder for this aliyah on the meter. Chains are
  // personal practice runs with no shared board, so they get no marks.
  {
    const a = state.aliyah;
    if (a && chunkKind(a) !== 'chain') {
      const parId = scores.parashaIdFor(parashahForReading(), state.slug);
      showRecordMeterMarks('aliyaMeterFill', 'aliyah', scores.aliyahIdFor(parId, a.cycle, a.year, a.n), store.getAliyahScore(state.slug, a.cycle, a.year, a.n));
    }
  }
  const leadIn = 500;
  // Where the run would begin on a warm mic; the clock is anchored for real once
  // the device is open (below), so a cold open can't eat the head of the take.
  const planned = performance.now() + leadIn;
  // Kept on state so the shared transport can hold the run and shift the whole
  // timeline (clock, backstop and duet cues) by however long it was paused.
  state._aliyaT0 = Infinity;
  state._aliyaDuet = duet;
  state._aliyaPausedAt = 0;
  resetTransport();
  $('aliyaResult').innerHTML = duet
    ? '<span class="hint">Duet — sing along with the real chant (use headphones + a wired mic) as you follow the yad.</span>'
    : '<span class="hint">Get ready… begin at the glowing first word and follow the yad.</span>';
  await startMic((hz, rms) => {
    if (state._aliyaRunning !== 'rec') return;
    if (state.paused) return; // held mid-take: the clock and the samples both stop
    const now = performance.now();
    if (now < state._aliyaT0) return;
    const tG = (now - state._aliyaT0) / 1000;
    if (tG >= tl.total) { finishAliyahRecord(tl); return; }
    state._aliyaSamples.push({ tG, hz: hz > 0 ? hz : 0, rms });
    const seg = tl.segs.find((s) => tG >= s.gStart && tG < s.gEnd);
    if (seg && seg.coach) {
      const t01 = (tG - seg.gStart) / (seg.dur || 1);
      const widx = wordAtTime(seg.coach, t01);
      highlightAliyah(seg.n, widx);
      // Live meter + live per-word tint: as each word is sung, colour the very
      // word the yad is on by how well its notes are landing so far (green =
      // on, amber = shaky, red = off). The post-run pass repaints authoritatively.
      if (hz > 0 && rms >= 0.01) {
        const rawT = 12 * Math.log2(hz / (seg.coach.tonicHz || 200));
        const tgt = sampleContour(seg.coach.points, t01);
        state._aliyaDiffs.push(tgt - rawT);
        if (state._aliyaDiffs.length > 200) state._aliyaDiffs.shift();
        const err = (rawT + median(state._aliyaDiffs)) - tgt;
        feedLiveMeter(err);
        // "Good frame" band follows the selected model: the note-hit band for
        // Note-hit mode, the tighter contour "perfect" zone for Melody mode.
        const band = state.scoreModel === 'gh' ? LIVE_HIT_BAND_GH : LIVE_HIT_BAND_MELODY;
        trackLiveWordHit(seg.n, widx, Math.abs(err) <= band);
      }
    } else {
      highlightAliyah(null);
    }
  }, () => {});
  const t0 = Math.max(planned, performance.now() + 250);
  state._aliyaT0 = t0;
  // Duet: play the real chant in time with your take, one segment per verse,
  // each scheduled at its slot on the shared timeline so the two stay aligned —
  // against the same anchor as the take, or the guide sings ahead of the yad.
  if (duet) scheduleAliyahDuet(tl, t0);
  state._aliyaTimer = setTimeout(() => finishAliyahRecord(tl),
    Math.max(0, t0 - performance.now()) + tl.total * 1000 + 900);
  syncTransportUI();
}

// (Re)schedule the duet guide: one recorded verse per timeline slot, anchored to
// `t0`. Called again after a pause so the remaining verses land at their shifted
// slots instead of all at once.
function scheduleAliyahDuet(tl, t0) {
  if (state._aliyaGuideTimers) state._aliyaGuideTimers.forEach(clearTimeout);
  state._aliyaGuideTimers = [];
  const now = performance.now();
  for (const seg of tl.segs) {
    if (!seg.file) continue;
    const at = t0 + seg.gStart * 1000;
    if (at + seg.dur * 1000 < now) continue; // already sung past this verse
    state._aliyaGuideTimers.push(setTimeout(() => {
      if (state._aliyaRunning !== 'rec' || state.paused) return;
      playSegment(seg.file, seg.aStart, seg.aEnd, { onEnd: () => {}, onError: () => {} });
    }, Math.max(0, at - now)));
  }
}

function scoreAliyahVerse(seg, samples) {
  if (!seg.coach || !seg.coach.points.length) return { score: 0, wordHits: [] };
  const local = samples.filter((s) => s.tG >= seg.gStart && s.tG < seg.gEnd && s.hz > 0);
  if (local.length < 3) return { score: 0, wordHits: [] };
  const tonic = seg.coach.tonicHz || 200;
  const trail = [];
  const diffs = [];
  for (const s of local) {
    const t01 = (s.tG - seg.gStart) / (seg.dur || 1);
    const rawT = 12 * Math.log2(s.hz / tonic);
    diffs.push(sampleContour(seg.coach.points, t01) - rawT);
    trail.push({ t: t01, rawT, rms: s.rms });
  }
  const off = median(diffs);
  for (const p of trail) p.sp = p.rawT + off;
  const score = Math.round(scoreSteps(trail, seg.coach.steps).active);
  // Per-word accuracy clue for the scroll overlay, following the SELECTED model:
  // Note-hit mode uses each word's note-hit in-band fraction; Melody mode uses a
  // per-word slice of the contour scorer (the word's steps + frames re-normalized
  // to their own window). Map each coach word back to its position in the verse
  // so we can tint the matching STA"M word.
  const wordHits = [];
  const ow = seg.coach.overlayWords || [];
  const vsegs = seg.vsegs || [];
  for (let wi = 0; wi < ow.length; wi++) {
    const wSteps = seg.coach.steps.filter((st) => st.w === wi);
    if (!wSteps.length) continue;
    const wScore = state.scoreModel === 'gh'
      ? scoreNotes(trail, wSteps).score
      : wordContourScore(trail, wSteps);
    const widx = vsegs.indexOf(ow[wi].seg);
    if (widx >= 0) wordHits.push({ widx, frac: wScore / 100 });
  }
  return { score, wordHits };
}

// Paint a subtle per-word "notes hit" clue onto the aliyah STA"M scroll: green
// tint where the word's notes were mostly hit, amber partial, red mostly missed.
function clearAliyahWordHits() {
  const box = $('scrollVerses');
  if (!box) return;
  box.querySelectorAll('.sw.word-hit, .sw.word-partial, .sw.word-miss')
    .forEach((e) => e.classList.remove('word-hit', 'word-partial', 'word-miss'));
}

function applyAliyahWordHits(perVerse) {
  const box = $('scrollVerses');
  if (!box) return;
  clearAliyahWordHits();
  for (const { seg, wordHits } of perVerse) {
    for (const wh of wordHits) paintWordTint(box, seg.n, wh.widx, wh.frac);
  }
}

function finishAliyahRecord(tl) {
  if (state._aliyaRunning !== 'rec') return;
  const assisted = !!state._aliyaAssisted; // duet take: scaled down + capped (see scores.js)
  state._aliyaRunning = null;
  state._aliyaEnded = true;
  state._aliyaAssisted = false;
  state._aliyaDuet = false;
  window.__cantillateBusy = false;
  resetTransport();
  clearTimeout(state._aliyaTimer);
  if (state._aliyaGuideTimers) { state._aliyaGuideTimers.forEach(clearTimeout); state._aliyaGuideTimers = []; }
  stopVerseAudio();
  stopMic();
  stopLiveMeter();
  highlightAliyah(null);
  const samples = state._aliyaSamples || [];
  const perVerse = tl.segs.map((seg) => ({ seg, ...scoreAliyahVerse(seg, samples) }));
  const scored = perVerse.map((x) => x.score).filter((x) => x > 0);
  const raw = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;
  // A duet is easier than an unaided read, so it's worth less and capped below
  // the solo ceiling — a sing-along can never beat a strong solo take.
  const score = assisted ? scores.assistedScore(raw) : raw;
  const a = state.aliyah;
  const kind = chunkKind(a);
  const surface = chainSurfaceNow();
  if (kind === 'chain') {
    // A chain is a practice run between pasuk and aliyah, so it keeps its own
    // best and stays off the aliyah boards. Filed under the text it was read
    // from, because the same run off the bare scroll is the harder feat and the
    // two bests are what the chaining round steps between.
    store.recordChainScore(state.slug, a.start, a.end, score, surface);
  } else {
    store.recordAliyahScore(state.slug, a.cycle, a.year, a.n, score);
    // Log this continuous take (with the duet flag) for the score-over-runs
    // colourbar, and separately record a genuine solo chain so the leaderboard can
    // rank solo takes above duet takes above a derived-from-pesukim floor.
    store.recordAliyahRunLog(state.slug, a.cycle, a.year, a.n, score, assisted);
    if (!assisted && raw > 0) store.recordAliyahSolo(state.slug, a.cycle, a.year, a.n, raw);
  }
  store.addPracticeSeconds(tl.total || 0);
  markAliyahEnds(tl, true);
  setAliyahButtons(false);
  const msg = score <= 0 ? 'No clear pitch captured — check your mic and follow the yad.'
    : assisted ? 'Nice duet. Now try it solo — a solo take can score higher.'
      : score >= 80 ? (kind === 'chain'
        ? (surface === 'pointed'
          ? 'Those pesukim run together cleanly — now run them again off the bare scroll.'
          : 'Those pesukim run together cleanly from the scroll — try a longer chain.')
        : 'Beautiful — that\'s reading-ready.')
        : 'Keep polishing the weaker pesukim, then run it again.';
  const scoreLabel = assisted ? 'Duet accuracy'
    : kind === 'chain' ? 'Chain accuracy' : kind === 'maftir' ? 'Maftir accuracy'
      : kind === 'haftarah' ? 'Haftarah accuracy'
        : kind === 'passage' ? 'Passage accuracy' : 'Aliyah accuracy';
  $('aliyaResult').innerHTML = `<span class="scorelabel">${scoreLabel}</span> `
    + `<span class="num">${score}</span><span class="ceil"> / 100</span>`
    + `<br><span class="hint">${msg}</span>`;
  renderAliyot();
  renderVerses(); // refresh the chain chips / aliyah cards with the new best
  if (kind !== 'chain') maybePushScopes();
  // Paint the per-word "notes hit" clue LAST, so no earlier render can wipe it,
  // and remember it so a later pane rebuild (toolbar toggle) can re-apply it.
  state._aliyaWordHits = perVerse;
  applyAliyahWordHits(perVerse);
  if (guided) guided.notifyScore({
    kind: kind === 'chain' ? 'chain' : 'whole',
    start: a.start,
    end: a.end,
    n: a.n,
    surface: kind === 'chain' ? surface : null,
    score,
    threshold: ALIYAH_PASS,
    passed: score >= ALIYAH_PASS,
    assisted,
  });
}

// What counts as chanting a whole aliyah / chain / haftarah well enough to move
// on in guided mode. Expert mode has no such gate (it shows the number and lets
// the reader judge), so this lives here rather than in levels.js.
const ALIYAH_PASS = 80;

// Persistent top-of-window stage selector. Any stage is navigable; stages not
// yet unlocked for the current verse are marked, and opening one shows a locked
// page (see renderPractice).
function selectStage(levelId) {
  const wasTranslit = translitOn();
  state.level = levelId;
  state.unitIndex = 0;
  state.divideRank = null; // each stage opens at its own default division
  renderStageBar();
  // The stage decides whether the transliteration is allowed at all, so the
  // toggle has to be re-stated here — and the verse column redrawn when the
  // answer changed, since it carries the aid too.
  syncToggleUI();
  if (translitOn() !== wasTranslit) renderVerses();
  if (state.selectedVerse != null) renderPractice();
}

function renderStageBar() {
  const bar = $('stageBar');
  if (!bar) return;
  const unlocked = state.selectedVerse != null ? store.getVerseLevel(state.slug, state.selectedVerse) : 1;
  const btns = LEVELS.map((l) => {
    const locked = l.id > unlocked;
    const cur = l.id === state.level;
    const short = l.short || l.label;
    return `<button class="stagebtn ${cur ? 'cur' : ''} ${locked ? 'locked' : ''}" data-lvl="${l.id}" title="${l.label}">`
      + `${locked ? '🔒 ' : '✓ '}${l.id}. ${short}</button>`;
  }).join('');
  // Mobile shows this compact <select> instead of the chip row (CSS toggles which
  // is visible); both paths call selectStage so behaviour is identical.
  const opts = LEVELS.map((l) => {
    const locked = l.id > unlocked;
    return `<option value="${l.id}" ${l.id === state.level ? 'selected' : ''}>`
      + `${locked ? '🔒 ' : '✓ '}${l.id}. ${l.label}</option>`;
  }).join('');
  bar.innerHTML = `<span class="label">Stage:</span>${btns}`
    + `<select class="stage-select" id="stageSelect" aria-label="Practice stage">${opts}</select>`;
  bar.querySelectorAll('.stagebtn').forEach((b) => {
    b.addEventListener('click', () => selectStage(parseInt(b.dataset.lvl, 10)));
  });
  const sel = $('stageSelect');
  if (sel) sel.addEventListener('change', () => selectStage(parseInt(sel.value, 10)));
}

const MAQAF = '\u05BE';
const ZOOM_WORDS = 5; // words visible at once in guitar-hero scroll mode
// Gamified pitch feedback: within DEADZONE semitones counts as a perfect hit;
// beyond it the displayed line is pulled toward the target and clamped so it
// stays feasible while still showing the gap.
const DEADZONE = 0.9, MAXDEV = 4, PULL = 0.55;

// Auto-scroll the zoomed timeline so the playhead stays ~70% across (RTL), with
// the upcoming words visible to its left.
function scrollFollow(t01) {
  const sc = $('tlScroll'), inner = $('tlInner');
  if (!sc || !inner || !sc.classList.contains('scrolling')) return;
  const W = inner.clientWidth, visW = sc.clientWidth;
  const x = 8 + (1 - t01) * (W - 8 - 34); // playhead px (LM=8, RM=34, RTL)
  sc.scrollLeft = Math.max(0, Math.min(W - visW, x - visW * 0.7));
}

// In word mode, keep maqaf-joined words together on one page so their internal
// pause/movement is practiced as a unit (they still show as distinct words).
function groupByMaqaf(segs) {
  const groups = [];
  let cur = [];
  segs.forEach((s) => {
    cur.push(s);
    if (!s.token.endsWith(MAQAF)) { groups.push(cur); cur = []; }
  });
  if (cur.length) groups.push(cur);
  return groups;
}

// How coarsely the "sections" stage is cutting the verse right now: the reader's
// choice if they've moved the Divide control, else the stage's default.
function currentDivideRank() {
  const level = levelById(state.level);
  if (level.unit !== 'section') return null;
  return state.divideRank || level.divide;
}

// The coarsest division that still breaks THIS verse into more than one piece.
// A short pasuk has no Etnachta to split at, so asking for halves would hand back
// the whole verse and the stage would teach nothing; fall to the next rank down.
function usableDivideRank(segs, wanted) {
  const ranks = DIVISIONS.map((d) => d.rank).sort((a, b) => a - b);
  const start = ranks.indexOf(wanted);
  for (let i = Math.max(0, start); i < ranks.length; i++) {
    if (splitAtRank(segs, ranks[i]).length > 1) return ranks[i];
  }
  return RANK.COUNT;
}

function currentUnits() {
  const v = state.data.verses[state.selectedVerse - 1];
  const tokens = tokenize(v.text);
  const segs = lineMelody(tokens);
  const level = levelById(state.level);
  if (level.unit === 'word') return groupByMaqaf(segs);
  if (level.unit === 'phrase') return splitPhrases(segs);
  if (level.unit === 'section') return splitAtRank(segs, usableDivideRank(segs, currentDivideRank()));
  return [segs];
}

// A verse-stable key for a multi-word unit: the span of word indices it covers.
// Unlike an ordinal it survives a change of division, so a section's best score
// still belongs to the same stretch of text whether you reached it via halves or
// via clauses.
function unitSpanKey(unitSegs) {
  if (!unitSegs || !unitSegs.length) return null;
  return `${unitSegs[0].index}-${unitSegs[unitSegs.length - 1].index}`;
}

// The accent that closes a unit, named for the UI ("… up to the Etnachta").
function unitCloseName(unitSegs) {
  const last = unitSegs && unitSegs[unitSegs.length - 1];
  return last ? last.name : null;
}

// How many whole-verse phrases start before this unit does. Section takes score
// the phrases they contain, and those bests are filed by verse-wide phrase index.
function phraseOffsetOf(unitSegs) {
  if (!unitSegs || !unitSegs.length || !state.verseSegs.length) return 0;
  const first = unitSegs[0].index;
  const phrases = splitPhrases(state.verseSegs);
  const at = phrases.findIndex((ph) => ph.length && ph[0].index === first);
  return at < 0 ? 0 : at;
}

// The "Divide" control on the sections stage: how big a bite of the verse to
// chant. A division that can't actually split THIS pasuk (no Etnachta in a short
// one, say) is shown greyed rather than hidden, so the hierarchy stays legible.
function divideControlHtml(segs) {
  const active = usableDivideRank(segs, currentDivideRank());
  const btns = DIVISIONS.slice().reverse().map((d) => {
    const n = splitAtRank(segs, d.rank).length;
    const dead = n < 2;
    return `<button class="dv${d.rank === active ? ' on' : ''}" data-rank="${d.rank}"`
      + `${dead ? ' disabled' : ''} title="${d.hint}${dead ? ' (this pasuk has no such division)' : ` — ${n} pieces`}">`
      + `${d.label}</button>`;
  }).join('');
  return `<div class="divide-nav">
    <span class="label" title="How much of the verse to chant at once">Divide:</span>
    <span class="seg" id="divideSeg">${btns}</span>
  </div>`;
}

// Hand a canvas view over to the freshly rendered pane. The views hold a window
// resize listener, so simply constructing new ones — as every re-render used to
// do, and there are ~15 of them (verse, level, divide, zoom, reading size…) —
// left the old ones reachable, still holding their trails and still repainting a
// detached canvas on every resize and rotation. When the element survived the
// render the instance is kept as-is (nothing to rebuild); otherwise the old one
// is released first. Always returns a live view, so `state.view` and friends can
// never be left null for the many call sites that use them unguarded.
function adoptCanvasView(prev, Ctor, el) {
  if (prev && prev.canvas === el) return prev;
  if (prev && prev.destroy) prev.destroy();
  return new Ctor(el);
}

function renderPractice() {
  $('practice').classList.remove('aliyah-fill');
  const v = state.data.verses[state.selectedVerse - 1];
  const level = levelById(state.level);
  // Navigation is free, but a stage not yet unlocked for this verse shows a
  // greyed page explaining the next step.
  const unlocked = store.getVerseLevel(state.slug, state.selectedVerse);
  if (level.id > unlocked) { renderLockedPage(level, unlocked); return; }
  // The hardest level is read from the bare Torah column — but it no longer
  // force-opens the STA"M scroll (that felt jarring, like aliyah mode). Instead
  // it shows the normal note coach with a prominent button to open the scroll on
  // demand (see the .open-stam button + wiring below).
  ensurePitchForVerse(state.selectedVerse); // phase-3: load this pasuk's pitch shard on demand
  ensureRawForVerse(state.selectedVerse); // phase-2: load this pasuk's underlay on demand
  state.verseSegs = verseSegments(state.selectedVerse);
  const units = currentUnits();
  state.units = units;
  state.unitIndex = Math.max(0, Math.min(state.unitIndex, units.length - 1));
  const unitSegs = units[state.unitIndex];
  state.unitSegs = unitSegs;
  state.focusIndex = unitSegs[0] ? unitSegs[0].index : 0;

  const aids = level.aids;
  const renderCtx = aidsForLevel();

  const hasReal = !!verseAudio(state.selectedVerse);

  const chips = [
    chip('Vowels', aids.showVowels),
    chip('Cantillation', aids.showTaamim),
    chip('Scroll font', aids.scroll),
  ].join('');

  const p = $('practice');
  p.innerHTML = `
    <div class="phead">
      <h2>${state.data.book.he} ${verseRefLabel(v, state.selectedVerse)}${verseIndexSuffix(v, state.selectedVerse)}<span class="stagetag">${level.id}. ${level.label}</span></h2>
      <div class="aidchips">${chips}</div>
      ${units.length > 1 ? `<div class="unit-nav">
        <button id="uPrev">◀</button>
        <span class="u-label">${cap(level.unit)} ${state.unitIndex + 1}/${units.length}</span>
        <button id="uNext">▶</button>
      </div>` : ''}
      ${level.unit === 'section' ? divideControlHtml(state.verseSegs) : ''}
      <span class="mode-indicator" id="modeIndicator"></span>
      <label class="readsize" title="Reading size — enlarge the Hebrew, shrink the notation">
        <span class="rs-ico">א</span>
        <input type="range" id="readSize" min="${READ_MIN}" max="${READ_MAX}" step="0.1" value="${state.readScale}" aria-label="Reading size">
      </label>
      ${hasReal ? '<span class="keyshint" title="Tap a word, or keys: ← → next/prev unit · Space play, then hold · , and . step back/forward one word · ↓ record · ↑ sing along · Esc stop">⌨</span>' : ''}
    </div>
    ${units.length > 1 ? `
    <button class="unit-edge unit-edge-next" id="uEdgeNext" aria-label="Next ${level.unit}" title="Next ${level.unit} (swipe left)">‹</button>
    <button class="unit-edge unit-edge-prev" id="uEdgePrev" aria-label="Previous ${level.unit}" title="Previous ${level.unit} (swipe right)">›</button>` : ''}
    <!-- Whole-pasuk advance (shown only in the STA"M Torah-column view). -->
    <button class="pasuk-edge pasuk-edge-next" id="pEdgeNext" aria-label="Next pasuk" title="Next pasuk">‹</button>
    <button class="pasuk-edge pasuk-edge-prev" id="pEdgePrev" aria-label="Previous pasuk" title="Previous pasuk">›</button>
    ${level.unit === 'line' && state.showEnglish && v.en ? `<p class="practice-en">${escapeHtml(v.en)}</p>` : ''}

    ${level.scrollColumn ? `<button id="openStam" class="open-stam" title="Read this pasuk from the bare Torah column">📜 Open the STA&ldquo;M scroll</button>` : ''}

    <div class="topstatus">
      <div class="result" id="result"><span class="hint">${hasReal
        ? 'Hear the real cantor, or use the voice guide, then record your try.'
        : (level.mode === 'listen' ? 'Listen, then record yourself repeating it.' : 'Follow the moving cue and sing along as you record.')}</span></div>
      <div class="livemeter" id="liveMeter" hidden>
        <span class="lm-label" title="Melody/shape scorer (live estimate)">Live melody</span>
        <div class="lm-track"><div class="lm-fill" id="liveMeterFill"></div></div>
        <span class="lm-val"><b id="liveMeterVal">0</b>%</span>
      </div>
      <div class="livemeter" id="liveMeterGh" hidden>
        <span class="lm-label" title="Guitar-Hero note-hit scorer (live estimate)">Live note-hit</span>
        <div class="lm-track"><div class="lm-fill" id="liveMeterGhFill"></div></div>
        <span class="lm-val"><b id="liveMeterGhVal">0</b>%</span>
      </div>
    </div>

    <div class="timeline">
      <div class="cmp-legend">
        <span><span class="swatch coach"></span> coach</span>
        <span><span class="swatch real"></span> recording</span>
        <span><span class="swatch you"></span> you</span>
        <button id="btnAnalysis" class="analysis-toggle ${state.showAnalysis ? 'on' : ''}" aria-pressed="${state.showAnalysis ? 'true' : 'false'}" title="Show or hide the spectrograms &amp; accuracy bars. Hidden, the coaching line fills the pane so slight tone changes stand out.">🔬 Analysis</button>
      </div>
      <div class="tl-scroll" id="tlScroll">
        <div class="tl-inner" id="tlInner">
          <div class="timeline-words hebrew ${aids.scroll ? 'scroll' : ''}" id="timelineWords"></div>
          <div class="canvas-wrap contour-wrap"><canvas class="contour" id="contour"></canvas></div>
          <div class="tl-extras" id="tlExtras">
            <div class="spectro-label">Example spectrogram <span class="hint">— fundamental (white) &amp; harmonics</span></div>
            <div class="canvas-wrap"><canvas class="spectro" id="spectro"></canvas></div>
            <div class="spectro-label">Your voice <span class="hint">— record to compare &amp; match the example</span></div>
            <div class="canvas-wrap"><canvas class="spectro" id="userSpectro"></canvas></div>
          </div>
        </div>
      </div>
    </div>

    <div class="transport">
      ${hasReal ? `<button class="primary" id="btnReal">♪ Hear real chant (verse)</button>` : ''}
      ${hasReal ? `<button id="btnRealWord">♪ Hear this ${level.unit === 'word' ? 'word' : level.unit} (real)</button>` : ''}
      <button class="${hasReal ? '' : 'primary'}" id="btnPlay">${state.drill ? '▶ Sing these words' : '▶ Hear voice guide'}</button>
      ${state.drill ? `<button id="btnRecite" title="Find the same accents in the recorded readings and splice them together. A human voice, but different words — the drill's own words were never recorded.">🎤 Same tropes, real voice</button>` : ''}
      <button id="btnTonic">Give me the tonic</button>
      <button class="warn" id="btnRec">● Record my try</button>
      <button id="btnSing">▶● Sing along</button>
      <span class="transport-scrub">
        <button id="btnStepBack" disabled title="Back one word — key: ,   (while paused, it plays the word you land on)">⟲ Word <kbd>,</kbd></button>
        <button id="btnPause" disabled aria-pressed="false" title="Pause / resume — key: Space">⏸ Pause</button>
        <button id="btnStepFwd" disabled title="Forward one word — key: .">Word ⟳ <kbd>.</kbd></button>
      </span>
      <button id="btnStop" disabled>■ Stop</button>
    </div>

    <div class="accuracy-panel" id="accPanel"></div>
  `;

  if (units.length > 1) {
    $('uPrev').addEventListener('click', () => goToUnit(state.unitIndex - 1, true));
    $('uNext').addEventListener('click', () => goToUnit(state.unitIndex + 1, true));
    // Large edge arrows (mobile): mirror the ◀/▶ nav for thumb reach. In RTL the
    // next unit is to the LEFT, so the left-edge chevron advances.
    const eNext = $('uEdgeNext'), ePrev = $('uEdgePrev');
    if (eNext) eNext.addEventListener('click', () => goToUnit(state.unitIndex + 1, true));
    if (ePrev) ePrev.addEventListener('click', () => goToUnit(state.unitIndex - 1, true));
  }
  const divideSeg = $('divideSeg');
  if (divideSeg) divideSeg.querySelectorAll('.dv').forEach((b) => {
    b.addEventListener('click', () => {
      state.divideRank = parseInt(b.dataset.rank, 10);
      state.unitIndex = 0;
      renderPractice();
    });
  });
  // Pasuk-advance arrows (STA"M view): left = next pasuk (RTL), right = previous.
  const pNext = $('pEdgeNext'), pPrev = $('pEdgePrev');
  if (pNext) pNext.addEventListener('click', () => goToVerse(1));
  if (pPrev) pPrev.addEventListener('click', () => goToVerse(-1));
  // Large call-to-action (level 8): open the full STA"M scroll on demand rather
  // than forcing it on. The scroll's own ✕ closes it back to this coach.
  const openStam = $('openStam');
  if (openStam) openStam.addEventListener('click', () => {
    state.scrollView = true; savePanePrefs(); syncToggleUI(); renderVerses(); maybeShowRotate();
  });
  wirePracticeSwipe();

  // Timeline width. Give every word room at the current reading size; when the
  // content is wider than the pane it scrolls (guitar-hero) and the playhead
  // auto-follows. The zoom toggle just forces a minimum spread. Must be set
  // BEFORE creating the canvas views (they read their box on construction).
  const tlScroll = $('tlScroll');
  const tlInner = $('tlInner');
  const visW = tlScroll.clientWidth || 800;
  const fpx = readingFontPx(unitSegs.length);
  // Room per word at this size. A transliterated word is a good deal wider than
  // the Hebrew it sits under ("vachatzerot" against וַחֲצֵרֹת), so the aid buys
  // itself more room and lets the row scroll rather than letting neighbouring
  // Latin lines run into each other.
  const perWord = translitOn(level) ? 5.6 : 4.0;
  const needW = Math.round(unitSegs.length * fpx * perWord);
  const zoomW = (level.unit === 'line' && state.scrollZoom)
    ? Math.round(visW * Math.max(1, unitSegs.length / ZOOM_WORDS)) : 0;
  const useW = Math.max(visW, needW, zoomW);
  const scrolling = useW > visW + 2;
  tlInner.style.width = scrolling ? useW + 'px' : '100%';
  tlScroll.classList.toggle('scrolling', scrolling);

  // Collapse the analysis panels (spectrograms + accuracy bars) unless the user
  // has opted in. On desktop this lets the coaching contour flex-fill the pane;
  // on mobile the class is inert (the CSS collapse is desktop-only).
  p.classList.toggle('hide-analysis', !state.showAnalysis);
  // Whole-verse (line) levels have no word/phrase units to step through, so the
  // big edge arrows advance between PESUKIM there (via the .pasuk-edge arrows) —
  // mirroring the STA"M scroll's verse nav so full-verse modes keep left/right.
  p.classList.toggle('unit-line', level.unit === 'line');

  // Notation heights. The spectrograms shrink as the reading grows (the notes
  // cost the space, not the words). On desktop the coaching contour instead
  // flex-fills the pane (CSS), so we clear its inline height and let the box
  // drive the canvas; on mobile it keeps the computed fixed height.
  const nh = noteHeights();
  $('contour').style.height = isDesktopLayout() ? '' : nh.contour + 'px';
  $('spectro').style.height = nh.spectro + 'px';
  $('userSpectro').style.height = nh.spectro + 'px';

  // Canvas + coach line (note steps derived from the recording).
  state.view = adoptCanvasView(state.view, ContourView, $('contour'));
  state.spectro = adoptCanvasView(state.spectro, Spectrogram, $('spectro'));
  state.userSpectro = adoptCanvasView(state.userSpectro, Spectrogram, $('userSpectro'));
  const coach = buildCoach(unitSegs);
  state.coach = coach;
  const closeName = unitCloseName(unitSegs);
  const modeName = level.unit === 'word' ? 'Single-word focus'
    : level.unit === 'phrase' ? 'Phrase timeline'
      : level.unit === 'section'
        ? `${divisionByRank(usableDivideRank(state.verseSegs, currentDivideRank())).label.replace(/s$/, '')}${closeName ? ` — up to the ${closeName.en}` : ''}`
        : 'Whole-verse timeline (piano-trope)';
  const zoomBtn = level.unit === 'line'
    ? ` <button id="btnZoom" class="zoomtoggle">${state.scrollZoom ? '↔ Fit whole line' : '🎸 Scroll (zoom ' + ZOOM_WORDS + ' words)'}</button>` : '';
  $('modeIndicator').innerHTML = `<span class="mode-pill">${modeName}</span>${zoomBtn}`;
  if (zoomBtn) {
    $('btnZoom').addEventListener('click', () => { state.scrollZoom = !state.scrollZoom; renderPractice(); });
  }
  if (coach) {
    state.targetPoints = coach.points;
    state.view.setCoach({ steps: coach.steps, raw: coach.raw, wordBounds: coach.wordBounds });
    renderStretchedWords($('timelineWords'), coach, renderCtx, unitSegs);
  } else {
    state.targetPoints = [];
    $('timelineWords').innerHTML = unitSegs.map((s, i) => wordSpan(s.token, s, renderCtx, i)).join(' ');
  }

  if (hasReal) {
    $('btnReal').addEventListener('click', playRealChant);
    $('btnRealWord').addEventListener('click', playUnit);
  }
  wireTimelineWordClicks(unitSegs, hasReal);
  const btnRecite = $('btnRecite');
  if (btnRecite) btnRecite.addEventListener('click', playRecitation);
  $('btnPlay').addEventListener('click', playTarget);
  $('btnTonic').addEventListener('click', () => playTone(state.tonicHz, 1.2));
  $('btnRec').addEventListener('click', () => startRecording());
  $('btnSing').addEventListener('click', () => startRecording({ singAlong: true }));
  $('btnPause').addEventListener('click', togglePause);
  $('btnStepBack').addEventListener('click', () => stepWord(-1));
  $('btnStepFwd').addEventListener('click', () => stepWord(1));
  $('btnStop').addEventListener('click', stopAll);
  syncTransportUI();
  const btnAnalysis = $('btnAnalysis');
  if (btnAnalysis) btnAnalysis.addEventListener('click', toggleAnalysis);
  const readSize = $('readSize');
  if (readSize) {
    // Live text resize while dragging (no rebuild), then re-render on release so
    // the note canvases are re-created crisply at their new heights.
    readSize.addEventListener('input', (e) => applyReadScale(parseFloat(e.target.value), false));
    readSize.addEventListener('change', (e) => applyReadScale(parseFloat(e.target.value), true));
  }

  renderAccuracyPanel();
  wireAccPanel();
  applyHighlight();
  // Start a scrolling line at its beginning (rightmost, RTL).
  if (scrolling) tlScroll.scrollLeft = tlScroll.scrollWidth - tlScroll.clientWidth;
  maybeShowRotate();
}

// The accuracy panel shows one of two distinct views depending on the stage:
//  - word/phrase stages (1-3): every word of the verse with its best per-word
//    ACCURACY, so the spread between the strongest and weakest words is obvious.
//  - line stages (4+): a horizontal gradient bar spanning the verse, each
//    section (word) colored by its best accuracy and sized by its time span, so
//    you can see at a glance which stretch of the pasuk needs work.
function renderAccuracyPanel() {
  const el = $('accPanel');
  if (!el) return;
  const segs = state.verseSegs || [];
  if (!segs.length) { el.innerHTML = ''; return; }
  const v = state.selectedVerse;
  const level = levelById(state.level);
  const layout = verseWordLayout(v, segs);
  const wordScores = store.getWordScores(state.slug, v);
  const phraseScores = store.getPhraseScores(state.slug, v);
  const modeScores = store.getVerseModeScores(state.slug, v);

  // Bar 1 — one meter per WORD.
  const wordSegs = segs.map((s, i) => ({
    t0: layout[i].t0, t1: layout[i].t1, score: wordScores[s.index] || 0, title: s.token,
    kind: 'word', idx: s.index,
  }));

  // Bar 2 — one meter per PHRASE (fewer divisions).
  const phrases = splitPhrases(segs);
  const phraseSegs = phrases.map((ph, pi) => {
    const first = segs.indexOf(ph[0]);
    const last = segs.indexOf(ph[ph.length - 1]);
    return { t0: layout[first].t0, t1: layout[last].t1, score: phraseScores[pi] || 0, title: `Phrase ${pi + 1}`, kind: 'phrase', idx: pi };
  });

  const cur = level.unit;
  const modelName = state.scoreModel === 'gh' ? 'Note-hit' : 'Melody';
  el.innerHTML =
      `<div class="acc-model-badge hint">New takes are scored &amp; saved with the <b>${modelName}</b> model (set by the <b>Scoring</b> toggle above); bars show your saved bests.</div>`
    + accTextRow(segs, layout)
    + scoreBar('Words', wordSegs, { active: cur === 'word', hint: 'one bar per word — click to practice a word' })
    + scoreBar('Phrases', phraseSegs, { active: cur === 'phrase', hint: 'one bar per phrase — click to practice a phrase' })
    + verseGradientRow(segs, layout, cur === 'line')
    + renderSkillBadges(modeScores);
}

// A Hebrew word row aligned over the bars (same time-span geometry), so it's
// clear which stretch of the pasuk each bar segment corresponds to. Each word is
// clickable to jump straight into practicing it.
function accTextRow(segs, layout) {
  const aids = aidsForLevel();
  let cells = '';
  for (let i = 0; i < segs.length; i++) {
    const w = Math.max(0.01, layout[i].t1 - layout[i].t0);
    cells += `<span class="aw" data-kind="word" data-idx="${segs[i].index}" style="flex:${w.toFixed(4)} 1 0"`
      + ` title="${escapeHtml(segs[i].token)} — click to practice">${escapeHtml(renderWord(segs[i].token, aids))}</span>`;
  }
  return `<div class="acc-words hebrew">${cells}</div>`;
}

// Best per-word score across ALL full-verse runs (any skill), so the whole-verse
// gradient/overlay reflects your best full-pasuk shape even if you've mostly
// practiced at a harder stage than the base. Returns a { globalWordIndex:score }
// map, or null if no full-verse take has been recorded.
function bestVerseProfile(verseN) {
  const profs = store.getVerseProfiles(state.slug, verseN);
  const keys = Object.keys(profs);
  if (!keys.length) return null;
  const merged = {};
  for (const k of keys) {
    const p = (profs[k] && profs[k].profile) || {};
    for (const gi of Object.keys(p)) {
      if (p[gi] > (merged[gi] || 0)) merged[gi] = p[gi];
    }
  }
  return Object.keys(merged).length ? merged : null;
}

// The highest whole-verse accuracy recorded across any skill (for the bar label).
function bestVerseScore(verseN) {
  const ms = store.getVerseModeScores(state.slug, verseN);
  return Math.max(0, ...VERSE_MODES.map((m) => ms[m.key] || 0));
}

// The whole-verse bar (one "division") rendered as a left-to-right gradient of
// the good/bad sections captured during your best full-verse runs, so you can
// see where the whole-pasuk performance held up and where it slipped.
function verseGradientRow(segs, layout, active) {
  const scoreVal = bestVerseScore(state.selectedVerse);
  const profile = bestVerseProfile(state.selectedVerse);
  let inner = '';
  if (profile) {
    const vals = segs.map((s) => profile[s.index]).filter((x) => x != null && x > 0);
    if (vals.length) {
      const [lo, hi] = adaptiveRange(vals);
      const stops = [];
      segs.forEach((s, i) => {
        const sc = profile[s.index];
        if (sc == null || sc <= 0) return;
        stops.push({ c: (layout[i].t0 + layout[i].t1) / 2, col: rampColor(sc, lo, hi, true) });
      });
      stops.sort((a, b) => a.c - b.c);
      // RTL: 'to left' puts 0% on the right (verse start). Pad both ends solid.
      const parts = [`${stops[0].col} 0%`]
        .concat(stops.map((st) => `${st.col} ${(st.c * 100).toFixed(1)}%`))
        .concat([`${stops[stops.length - 1].col} 100%`]);
      inner = `<div class="secseg clickable" data-kind="verse" style="flex:1 1 0" title="Whole verse: ${scoreVal}/100 — click to practice">`
        + `<div class="secfill" style="height:100%;background:linear-gradient(to left, ${parts.join(', ')})"></div>`
        + `${scoreVal > 0 ? `<span class="seclbl">${scoreVal}</span>` : ''}</div>`;
    }
  }
  if (!inner) {
    inner = `<div class="secseg clickable" data-kind="verse" style="flex:1 1 0" title="Whole verse: ${scoreVal > 0 ? scoreVal + '/100' : 'not yet practiced'} — click to practice">`
      + (scoreVal > 0
        ? `<div class="secfill" style="height:${Math.max(8, scoreVal)}%;background:${rampColor(scoreVal, 0, 100, true)}"></div><span class="seclbl">${scoreVal}</span>`
        : '<div class="secfill empty"></div>')
      + '</div>';
  }
  return `<div class="scorebar-row${active ? ' active' : ''}">`
    + '<div class="sb-label">Whole verse <span class="hint">— good &amp; bad sections from your best full-verse run</span></div>'
    + `<div class="section-bar">${inner}</div></div>`;
}

// Verse word layout normalized to 0..1 across the verse, from the recorded word
// times (falls back to equal spans), so the three bars share the same geometry
// at every stage regardless of the current coach window.
function verseWordLayout(verseN, segs) {
  const n = segs.length;
  const pv = pitchVerse(verseN);
  const times = segs.map((s) => {
    const pw = pv && pv.words.find((w) => w.i === s.index);
    return pw && pw.start != null ? pw : null;
  });
  const known = times.filter(Boolean);
  if (known.length < 2) return segs.map((_, i) => ({ t0: i / n, t1: (i + 1) / n }));
  const start = known[0].start, end = known[known.length - 1].end, dur = (end - start) || 1;
  return segs.map((_, i) => times[i]
    ? { t0: (times[i].start - start) / dur, t1: (times[i].end - start) / dur }
    : { t0: i / n, t1: (i + 1) / n });
}

// A labeled bar-chart meter: each division's HEIGHT = its best score, WIDTH =
// its time span, COLOR = adaptive ramp across this bar's own scores (max
// contrast within the layer). Divisions decrease from words -> phrases -> verse.
function scoreBar(label, segs, opts = {}) {
  const [lo, hi] = adaptiveRange(segs.map((s) => s.score));
  let bars = '';
  for (const s of segs) {
    const w = Math.max(0.01, s.t1 - s.t0);
    const sc = s.score;
    const inner = sc > 0
      ? `<div class="secfill" style="height:${Math.max(8, sc)}%;background:${rampColor(sc, lo, hi, true)}"></div>`
        + `${w > 0.08 || opts.single ? `<span class="seclbl">${sc}</span>` : ''}`
      : `<div class="secfill empty"></div>`;
    const data = s.kind ? ` data-kind="${s.kind}" data-idx="${s.idx}"` : '';
    bars += `<div class="secseg${s.kind ? ' clickable' : ''}"${data} style="flex:${w.toFixed(4)} 1 0" title="${escapeHtml(s.title + ': ' + (sc > 0 ? sc + '/100' : 'not yet practiced'))}">${inner}</div>`;
  }
  return `<div class="scorebar-row${opts.active ? ' active' : ''}">`
    + `<div class="sb-label">${label}${opts.hint ? ` <span class="hint">${opts.hint}</span>` : ''}</div>`
    + `<div class="section-bar">${bars}</div></div>`;
}

// The whole-verse "skills": one independent accuracy badge per handicap earned
// over and above the base full-verse score. Colored by an adaptive ramp across
// the handicap scores so the weakest skill (the one to improve) stands out.
function renderSkillBadges(modeScores) {
  const handicaps = VERSE_MODES.filter((m) => m.key !== 'base');
  const unlocked = store.getVerseLevel(state.slug, state.selectedVerse);
  const [lo, hi] = adaptiveRange(handicaps.map((m) => modeScores[m.key] || 0));
  const badges = handicaps.map((m) => {
    const sc = modeScores[m.key] || 0;
    const locked = m.level > unlocked;
    const dot = sc > 0 ? rampColor(sc, lo, hi, true) : (locked ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.12)');
    const val = sc > 0 ? sc : (locked ? '🔒' : '–');
    const title = `${m.label}: ${sc > 0 ? sc + '/100' : (locked ? 'locked — reach stage ' + m.level : 'not yet attempted')} — click to practice`;
    return `<div class="skill clickable${sc > 0 ? ' earned' : ''}${locked ? ' locked' : ''}" data-kind="skill" data-level="${m.level}" title="${escapeHtml(title)}">`
      + `<span class="sk-dot" style="background:${dot}"></span>`
      + `<span class="sk-name">${m.label}</span><span class="sk-val">${val}</span></div>`;
  }).join('');
  return `<div class="scorebar-row"><div class="sb-label">Verse skills <span class="hint">— each dropped aid is its own accuracy score to raise</span></div>`
    + `<div class="skills">${badges}</div></div>`;
}

// Score each phrase inside a whole-verse take (used to keep phrase bests current
// when singing the full line). Returns an array indexed by phrase order.
function scorePhrasesInLine(trail, coach, unitSegs) {
  if (!coach || !coach.wordBounds) return [];
  const bounds = coach.wordBounds;
  return splitPhrases(unitSegs).map((ph) => {
    const idxs = ph.map((seg) => unitSegs.indexOf(seg)).filter((wi) => wi >= 0 && wi < bounds.length);
    if (!idxs.length) return 0;
    const a = Math.min(...idxs), b = Math.max(...idxs);
    const t0 = bounds[a], t1 = b + 1 < bounds.length ? bounds[b + 1] : 1.0001;
    const uS = trail.filter((s) => s.t >= t0 && s.t < t1);
    const phSteps = coach.steps.filter((s) => s.w >= a && s.w <= b);
    return phSteps.length ? Math.round(scoreSteps(uS, phSteps).active) : 0;
  });
}

// Where a word stops in its recording. Usually the next word's onset — but a
// reader recorded live sometimes fumbles a word and starts it again, and the
// labeller (scripts/label.html) cuts those stretches out by ending the word
// before them early. See scripts/onsettrack.py.
function wordEndTime(info, k) {
  const cut = info.ends && info.ends[k];
  return cut != null ? cut : null;
}

// Compute the mp3 time range for a single display token within a verse, using
// the Masoretic word onsets (maqaf-joined tokens span multiple onsets).
function wordTimeRange(verseN, tokenIndex) {
  const info = verseAudio(verseN);
  if (!info) return null;
  const onsets = info.onsets;
  if (tokenIndex < 0 || tokenIndex >= onsets.length) return null;
  const start = onsets[tokenIndex];
  const cut = wordEndTime(info, tokenIndex);
  let end;
  if (cut != null) end = cut;
  else if (tokenIndex + 1 < onsets.length) end = onsets[tokenIndex + 1];
  else if (info.end != null) end = info.end;
  else {
    const gaps = [];
    for (let i = 1; i < onsets.length; i++) gaps.push(onsets[i] - onsets[i - 1]);
    const avg = gaps.length ? gaps.reduce((x, y) => x + y, 0) / gaps.length : 1.0;
    end = start + Math.max(0.6, avg);
  }
  return { file: info.file, start, end };
}

// Focus a single word: switch to single-word mode, load that word's coach line
// and spectrogram window, and play just that word from the recording.
function playWord(seg) {
  if (!seg) return;
  const range = wordTimeRange(state.selectedVerse, seg.index);
  if (!range) return;
  state.focusIndex = seg.index;
  stopPlayback();
  stopVerseAudio();
  state.playingReal = true;
  state.spectro.clearPlot();
  if (state.view) state.view.clearReal(); // reset the green detected-tone line on replay

  // Rebuild the view for this single word.
  state.unitSegs = [seg];
  const coach = buildCoach([seg]);
  state.coach = coach;
  if (coach) {
    state.targetPoints = coach.points;
    state.view.setCoach({ steps: coach.steps, raw: coach.raw, wordBounds: coach.wordBounds });
    renderStretchedWords($('timelineWords'), coach, aidsForLevel(), [seg]);
    wireTimelineWordClicks([seg], true);
  }
  if ($('modeIndicator')) $('modeIndicator').innerHTML = `<span class="mode-pill">Single-word focus</span> <span class="hint">— ${seg.name.he} · ${seg.name.en}</span>`;
  $('btnStop').disabled = false;
  $('result').innerHTML = `<span class="hint">Playing <b>${seg.name.he} · ${seg.name.en}</b> from the recording…</span>`;

  const tonic = coach ? coach.tonicHz : 200;
  playSegment(range.file, range.start, range.end, {
    onProgress: (t01) => { state.view.setPlayhead(t01); highlightWord(0); },
    onAnalysis: (a) => onRealAnalysis(a, tonic),
    onEnd: onRealEnd,
    onError: onRealError,
  });
}

function aidsForLevel() {
  const a = levelById(state.level).aids;
  return { showVowels: a.showVowels, showTaamim: a.showTaamim, scroll: a.scroll };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Live analysis: feed the time-aligned spectrogram and draw the recording's
// pitch (green), in semitones relative to the verse tonic so it overlays the
// coach note steps.
function onRealAnalysis({ t01, hz, freq, sampleRate, fftSize }, tonicHz) {
  if (state.spectro) state.spectro.pushAt(t01, freq, sampleRate, fftSize, hz > 0 ? hz : 0);
  if (hz > 0 && tonicHz) {
    let st = 12 * Math.log2(hz / tonicHz);
    while (st > 12) st -= 12;
    while (st < -12) st += 12;
    state.view.pushReal(t01, st);
  }
}

function onRealEnd() {
  state.playingReal = false;
  resetTransport();
  document.querySelectorAll('.verse.active .w, #timelineWords .w, #scrollVerses .sw').forEach((w) => w.classList.remove('cur'));
  if (state.view) state.view.setPlayhead(null);
  $('btnStop').disabled = true;
  $('result').innerHTML = '<span class="hint">Green = the recording\u2019s pitch; the colored bars are the coach note steps. Now record your try.</span>';
}

function onRealError() {
  state.playingReal = false;
  $('result').innerHTML = '<span class="hint">Could not play audio (tap the button again to allow playback).</span>';
}

// Play the recorded cantor's chant of the whole verse in verse mode, with
// karaoke word highlighting and time-aligned spectrogram + pitch overlay.
function playRealChant() {
  const info = verseAudio(state.selectedVerse);
  if (!info) return;
  // Ensure we're showing the whole-verse coach window.
  const verseSegs = verseSegments(state.selectedVerse);
  state.unitSegs = verseSegs;
  const coach = buildCoach(verseSegs);
  state.coach = coach;
  stopPlayback();
  stopVerseAudio();
  state.playingReal = true;
  if (state.spectro) state.spectro.clearPlot();
  if (state.view) state.view.clearReal(); // reset the green detected-tone line on replay
  if (coach) {
    state.targetPoints = coach.points;
    state.view.setCoach({ steps: coach.steps, raw: coach.raw, wordBounds: coach.wordBounds });
    renderStretchedWords($('timelineWords'), coach, aidsForLevel(), verseSegs);
    wireTimelineWordClicks(verseSegs, true);
  }
  if ($('modeIndicator')) $('modeIndicator').innerHTML = '<span class="mode-pill">Whole-verse timeline (piano-trope)</span>';
  const tonic = coach ? coach.tonicHz : 200;
  $('btnStop').disabled = false;
  resetTransport();
  syncTransportUI();
  $('result').innerHTML = '<span class="hint">Playing the recorded chant of the whole verse… Space holds it, <b>,</b> / <b>.</b> step a word.</span>';
  playSegment(info.file, info.start, info.end, {
    onProgress: (t01) => {
      state.view.setPlayhead(t01);
      highlightWord(wordAtTime(coach, t01));
      scrollFollow(t01);
    },
    onAnalysis: (a) => onRealAnalysis(a, tonic),
    onEnd: onRealEnd,
    onError: onRealError,
  });
}

// ---------------------------------------------------------------------------
// A real recitation of a trope sequence that was never recorded
//
// Nobody has ever chanted "shalom" with a pazer on it, so the drills have no
// recording of their own. But the tune belongs to the accent, not the word, and
// the bundled readings hold thousands of recorded, word-aligned instances of the
// same accents. So instead of synthesizing, we search the corpus
// (data/trope-index.json) for the drill's accent sequence and splice the cantor's
// own voice together — greedily taking the longest runs that match, so the seams
// land between phrases instead of between every word. The words that come out are
// not the drill's words; the melody is exactly the drill's melody.
// ---------------------------------------------------------------------------

let _tropeIndex, _tropeIndexPromise;

function loadTropeIndex() {
  if (_tropeIndex !== undefined) return Promise.resolve(_tropeIndex);
  if (!_tropeIndexPromise) {
    _tropeIndexPromise = fetch('data/trope-index.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => {
        if (doc) {
          // One pass to bucket every recorded word by the accent it carries, so a
          // search only walks candidates that could possibly match.
          const byAccent = new Map();
          doc.readings.forEach((rd, ri) => rd.verses.forEach((v, vi) => {
            v.a.forEach((code, wi) => {
              let list = byAccent.get(code);
              if (!list) byAccent.set(code, (list = []));
              list.push([ri, vi, wi]);
            });
          }));
          doc.byAccent = byAccent;
          // A splice can come from any reading in the corpus, including one
          // whose recording was cut, so those files need their cuts too.
          doc.readings.forEach((rd) => registerAudioCuts({ verses: rd.verses }));
        }
        _tropeIndex = doc;
        return doc;
      })
      .catch(() => { _tropeIndex = null; return null; });
  }
  return _tropeIndexPromise;
}

// The accent a segment carries, in the index's encoding (0 = Sof Pasuk, -1 = none).
function accentCodeOf(seg) {
  if (!seg) return -1;
  if (seg.isSofPasuk || seg.taam === 'sof') return 0;
  return seg.taam == null ? -1 : seg.taam;
}

// Cover the unit's accent sequence with as few slices of real audio as possible.
// Anything the corpus can't supply comes back as a `synth` chunk.
function findRecitation(unitSegs, doc) {
  const target = unitSegs.map(accentCodeOf);
  const plan = [];
  let i = 0;
  while (i < target.length) {
    let best = null;
    const candidates = doc.byAccent.get(target[i]) || [];
    for (const [ri, vi, wi] of candidates) {
      const a = doc.readings[ri].verses[vi].a;
      let k = 0;
      while (i + k < target.length && wi + k < a.length && a[wi + k] === target[i + k]) k++;
      if (!best || k > best.k) best = { ri, vi, wi, k };
      if (best.k === target.length - i) break; // nothing could beat a full match
    }
    if (!best || !best.k) { plan.push({ kind: 'synth', at: i, count: 1 }); i += 1; }
    else { plan.push({ kind: 'real', at: i, count: best.k, ...best }); i += best.k; }
  }
  return plan;
}

// The audio window for one spliced chunk, plus where each of its words begins.
function recitationSlice(doc, chunk) {
  const v = doc.readings[chunk.ri].verses[chunk.vi];
  const start = v.onsets[chunk.wi];
  const lastIdx = chunk.wi + chunk.count;
  const cut = wordEndTime(v, lastIdx - 1);
  const end = cut != null ? cut
    : lastIdx < v.onsets.length ? v.onsets[lastIdx]
      : (v.end != null ? v.end : start + chunk.count * 0.8);
  return { verse: v, reading: doc.readings[chunk.ri], start, end: Math.max(end, start + 0.2) };
}

function recitationSourceLabel(doc, plan) {
  const real = plan.filter((c) => c.kind === 'real');
  const synth = plan.length - real.length;
  const words = real.reduce((n, c) => n + c.count, 0);
  const total = plan.reduce((n, c) => n + c.count, 0);
  return `${words} of ${total} words from the recorded chant in ${real.length} splice${real.length === 1 ? '' : 's'}`
    + (synth ? `; ${synth} synthesized (no recording of that accent exists)` : '');
}

// Re-lay the coach on the timing of the audio that is about to play, and show the
// words that are actually being sung. Without this the reader watches their own
// drill words above bars spaced by nominal durations while a different verse
// plays at its own pace — everything drifts, and the accents look wrong even
// though they are right.
function installRecitationView(plan, doc, unitSegs) {
  const real = [];      // per target word: the recorded word and how long it lasts
  for (const chunk of plan) {
    if (chunk.kind !== 'real') { real.push(null); continue; }
    const v = doc.readings[chunk.ri].verses[chunk.vi];
    for (let j = 0; j < chunk.count; j++) {
      const i = chunk.wi + j;
      const from = v.onsets[i];
      const to = wordEndTime(v, i)
        ?? (i + 1 < v.onsets.length ? v.onsets[i + 1] : (v.end != null ? v.end : from + 0.9));
      real.push({ token: (v.w && v.w[i]) || '', dur: Math.max(0.25, to - from) });
    }
  }
  // Keep each segment's accent, colour and name (they are the drill's), but show
  // the recorded word in place of the drill's invented one.
  const shown = unitSegs.map((seg, i) => (real[i] && real[i].token
    ? { ...seg, token: real[i].token } : seg));
  const coach = buildSyntheticCoach(shown, (i) => real[i] && real[i].dur);
  state.coach = coach;
  state.unitSegs = shown;
  if (coach) {
    state.targetPoints = coach.points;
    state.view.setCoach({ steps: coach.steps, raw: coach.raw, wordBounds: coach.wordBounds });
    renderStretchedWords($('timelineWords'), coach, aidsForLevel(), shown);
  }
  return coach;
}

async function playRecitation() {
  const unitSegs = state.unitSegs;
  if (!unitSegs || !unitSegs.length) return;
  stopAll();
  const btn = $('btnRecite');
  if (btn) { btn.disabled = true; btn.textContent = '… finding a recitation'; }
  $('result').innerHTML = '<span class="hint">Searching the recorded readings for this trope sequence…</span>';
  const doc = await loadTropeIndex();
  if (btn) { btn.disabled = false; btn.textContent = '♪ Hear it chanted for real'; }
  if (!doc || !doc.readings.length) {
    $('result').innerHTML = '<span class="hint">No recorded readings are available to splice from.</span>';
    return;
  }
  const plan = findRecitation(unitSegs, doc);
  installRecitationView(plan, doc, unitSegs);
  const runId = (state._recitationId = (state._recitationId || 0) + 1);
  state.playingReal = true;
  if (state.spectro) state.spectro.clearPlot();
  if (state.view) state.view.clearReal();
  $('btnStop').disabled = false;
  resetTransport();
  syncTransportUI();
  const summary = recitationSourceLabel(doc, plan);

  let ci = 0;
  const next = () => {
    if (state._recitationId !== runId) return;      // superseded or stopped
    if (ci >= plan.length) {
      state.playingReal = false;
      highlightWord(-1);
      if (state.view) state.view.setPlayhead(null);
      $('btnStop').disabled = true;
      resetTransport();
      $('result').innerHTML = `<span class="hint">That is the real chant of this trope sequence — ${summary}. `
        + 'The words on screen are the recorded ones, not the drill\u2019s — same accents, same tune. '
        + '<button id="btnBackToDrill" class="linkish">↩ back to the drill\u2019s words</button></span>';
      const back = $('btnBackToDrill');
      if (back) back.addEventListener('click', () => renderPractice());
      return;
    }
    const chunk = plan[ci++];
    // Position the playhead inside the word too, so it glides with the audio
    // rather than jumping a word at a time.
    const cue = (j, frac) => {
      const i = chunk.at + j;
      highlightWord(i);
      const b = state.coach && state.coach.wordBounds;
      if (state.view && b && b[i] != null) {
        const t1 = i + 1 < b.length ? b[i + 1] : 1;
        const t = b[i] + Math.min(1, Math.max(0, frac || 0)) * (t1 - b[i]);
        state.view.setPlayhead(t);
        scrollFollow(t);
      }
    };
    if (chunk.kind === 'synth') {
      const seg = state.unitSegs[chunk.at];
      cue(0);
      $('result').innerHTML = `<span class="hint">Synthesized — <b>${seg.name.en}</b> is not recorded anywhere in the readings. (${summary})</span>`;
      const one = buildSyntheticCoach([seg]);
      singSteps(one.steps, { tonicHz: state.tonicHz, durationSec: one.dur, onEnd: next });
      return;
    }
    const { verse, reading, start, end } = recitationSlice(doc, chunk);
    const span = (end - start) || 1;
    $('result').innerHTML = `<span class="hint">Real chant · <b>${escapeHtml(reading.label)} ${verse.ref}</b>`
      + ` — ${chunk.count} word${chunk.count === 1 ? '' : 's'}. (${summary})</span>`;
    cue(0);
    playSegment(verse.file, start, end, {
      onProgress: (t01) => {
        const t = start + t01 * span;
        let j = 0;
        for (let x = 0; x < chunk.count; x++) if (t >= verse.onsets[chunk.wi + x]) j = x;
        const from = verse.onsets[chunk.wi + j];
        const to = wordEndTime(verse, chunk.wi + j)
          ?? (chunk.wi + j + 1 < verse.onsets.length ? verse.onsets[chunk.wi + j + 1] : end);
        cue(j, (t - from) / ((to - from) || 1));
      },
      onEnd: next,
      onError: next,
    });
  };
  next();
}

// Which word index is active at normalized time t01 (using coach word bounds).
function wordAtTime(coach, t01) {
  if (!coach) return 0;
  const b = coach.wordBounds;
  let idx = 0;
  for (let i = 0; i < b.length; i++) if (t01 >= b[i]) idx = i;
  return idx;
}

function chip(label, on) {
  return `<span class="chip ${on ? 'on' : 'off'}">${on ? '✓' : '✕'} ${label}</span>`;
}

// A single color-coded word span carrying its trope + family for highlighting.
// An optional score paints a graduated heatmap background (per-word accuracy).
function wordSpan(token, seg, ctx, wi, score, lo, hi) {
  const taam = seg.taam == null ? 'none' : seg.taam;
  const col = lo != null && hi != null ? rampColor(score, lo, hi) : scoreColor(score);
  const bg = score != null && score > 0 ? `;background:${col}` : '';
  const title = score != null && score > 0 ? ` title="${score}/100"` : '';
  const mode = state.colorMode;
  const textColor = mode === 'full' ? seg.color : INK_GREY;
  const inner = mode === 'trope'
    ? renderWordTropeColored(token, ctx, seg.color)
    : escapeHtml(renderWord(token, ctx));
  return `<span class="w" data-wi="${wi}" data-taam="${taam}" data-fam="${seg.familyId}"${title}`
    + ` style="color:${textColor}${bg}">${stackTranslit(inner, token)}</span>`;
}

// Put the Latin line under a word, if the aid is on. The Hebrew keeps its own
// row so the trope colouring, the score heatmap and the karaoke highlight all
// still address the word as one unit — the transliteration rides along with it
// rather than being a second, separately-positioned line of text.
//
// Gated on translitOn() rather than on the caller's render context: unlike the
// vowels and the te'amim — which the left column shows on the reader's say-so
// whatever stage the practice pane is at — this aid is capped by the stage
// EVERYWHERE, or the bare-text stages could simply be read off the column
// beside them.
function stackTranslit(inner, token) {
  if (!translitOn()) return inner;
  const latin = transliterate(token);
  if (!latin) return inner;
  return `<span class="wtl-stack"><span class="wtl-he">${inner}</span>`
    + `<span class="wtl" dir="ltr" lang="en">${escapeHtml(latin)}</span></span>`;
}

// Render a word as HTML where ONLY the cantillation mark(s) carry the trope
// colour, leaving the consonants + vowels in the neutral word colour. Used by
// the "Trope only" colour mode. Falls back to plain text where there are no
// marks to colour (scroll font, or with cantillation hidden).
//
// We can't just wrap each te'am in its own coloured <span>: a combining mark
// alone in an element is shaped in isolation, so the browser renders it on a
// dotted-circle placeholder and loses its proper positioning. Instead we stack
// two fully-shaped copies of the word — a coloured copy underneath, and a grey
// copy on top with the te'amim stripped out. The te'amim are zero-width
// combining marks, so removing them doesn't shift any letter or vowel: the grey
// layer covers its coloured twin exactly, leaving only the coloured cantillation
// marks (which exist solely in the bottom layer) peeking through.
function renderWordTropeColored(raw, ctx, color) {
  if (ctx.scroll || !ctx.showTaamim) return escapeHtml(renderWord(raw, ctx));
  const pointed = ctx.showVowels ? raw : stripNikud(raw);
  const noTaam = stripTaamim(pointed);
  // If there's nothing to strip, there are no accents to colour — render plainly.
  if (noTaam === pointed) return escapeHtml(pointed);
  return `<span class="tc">`
    + `<span class="tc-mark" style="color:${color}">${escapeHtml(pointed)}</span>`
    + `<span class="tc-base" aria-hidden="true">${escapeHtml(noTaam)}</span>`
    + `</span>`;
}

// Apply the current family/trope highlight across both panes (matches pop,
// non-matches dim) and emphasize matching words on the practice contour.
function applyHighlight() {
  document.querySelectorAll('.famchip').forEach((b) => {
    b.classList.toggle('active', state.highlight && state.highlight.kind === 'family' && state.highlight.value === b.dataset.fam);
  });
  document.querySelectorAll('.trope').forEach((el) => {
    el.classList.toggle('active', state.highlight && state.highlight.kind === 'taam' && String(state.highlight.value) === el.dataset.taam);
  });

  const hl = state.highlight;
  const words = document.querySelectorAll('.hebrew .w, .pointed-scroll .w, .pointed-tikkun .w');
  words.forEach((n) => {
    if (!hl) { n.classList.remove('hl', 'dim'); return; }
    const match = hl.kind === 'family'
      ? n.dataset.fam === hl.value
      : n.dataset.taam === String(hl.value);
    n.classList.toggle('hl', match);
    n.classList.toggle('dim', !match);
  });
}

function highlightWord(idx) {
  document.querySelectorAll('#timelineWords .w').forEach((n) => n.classList.toggle('cur', parseInt(n.dataset.wi, 10) === idx));
  // Mirror the current word (the "yad") onto the left reading columns — the
  // pointed nekudot text and the STA"M scroll — so you can follow along reading
  // from either the columns or the words-above-the-notes, as in aliyah mode.
  const gi = (idx != null && idx >= 0 && state.unitSegs && state.unitSegs[idx]) ? state.unitSegs[idx].index : -1;
  highlightReadingWord(gi);
}

// Move the current-word cue in the selected pasuk's left windows: the pointed
// full-nekudot text (#verses) and the STA"M column (#scrollVerses). Pass a
// global (verse-local) word index, or -1 to clear.
function highlightReadingWord(gi) {
  document.querySelectorAll('#verses .hebrew .w.cur, #scrollVerses .sw.cur')
    .forEach((n) => n.classList.remove('cur'));
  if (gi == null || gi < 0 || state.selectedVerse == null) return;
  const v = state.selectedVerse;
  const wEl = document.querySelector(`#verses .verse[data-v="${v}"] .hebrew .w[data-wi="${gi}"]`);
  if (wEl) wEl.classList.add('cur');
  document.querySelectorAll(`#scrollVerses .sw[data-verse="${v}"][data-widx="${gi}"]`)
    .forEach((swEl) => swEl.classList.add('cur'));
}

// Tapping a word (timeline or reading line) focuses & plays it from the recording.
function wireWordClicks(container, segs, hasReal, byId) {
  if (!container) return;
  container.querySelectorAll('.w').forEach((el) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const wi = parseInt(el.dataset.wi, 10);
      const seg = byId ? segs.find((s) => s.index === wi) : segs[wi];
      if (seg && hasReal) playWord(seg);
    });
  });
}
function wireTimelineWordClicks(segs, hasReal) {
  wireWordClicks($('timelineWords'), segs, hasReal, false);
}

// Render the verse on one RTL line above the notes: each word shown normally
// (contiguous) but positioned by time so it sits centered over its note group.
function renderStretchedWords(container, coach, aids, unitSegs) {
  container.innerHTML = '';
  const nWords = coach.overlayWords.length;
  const fpx = readingFontPx(nWords);
  container.style.fontSize = fpx + 'px';
  container.style.height = wordsBandPx(fpx) + 'px';
  coach.overlayWords.forEach((ow) => {
    const wi = unitSegs.indexOf(ow.seg);
    const span = document.createElement('span');
    span.className = 'w tlword';
    span.dataset.wi = wi;
    span.dataset.taam = ow.seg.taam == null ? 'none' : ow.seg.taam;
    span.dataset.fam = ow.seg.familyId;
    const mode = state.colorMode;
    span.style.color = mode === 'full' ? ow.seg.color : INK_GREY;
    // Center the whole word over the midpoint of its notes (RTL axis).
    const centerT = (ow.t0 + ow.t1) / 2;
    span.style.left = ((1 - centerT) * 100) + '%';
    const inner = mode === 'trope'
      ? renderWordTropeColored(ow.seg.token, aids, ow.seg.color)
      : escapeHtml(renderWord(ow.seg.token, aids));
    span.innerHTML = stackTranslit(inner, ow.seg.token);
    container.appendChild(span);
  });
}

// Height of the words band above the notes. The transliteration adds a second
// row, and the band is a fixed-height sibling of the coaching contour (which
// flex-fills what is left), so the cost of the aid is paid here in pixels the
// contour would otherwise have had.
function wordsBandPx(fpx) {
  return Math.round(fpx * (translitOn() ? 1.35 + TRANSLIT_EM * 1.45 : 1.35));
}

function unitDuration() {
  // Use the real recorded duration of the current window so the record window
  // and voice guide match the recording's timing.
  if (state.coach && state.coach.dur) return Math.max(1.0, state.coach.dur);
  const n = state.unitSegs.reduce((a, s) => a + (s.syllables || 1), 0);
  return Math.max(1.4, n * 0.42);
}

function playTarget() {
  if (!state.coach || !state.coach.steps.length) return;
  const bounds = state.coach.wordBounds;
  const wordAt = (t01) => {
    let idx = 0;
    for (let i = 0; i < bounds.length; i++) if (t01 >= bounds[i]) idx = i;
    return idx;
  };
  const res = singSteps(state.coach.steps, {
    tonicHz: state.tonicHz,
    durationSec: state.coach.dur,
    onProgress: (t01) => { state.view.setPlayhead(t01); highlightWord(wordAt(t01)); scrollFollow(t01); },
    onEnd: () => { highlightWord(-1); state.view.setPlayhead(null); },
  });
  state.expectedDur = res.durationSec;
}

async function startRecording(opts = {}) {
  const singAlong = !!(opts && opts.singAlong);
  // Re-press to restart: abort the take in progress (without scoring it) and
  // begin a fresh one — the same way tapping the guide button restarts the audio.
  if (state.recording) cancelRecording();
  resetTransport();
  const level = levelById(state.level);
  // In "listen" mode, play the target first as a lead-in cue. When singing
  // along, the guide instead plays together with the recording (see below).
  if (level.mode === 'listen' && !singAlong) playTarget();

  stopVerseAudio();
  state.playingReal = false;
  state.recording = true;
  state._singAlong = singAlong;
  state._scrollWordHits = null; // wipe the prior take's per-word STA"M tint
  state._scrollLiveWord = null; // reset the live per-word accumulator
  clearScrollWordHits();
  window.__cantillateBusy = true; // hold off any service-worker auto-reload
  // Transpose-invariant: track (target - rawPitch) each frame and shift the
  // whole line by the best-fit (median) offset, so singing the right shape in a
  // different key still scores well. Only the relative shape is judged.
  state._diffs = [];
  state.view.clearUser();
  if (state.userSpectro) state.userSpectro.clearPlot();
  startLiveMeter('liveMeter', 'liveMeterFill', 'liveMeterVal');
  startGhLiveMeter(); // second meter: live Note-hit estimate, for side-by-side compare
  // Whole-verse takes map to the pasuk board, so mark your best + the record
  // holder on the meter as targets to beat.
  if (level.unit === 'line' && state.selectedVerse != null) {
    const goalBars = state._ghLm ? ['liveMeterFill', 'liveMeterGhFill'] : ['liveMeterFill'];
    showRecordMeterMarks(goalBars, 'pasuk', scores.pasukIdFor(state.data, state.selectedVerse), bestVerseScore(state.selectedVerse));
  }
  $('btnRec').disabled = true;
  $('btnStop').disabled = false;
  syncTransportUI(); // the take is live now: arm the scrub + guided Stop button
  $('result').innerHTML = singAlong
    ? '<span class="hint">Sing along — the voice guide plays (use headphones + a wired mic) as you match its shape.</span>'
    : '<span class="hint">Recording… start on any comfortable pitch; your first note is matched to the coach, so just follow the shape.</span>';

  const dur = unitDuration();
  state.expectedDur = dur;
  const bounds = state.coach ? state.coach.wordBounds : [0];
  // Sing-along guide choice: single words (early levels) use the clean synth
  // tones; phrases and whole lines use the real recorded voice, which is much
  // easier and less distracting to chant along with. The record window is a
  // short count-in before the tone guide, but for the voice guide it is anchored
  // to the audio's true start (below) so the two stay in sync despite decode lag.
  const voiceGuide = singAlong && (level.unit === 'phrase' || level.unit === 'line')
    && !!verseAudio(state.selectedVerse) && !!state.coach;
  const leadIn = singAlong ? (voiceGuide ? 0 : 500) : (level.mode === 'listen' ? dur * 1000 + 250 : 250);
  // Where the window would open on a warm mic: the lead-in runs from here (in
  // listen mode it counts off the target playing above), but the clock itself is
  // only started once the mic is live (below).
  const planned = performance.now() + leadIn;
  // Both the voice guide and every other mode hold the window closed until they
  // know where t=0 really is — the guide until the audio actually begins, the
  // rest until the device is open. Timing the take from before that point spends
  // the head of the window on the mic powering up.
  state.recStart = Infinity;

  await startMic((hz, rms, frame) => {
    if (state.paused) return; // held mid-take: the clock and the trail both stop
    const now = performance.now();
    if (now < state.recStart) { return; } // lead-in; let playback drive the cue
    const t01 = (now - state.recStart) / 1000 / dur;
    if (t01 >= 1) { finishRecording(); return; }
    state.view.setPlayhead(t01);
    const liveWi = wordAtTime(state.coach, t01);
    highlightWord(liveWi);
    scrollFollow(t01);
    updateNoteShading(t01); // Note-hit mode: light up each coach bar as it's passed
    // Live spectrogram of the user's voice, aligned in time with the example.
    if (frame && state.userSpectro) {
      state.userSpectro.pushAt(t01, frame.freq, frame.sampleRate, frame.fftSize, hz > 0 ? hz : 0);
    }
    // Raw pitch vs the tonic; align by the running best-fit offset (median of
    // target-minus-raw), which cancels a constant whole-tone/key offset.
    if (hz > 0) {
      const rawT = 12 * Math.log2(hz / state.tonicHz);
      const tgt = state.targetPoints.length ? sampleContour(state.targetPoints, t01) : rawT;
      state._diffs.push(tgt - rawT);
      const O = median(state._diffs);
      const aligned = rawT + O;
      const err = aligned - tgt;
      // Colour + magnet the live dot by the SELECTED scoring model's criteria,
      // so the green/red feedback matches how this take will actually be scored.
      const { styled, hit } = classifyLiveFrame(t01, aligned, tgt, err);
      state.view.pushUser(t01, styled, rms, hit, rawT);
      if (rms >= 0.01) {
        feedLiveMeter(err); feedGhLiveMeter(t01, aligned);
        // Live per-word STA"M tint (mirrors aliyah mode): colour the yad-pointed
        // word by how well its notes are landing so far, using the SAME in-band
        // band as the aliyah live clue and the selected scoring model.
        const band = state.scoreModel === 'gh' ? LIVE_HIT_BAND_GH : LIVE_HIT_BAND_MELODY;
        const liveGi = (state.unitSegs && state.unitSegs[liveWi]) ? state.unitSegs[liveWi].index : -1;
        trackLiveScrollWordHit(state.selectedVerse, liveGi, Math.abs(err) <= band);
      }
    } else {
      state.view.pushUser(t01, null, rms);
    }
  }, () => {});

  // t=0, now that the mic is genuinely live and the frame loop is already
  // turning: the first frame the window admits lands at the very start of the
  // take, so the cue eases in from the edge instead of snapping to wherever the
  // device open left the clock. A warm mic (every take after the first) opens
  // inside the lead-in and keeps the cue exactly where it was planned; only an
  // open that overran it pushes the start out, rather than eating the take.
  if (!voiceGuide) state.recStart = Math.max(planned, performance.now() + 250);

  // Sing-along: launch the guide together with the record window.
  if (singAlong && state.recording) {
    if (voiceGuide) {
      // Real recorded voice as the duet guide. Anchor the record window to the
      // moment the audio truly starts (first progress tick), so the take lines
      // up with the chant despite the audio element's decode/start latency.
      const info = verseAudio(state.selectedVerse);
      let anchored = false;
      const anchor = () => { if (!anchored) { anchored = true; state.recStart = performance.now(); } };
      // Show the example spectrogram (and its green pitch line) live while the
      // duet guide plays, exactly as when the chant is played on its own.
      const tonic = (state.coach && state.coach.tonicHz) || 200;
      if (state.spectro) state.spectro.clearPlot();
      if (state.view) state.view.clearReal(); // reset the green detected-tone line each duet
      playSegment(info.file, state.coach.start, state.coach.end, {
        onProgress: anchor,
        onAnalysis: (a) => onRealAnalysis(a, tonic),
        onEnd: () => {},
        onError: () => { if (state.recording) anchor(); },
      });
    } else {
      // Synth tone guide: schedule it to sound right as the window opens.
      // singSteps schedules ~60 ms ahead internally, so fire that much early.
      state.recStart = performance.now() + 500;
      state._guideTimer = setTimeout(() => {
        if (state.recording) playGuideAudioOnly();
      }, 500 - 60);
    }
  }

  // Safety auto-stop. The record loop normally ends the take when t01 reaches 1;
  // this is a backstop, and for the voice guide it also covers the case where the
  // audio never starts (recStart would otherwise stay in the future).
  const base = voiceGuide ? (performance.now() + 3500) : state.recStart;
  const stopIn = Math.max(0, base - performance.now()) + dur * 1000 + 800;
  state._recTimer = setTimeout(finishRecording, stopIn);
}

// Abort the recording in progress without scoring or saving it, leaving the UI
// ready to begin again. Used both by "restart" (re-pressing record) and by the
// start of a new take.
function cancelRecording() {
  clearTimeout(state._recTimer);
  clearTimeout(state._guideTimer);
  stopMic();
  stopPlayback();
  stopVerseAudio();
  stopLiveMeter();
  stopGhLiveMeter();
  highlightWord(-1);
  state.recording = false;
  state._singAlong = false;
  window.__cantillateBusy = false;
  resetTransport();
}

// Play the coach's target contour as audio only (no visual callbacks), so the
// live recording keeps driving the playhead/highlight while the singer hears
// the exact shape being scored.
function playGuideAudioOnly() {
  if (!state.coach || !state.coach.steps.length) return;
  singSteps(state.coach.steps, { tonicHz: state.tonicHz, durationSec: state.coach.dur });
}

function stopAll() {
  state._recitationId = (state._recitationId || 0) + 1; // abandon any spliced chain
  stopVerseAudio();
  if (state.playingReal) {
    state.playingReal = false;
    document.querySelectorAll('.verse.active .w, #timelineWords .w, #scrollVerses .sw').forEach((w) => w.classList.remove('cur'));
    if (state.view) state.view.setPlayhead(null);
    $('btnStop').disabled = true;
  }
  if (state.recording) finishRecording();
  else stopPlayback();
  // Last: the transport buttons key off `recording`/`playingReal`, so clearing
  // them first would leave the pause button armed with nothing to pause.
  resetTransport();
}

function finishRecording() {
  if (!state.recording) return;
  const assisted = !!state._singAlong; // duet take: scored lower, capped (see scores.js)
  state.recording = false;
  state._singAlong = false;
  window.__cantillateBusy = false;
  resetTransport();
  clearTimeout(state._recTimer);
  clearTimeout(state._guideTimer);
  stopMic();
  stopPlayback();
  stopVerseAudio();
  // NB: unlike cancel, we do NOT hide the live meters here — they stay visible
  // after the take, frozen at the final scores below, as a reference.
  highlightWord(-1);
  $('btnRec').disabled = false;
  $('btnStop').disabled = true;

  const level = levelById(state.level);
  const coach = state.coach;
  const trail = state.view.userTrail;

  // Final transpose-invariant alignment: shift every sample by the whole-line
  // best-fit offset so a constant key/tone offset doesn't cost points.
  const finalO = state._diffs && state._diffs.length ? median(state._diffs) : 0;
  for (const s of trail) if (s.rawT != null) s.sp = s.rawT + finalO;

  // --- Per-word ACCURACY (raw, unweighted) --------------------------------
  // Score each word on its own so problem words stand out, and persist the best
  // per word keyed by its global index. Because words are scored the same way
  // whether sung alone, in a phrase, or in the whole line, a word keeps and
  // improves its true best across every level it's practiced in context.
  // Assisted (sing-along) takes are worth less and are capped below the solo
  // ceiling, so a duet can never beat a strong solo (see scores.js). The penalty
  // is applied to what we STORE (word/phrase/verse bests + leaderboard), so every
  // downstream number stays consistent and a later solo can always exceed it.
  const grade = (raw) => (assisted ? scores.assistedScore(raw) : Math.round(raw));

  const bounds = (coach && coach.wordBounds) || [0];
  const wordScores = [];
  const profileByGi = {}; // this take's per-word scores (good/bad shape)
  for (let wi = 0; wi < bounds.length; wi++) {
    const t0 = bounds[wi];
    const t1 = wi + 1 < bounds.length ? bounds[wi + 1] : 1.0001;
    const uS = trail.filter((s) => s.t >= t0 && s.t < t1);
    const wSteps = coach ? coach.steps.filter((s) => s.w === wi) : [];
    const sc = wSteps.length ? grade(scoreSteps(uS, wSteps).active) : 0;
    wordScores.push(sc);
    const gi = state.unitSegs[wi] ? state.unitSegs[wi].index : wi;
    profileByGi[gi] = sc;
    store.recordWordScore(state.slug, state.selectedVerse, gi, sc);
  }
  // Paint the per-word accuracy onto the STA"M column (green/amber/red), the same
  // line-by-line clue the aliyah reader shows — so a level-8 read from the bare
  // scroll gets the same at-a-glance feedback on which words landed.
  paintScrollWordHits(state.selectedVerse, profileByGi);

  // --- Continuous take score (per section, never summed) -------------------
  // Score the take as one continuous pass (so transitions/timing count) and file
  // it under the right layer: a phrase take updates that phrase's best; a whole-
  // verse take updates BOTH each phrase it contains and the verse's score for the
  // current skill (aids config). Word bests were already updated above.
  // Compute BOTH models over the whole take (shown side by side for testing);
  // `compare.active` is the selected model's score, which is what counts.
  let compare = null;
  let rawAcc;
  if (coach && coach.steps && coach.steps.length) {
    compare = scoreSteps(trail, coach.steps);
    rawAcc = grade(compare.active);
    // Final, authoritative "gem" shading from the note scorer (Note-hit mode).
    if (state.scoreModel === 'gh' && state.view && compare.ghDetail && compare.ghDetail.notes) {
      compare.ghDetail.notes.forEach((n, i) => state.view.setNoteStatus(i, n.hit ? 'hit' : 'miss'));
    }
  } else if (wordScores.length) {
    rawAcc = Math.round(wordScores.reduce((a, b) => a + b, 0) / wordScores.length);
  } else {
    rawAcc = 0;
  }
  const headline = rawAcc;
  let label;
  if (level.unit === 'phrase') {
    store.recordPhraseScore(state.slug, state.selectedVerse, state.unitIndex, headline);
    label = `Phrase ${state.unitIndex + 1} accuracy`;
  } else if (level.unit === 'section') {
    // Sections span several phrases, so a section take also refreshes the best of
    // each phrase inside it — the same way a whole-verse take does.
    const span = unitSpanKey(state.unitSegs);
    if (span) store.recordSectionScore(state.slug, state.selectedVerse, span, headline);
    // Phrase bests are keyed by their position in the WHOLE verse, so shift this
    // section's phrase scores by however many phrases precede it.
    const offset = phraseOffsetOf(state.unitSegs);
    scorePhrasesInLine(trail, coach, state.unitSegs).forEach((sc, pi) => {
      if (sc > 0) store.recordPhraseScore(state.slug, state.selectedVerse, offset + pi, sc);
    });
    const div = divisionByRank(usableDivideRank(state.verseSegs, currentDivideRank()));
    label = `${div.label.replace(/s$/, '')} ${state.unitIndex + 1} accuracy`;
  } else if (level.unit === 'line') {
    scorePhrasesInLine(trail, coach, state.unitSegs).forEach((sc, pi) => {
      if (sc > 0) store.recordPhraseScore(state.slug, state.selectedVerse, pi, sc);
    });
    const skill = skillForLevel(level) || 'base';
    store.recordVerseModeScore(state.slug, state.selectedVerse, skill, headline);
    store.recordVerseProfile(state.slug, state.selectedVerse, skill, headline, profileByGi);
    store.recordVerseRun(state.slug, state.selectedVerse, headline);
    // Chronological attempt log for the leaderboard's score-over-runs colourbar.
    store.recordVerseRunLog(state.slug, state.selectedVerse, headline);
    const md = VERSE_MODES.find((m) => m.key === skill);
    label = `${md ? md.label : 'Full verse'} accuracy`;
  } else {
    label = 'Word accuracy';
  }

  const th = effectiveThreshold(level); // eased for the note-hit model (see above)
  const stars = headline >= 95 ? '★★★' : headline >= 85 ? '★★' : headline >= th ? '★' : '';
  const prize = headline >= 95 ? ' ✨ Masterful!' : headline >= 85 ? ' 🎉 Great!' : '';
  let msg = `<span class="scorelabel">${label}</span> `
    + `<span class="num" style="color:${headline >= th ? 'var(--good)' : 'var(--accent-2)'}">${headline}</span>`
    + `<span class="ceil"> / 100</span> <span class="stars">${stars}</span>${prize} `;
  // Dev/testing: show BOTH scoring models side by side. The selected one (bold)
  // is the score that counts; the other is informational only.
  if (compare) {
    const mel = grade(compare.contour), gh = grade(compare.gh);
    const d = compare.ghDetail;
    const badge = `${d.hits}/${d.total} notes${d.longest > 1 ? `, streak ${d.longest}` : ''}`;
    const melOn = state.scoreModel === 'contour', ghOn = state.scoreModel === 'gh';
    msg += `<br><span class="hint">Scoring compare — `
      + `${melOn ? '<b>' : ''}Melody ${mel}${melOn ? '</b>' : ''} · `
      + `${ghOn ? '<b>' : ''}Note-hit ${gh}${ghOn ? '</b>' : ''} `
      + `<span style="opacity:.7">(${badge})</span> · counting <b>${ghOn ? 'Note-hit' : 'Melody'}</b></span>`;
  }
  // Point out the trickiest word in this take.
  if (wordScores.length > 1) {
    let minI = 0; for (let i = 1; i < wordScores.length; i++) if (wordScores[i] < wordScores[minI]) minI = i;
    const seg = state.unitSegs[minI];
    if (seg && wordScores[minI] < 85) {
      msg += `<br><span class="hint">Trickiest: <b style="color:${seg.color}">${renderWord(seg.token, aidsForLevel())}</b> (${wordScores[minI]}) — see the score bars below.</span>`;
    }
  }
  if (headline >= th) {
    const next = Math.min(LEVELS.length, level.id + 1);
    store.recordVerseLevel(state.slug, state.selectedVerse, next);
    if (next > level.id) msg += `<br><span class="hint" style="color:var(--good)">Stage ${next} unlocked!</span>`;
  } else {
    msg += `<br><span class="hint">Reach ${th}+ to unlock the next stage.</span>`;
  }
  if (assisted) {
    msg += `<br><span class="hint">🎧 Assisted take (sang with the guide): scaled to ${Math.round(scores.ASSIST_MULT * 100)}% and capped at ${scores.ASSIST_CAP}. Record solo to break the cap, reach 100, and top the leaderboard.</span>`;
  }
  $('result').innerHTML = msg;
  // Freeze BOTH live meters at their FINAL scores (not the running estimate) and
  // leave them on screen for reference, so you can compare the two models after
  // the take. The goal markers ("Your best" / record) stay too.
  if (compare) {
    if (state._lm) drawLiveMeter(grade(compare.contour));
    if (state._ghLm) drawGhLiveMeter(grade(compare.gh));
  }
  // Estimate of time spent: count this take's recording window (accurate going
  // forward; historical progress is estimated from attempt counts in the store).
  store.addPracticeSeconds((coach && coach.dur) || state.expectedDur || 0);
  renderAccuracyPanel();
  renderVerses();
  renderAliyot();
  applyHighlight();
  renderStageBar();
  maybePushScopes();
  if (level.unit === 'line') maybeOfferLeaderboardSubmit(headline);
  // Guided mode draws its own verdict from this and decides what comes next.
  if (guided) guided.notifyScore({
    kind: 'verse',
    verse: state.selectedVerse,
    level: level.id,
    unit: level.unit,
    unitIndex: state.unitIndex,
    unitCount: state.units ? state.units.length : 1,
    score: headline,
    threshold: th,
    passed: headline >= th,
    assisted,
  });
}

// Greyed page shown when navigating to a stage not yet unlocked for this verse.
function renderLockedPage(level, unlocked) {
  const frontier = levelById(unlocked);
  const v = state.data.verses[state.selectedVerse - 1];
  const p = $('practice');
  p.innerHTML = `
    <div class="phead">
      <h2>${state.data.book.he} ${verseRefLabel(v, state.selectedVerse)}${verseIndexSuffix(v, state.selectedVerse, 'verse ')} <span class="stagetag">Stage ${level.id}: ${level.label}</span></h2>
    </div>
    <div class="locked-page">
      <div class="lock-icon">🔒</div>
      <h3>This stage is locked</h3>
      <p class="leveldesc">${level.desc}</p>
      <p class="next">To unlock it, complete <b>Stage ${unlocked}: ${frontier.label}</b> on this verse — score <b>${effectiveThreshold(frontier)}+</b>.</p>
      <button class="primary" id="btnGoFrontier">▶ Go to Stage ${unlocked}: ${frontier.label}</button>
    </div>`;
  $('btnGoFrontier').addEventListener('click', () => {
    state.level = unlocked;
    state.unitIndex = 0;
    renderStageBar();
    renderPractice();
  });
}

// Legacy per-unit legend (kept for reference / potential reuse). The unified
// Trope guide panel (renderGuide) now provides this, so #tropes may not exist.
function renderLegend(segs) {
  const box = $('tropes');
  if (!box) return;
  box.innerHTML = '';
  // De-duplicate by trope name within the unit.
  const seen = new Set();
  segs.forEach((seg) => {
    const key = seg.name.en;
    if (seen.has(key)) return;
    seen.add(key);
    const el = document.createElement('div');
    el.className = 'trope';
    el.dataset.taam = seg.taam == null ? 'none' : seg.taam;
    el.style.setProperty('--c', seg.color);
    const glyph = markGlyph(seg.taam);
    const shapeKey = seg.taam == null ? 'none' : String(seg.taam);
    const shape = state.shapes && state.shapes[shapeKey];
    const avgNote = shape ? ` <span class="avgn">of ${shape.n}</span>` : '';
    const meaning = seg.name.meaning ? `<div class="tmean">“${seg.name.meaning}”</div>` : '';
    el.innerHTML = `<div class="tname"><span class="sw" style="background:${seg.color}"></span>${seg.name.he} · ${seg.name.en}${avgNote}</div>
      ${meaning}
      <div class="trole">${glyph ? `<span class="markicon big">${glyph}</span>` : ''}${seg.name.role}${seg.name.role === 'conjunctive' ? ' → colored by the accent it leads into' : ''}</div>
      <canvas width="150" height="42"></canvas>
      <div class="tnote">${seg.name.note}</div>`;
    box.appendChild(el);
    const canvas = el.querySelector('canvas');
    if (shape && shape.steps && shape.steps.length) drawMiniSteps(canvas, shape.steps, seg.color);
    else drawMini(canvas, seg.contour, seg.color);
    el.addEventListener('click', () => {
      const val = seg.taam == null ? 'none' : seg.taam;
      if (state.highlight && state.highlight.kind === 'taam' && String(state.highlight.value) === String(val)) {
        state.highlight = null;
      } else {
        state.highlight = { kind: 'taam', value: val };
      }
      applyHighlight();
    });
  });
}

// Segment an averaged contour into discrete note steps (like the coach line).
function contourToSteps(contour, tol = 0.7) {
  if (!contour.length) return [];
  const steps = [];
  let i = 0;
  while (i < contour.length) {
    let j = i;
    const acc = [contour[i].p];
    while (j + 1 < contour.length && Math.abs(contour[j + 1].p - median(acc)) < tol) {
      j++; acc.push(contour[j].p);
    }
    steps.push({ t0: contour[i].t, t1: contour[j].t, p: median(acc) });
    i = j + 1;
  }
  // merge adjacent near-equal steps
  const merged = [steps[0]];
  for (let k = 1; k < steps.length; k++) {
    const last = merged[merged.length - 1];
    if (Math.abs(steps[k].p - last.p) < 0.5) { last.t1 = steps[k].t1; last.p = (last.p + steps[k].p) / 2; }
    else merged.push(steps[k]);
  }
  return merged;
}

// Draw explicit note steps [{t0,t1,p}] as horizontal bars + faint risers.
function drawMiniSteps(canvas, steps, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!steps.length) return;
  const ps = steps.map((s) => s.p);
  const min = Math.min(-1, ...ps), max = Math.max(1, ...ps);
  // Right-to-left in time, matching Hebrew reading and the coach contour view.
  const x = (t) => 4 + (1 - t) * (w - 8);
  const y = (p) => h - 5 - ((p - min) / (max - min || 1)) * (h - 10);
  ctx.strokeStyle = color || '#5aa0ff';
  ctx.lineWidth = 1; ctx.globalAlpha = 0.35;
  for (let i = 1; i < steps.length; i++) {
    const xm = x(steps[i].t0);
    ctx.beginPath(); ctx.moveTo(xm, y(steps[i - 1].p)); ctx.lineTo(xm, y(steps[i].p)); ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.lineWidth = 3; ctx.lineCap = 'round';
  steps.forEach((s) => {
    const x0 = x(s.t0), x1 = Math.min(x0 - 3, x(s.t1)), yy = y(s.p);
    ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
  });
}

// Draw the trope shape as discrete note steps (horizontal bars + faint risers),
// matching the practice coach line.
function drawMini(canvas, contour, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!contour.length) return;
  const steps = contourToSteps(contour);
  const ps = contour.map((c) => c.p);
  const min = Math.min(-1, ...ps), max = Math.max(1, ...ps);
  // Right-to-left in time, matching Hebrew reading and the coach contour view.
  const x = (t) => 4 + (1 - t) * (w - 8);
  const y = (p) => h - 5 - ((p - min) / (max - min || 1)) * (h - 10);
  // faint vertical risers between steps
  ctx.strokeStyle = color || '#5aa0ff';
  ctx.lineWidth = 1; ctx.globalAlpha = 0.35;
  for (let i = 1; i < steps.length; i++) {
    const xm = x(steps[i].t0);
    ctx.beginPath(); ctx.moveTo(xm, y(steps[i - 1].p)); ctx.lineTo(xm, y(steps[i].p)); ctx.stroke();
  }
  // note bars
  ctx.globalAlpha = 1; ctx.lineWidth = 3; ctx.lineCap = 'round';
  steps.forEach((s) => {
    const x0 = x(s.t0), x1 = Math.min(x0 - 3, x(s.t1)), yy = y(s.p);
    ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
  });
}

// --- helpers ---
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// --- Live "guitar-hero" score meter ----------------------------------------
// The meter shows the CUMULATIVE score-so-far, computed exactly like the final
// scoreTrail (100·e^(-meanError/τ) over all voiced frames), so it converges to
// the score you'll actually get — by the final seconds it's essentially there.
const LIVE_DEAD = 0.35, LIVE_MAXDEV = 4, LIVE_TAU = 2.5;

function startLiveMeter(containerId, fillId, valId) {
  state._lm = { c: $(containerId), f: $(fillId), v: $(valId) };
  state._liveSum = 0;
  state._liveCount = 0;
  // Bump the meter token so a late board reply from a PREVIOUS take can't draw
  // its goal markers onto this new take's meter.
  state._meterToken = (state._meterToken || 0) + 1;
  setMeterMarks(fillId, []); // clear any goal markers frozen from a prior take
  if (state._lm.c) state._lm.c.hidden = false;
  drawLiveMeter(0);
}

// Feed one voiced frame's pitch error (semitones); accumulate into the running
// mean error and redraw the cumulative score.
function feedLiveMeter(err) {
  let e = Math.min(LIVE_MAXDEV, Math.abs(err));
  e = Math.max(0, e - LIVE_DEAD);
  state._liveSum += e;
  state._liveCount += 1;
  const meanErr = state._liveSum / state._liveCount;
  drawLiveMeter(100 * Math.exp(-meanErr / LIVE_TAU));
}

function drawLiveMeter(scoreVal) {
  const lm = state._lm;
  if (!lm || !lm.f) return;
  const s = Math.max(0, Math.min(100, Math.round(scoreVal)));
  lm.f.style.width = s + '%';
  lm.f.style.background = rampColor(s, 0, 100, true);
  if (lm.v) lm.v.textContent = s;
}

function stopLiveMeter() {
  if (state._lm && state._lm.f && state._lm.f.parentElement) {
    state._lm.f.parentElement.querySelectorAll('.lm-mark').forEach((m) => m.remove());
  }
  if (state._lm && state._lm.c) state._lm.c.hidden = true;
  state._lm = null;
}

// --- Second live meter: Guitar-Hero note-hit running estimate ----------------
// Runs alongside the melody meter during a take so you can compare both models
// live. As each voiced frame arrives we find the coach note-step covering that
// moment and tally whether the (offset-corrected) pitch is within band; the
// displayed score is the mean in-band fraction over every note touched so far,
// which converges toward the final scoreNotes headline. Frames in the gaps
// between notes are ignored (they aren't scored notes), same as scoreNotes.
const GH_LIVE_BAND = 1.5; // semitones — keep in sync with scoreNotes' default

function startGhLiveMeter() {
  const c = $('liveMeterGh');
  // Only meaningful when we have discrete coach steps to score against.
  if (!c || !state.coach || !state.coach.steps || !state.coach.steps.length) {
    state._ghLm = null;
    return;
  }
  state._ghLm = { c, f: $('liveMeterGhFill'), v: $('liveMeterGhVal'), notes: new Map(), done: new Set() };
  setMeterMarks('liveMeterGhFill', []); // clear goal markers frozen from a prior take
  c.hidden = false;
  drawGhLiveMeter(0);
}

// Progressive "gem lights up": in Note-hit mode, once the playhead passes a coach
// note-step, shade its bar green (hit) or red (missed) from the in-band tally so
// far. Runs every frame (voiced or not) so skipped/silent notes still turn red
// as the playhead sweeps past them.
function updateNoteShading(t01) {
  if (state.scoreModel !== 'gh' || !state._ghLm || !state.view || !state.coach) return;
  const steps = state.coach.steps || [];
  const lm = state._ghLm;
  for (let i = 0; i < steps.length; i++) {
    if (t01 >= steps[i].t1 && !lm.done.has(i)) {
      lm.done.add(i);
      const r = lm.notes.get(i);
      const frac = r && r.samples ? r.inBand / r.samples : 0;
      state.view.setNoteStatus(i, frac >= 0.5 ? 'hit' : 'miss');
    }
  }
}

function feedGhLiveMeter(t01, alignedPitch) {
  const lm = state._ghLm;
  if (!lm || !state.coach) return;
  const steps = state.coach.steps;
  let idx = -1;
  for (let i = 0; i < steps.length; i++) {
    if (t01 >= steps[i].t0 && t01 < steps[i].t1) { idx = i; break; }
  }
  if (idx < 0) return; // in a gap between notes — not a scored moment
  let rec = lm.notes.get(idx);
  if (!rec) { rec = { inBand: 0, samples: 0 }; lm.notes.set(idx, rec); }
  rec.samples += 1;
  if (Math.abs(alignedPitch - steps[idx].p) <= GH_LIVE_BAND) rec.inBand += 1;
  let sum = 0, n = 0;
  lm.notes.forEach((r) => { sum += r.inBand / r.samples; n += 1; });
  drawGhLiveMeter(n ? 100 * (sum / n) : 0);
}

function drawGhLiveMeter(scoreVal) {
  const lm = state._ghLm;
  if (!lm || !lm.f) return;
  const s = Math.max(0, Math.min(100, Math.round(scoreVal)));
  lm.f.style.width = s + '%';
  lm.f.style.background = rampColor(s, 0, 100, true);
  if (lm.v) lm.v.textContent = s;
}

function stopGhLiveMeter() {
  if (state._ghLm && state._ghLm.c) state._ghLm.c.hidden = true;
  state._ghLm = null;
}

// The coach note-step covering a given moment (null in the gaps between notes).
function currentCoachStep(t01) {
  const steps = state.coach && state.coach.steps;
  if (!steps) return null;
  for (let i = 0; i < steps.length; i++) if (t01 >= steps[i].t0 && t01 < steps[i].t1) return steps[i];
  return null;
}

// Decide a live mic frame's dot colour ('perfect'|'close'|'far'|null) and its
// magnet-pulled y position, using the SELECTED scoring model's own criteria so
// the on-screen feedback matches the score:
//   - Melody: distance to the interpolated coach contour, DEADZONE/2.0 tiers.
//   - Note-hit: distance to the CURRENT note's flat target; inside the band =
//     green (this frame counts as in-band), just outside = yellow, off = red,
//     and in the gaps between notes there's no target (neutral orange dot).
function classifyLiveFrame(t01, aligned, tgt, err) {
  if (state.scoreModel === 'gh') {
    const step = currentCoachStep(t01);
    if (!step) return { styled: aligned, hit: null };
    const d = aligned - step.p, ad = Math.abs(d), sgn = Math.sign(d);
    let hit, styled;
    if (ad <= GH_LIVE_BAND) { hit = 'perfect'; styled = step.p + d * 0.2; }
    else {
      hit = ad <= GH_LIVE_BAND * 1.6 ? 'close' : 'far';
      styled = step.p + sgn * Math.min(MAXDEV, GH_LIVE_BAND + (ad - GH_LIVE_BAND) * PULL);
    }
    return { styled, hit };
  }
  // Melody (contour) mode: original guitar-hero magnet toward the contour.
  const ae = Math.abs(err), sgn = Math.sign(err);
  if (ae <= DEADZONE) return { styled: tgt + err * 0.2, hit: 'perfect' };
  const off2 = Math.min(MAXDEV, DEADZONE + (ae - DEADZONE) * PULL);
  return { styled: tgt + sgn * off2, hit: ae <= 2.0 ? 'close' : 'far' };
}

// "Beat this" markers drawn over a live meter: each is a dotted vertical line at
// its score%. Your own best and the shared record holder get distinct styles so
// you can see, mid-take, exactly what you're chasing.
function setMeterMarks(fillId, marks) {
  const fill = $(fillId);
  const track = fill && fill.parentElement;
  if (!track) return;
  track.querySelectorAll('.lm-mark').forEach((m) => m.remove());
  (marks || []).forEach((m) => {
    if (!m || !(m.score > 0)) return;
    const pos = Math.max(0, Math.min(100, m.score));
    const el = document.createElement('div');
    el.className = `lm-mark lm-mark-${m.cls}`;
    el.style.left = pos + '%';
    el.title = `${m.label}: ${Math.round(m.score)}/100`;
    el.innerHTML = `<span class="lm-mark-flag">${m.cls === 'top' ? '🏆' : ''}${Math.round(m.score)}</span>`;
    track.appendChild(el);
  });
}

// Place the personal-best marker right away (local, instant), then stream in the
// shared record-holder's mark once the board responds. Guarded so a late board
// reply never draws onto a meter whose take has already ended.
function showRecordMeterMarks(fillId, type, refId, yourBest) {
  // `fillId` may be a single id or an array (e.g. both the melody and note-hit
  // bars), so the same "beat this" goal shows on every meter.
  const fills = Array.isArray(fillId) ? fillId : [fillId];
  const token = state._meterToken;
  const yourMark = { score: yourBest, cls: 'you', label: 'Your best' };
  fills.forEach((f) => setMeterMarks(f, [yourMark]));
  boardTop(type, refId).then((top) => {
    if (state._meterToken !== token) return; // a newer take started
    const marks = [yourMark];
    if (top && top.score > 0) marks.push({ score: top.score, cls: 'top', label: `Top — ${top.name || 'record holder'}` });
    fills.forEach((f) => setMeterMarks(f, marks));
  }).catch(() => {});
}

// --- Hover-hold word translation lookup (Sefaria lexicon) ------------------
const _wordCache = new Map();

// Reduce a Masoretic token to a searchable term: drop cantillation + niqqud,
// and if it's a maqaf-compound, take the longest sub-word.
function lookupTerm(token) {
  const noMarks = token.replace(/[\u0591-\u05BD\u05BF-\u05C7]/g, '');
  const parts = noMarks.split('\u05BE').map((s) => s.trim()).filter(Boolean);
  parts.sort((a, b) => b.length - a.length);
  return (parts[0] || noMarks).replace(/\u05BE/g, '');
}

function _stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// Parse the Sefaria /api/words response into { lemma, glosses[] }.
function extractGlosses(data) {
  const entries = Array.isArray(data) ? data : [];
  const lemma = entries.length ? entries[0].headword : '';
  const out = [];
  const seen = new Set();
  const add = (t) => {
    let g = _stripTags(t);
    if (!g) return;
    if (g.length > 90) g = g.slice(0, 88) + '…';
    if (!seen.has(g)) { seen.add(g); out.push(g); }
  };
  for (const e of entries) {
    const senses = (e.content && e.content.senses) || [];
    for (const s of senses) { if (s.definition) add(s.definition); }
    if (out.length >= 5) break;
  }
  return { lemma, glosses: out.slice(0, 5) };
}

// Returns a promise of { lemma, glosses } or null on network failure.
function lookupWord(token) {
  const term = lookupTerm(token);
  if (!term) return Promise.resolve({ lemma: '', glosses: [] });
  if (_wordCache.has(term)) return _wordCache.get(term);
  const p = fetch(`https://www.sefaria.org/api/words/${encodeURIComponent(term)}?never_split=1`)
    .then((r) => (r.ok ? r.json() : []))
    .then((d) => extractGlosses(d))
    .catch(() => null);
  _wordCache.set(term, p);
  return p;
}

function setupWordLookup() {
  const pop = document.createElement('div');
  pop.className = 'wordpop';
  pop.hidden = true;
  document.body.appendChild(pop);
  state._wordpop = pop;
  let timer = null;
  // On touch devices tapping a word emulates a `mouseover`, which would pop the
  // translation up the instant you try to select/practice a verse. Track when
  // the last interaction was touch so we suppress hover popups there and instead
  // require a deliberate long-press (hold) to reveal the translation.
  let touchMode = false;
  let longPressed = false; // a hold just opened the popup → swallow the ensuing click
  let touchStart = null;
  const box = $('verses');
  if (!box) return;
  const hide = () => { clearTimeout(timer); pop.hidden = true; pop._forEl = null; };

  // Desktop: hover-hold.
  box.addEventListener('mouseover', (e) => {
    if (touchMode) return; // ignore the mouse events touch devices synthesize
    const w = e.target.closest('.w');
    if (!w) return;
    clearTimeout(timer);
    timer = setTimeout(() => showWordPop(w), 450); // hover-hold delay
  });
  box.addEventListener('mouseout', (e) => {
    if (touchMode) return;
    const w = e.target.closest('.w');
    if (!w) return;
    if (e.relatedTarget && (w.contains(e.relatedTarget) || pop.contains(e.relatedTarget))) return;
    hide();
  });

  // Mobile: press-and-hold a word to reveal its translation; a plain tap still
  // just selects the verse / opens word practice.
  const LONG_PRESS = 500;   // ms to hold before the translation appears
  const MOVE_CANCEL = 10;   // px of finger travel that counts as a scroll, not a hold
  box.addEventListener('touchstart', (e) => {
    touchMode = true;
    longPressed = false;
    const w = e.target.closest('.w');
    if (!w) return;
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => { longPressed = true; showWordPop(w); }, LONG_PRESS);
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    if (!touchStart) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - touchStart.x) > MOVE_CANCEL ||
        Math.abs(t.clientY - touchStart.y) > MOVE_CANCEL) {
      clearTimeout(timer); // moved → it's a scroll, not a hold
    }
  }, { passive: true });
  box.addEventListener('touchend', () => { clearTimeout(timer); touchStart = null; });
  box.addEventListener('touchcancel', () => { clearTimeout(timer); touchStart = null; hide(); });

  // Swallow the click a completed long-press would otherwise fire, so holding a
  // word only reveals the translation instead of also jumping into practice.
  box.addEventListener('click', (e) => {
    if (!longPressed) return;
    longPressed = false;
    e.stopPropagation();
    e.preventDefault();
  }, true); // capture: run before the per-verse click handler

  // A tap anywhere outside a word dismisses an open long-press popup.
  document.addEventListener('touchstart', (e) => {
    if (touchMode && !pop.hidden && !(e.target.closest && e.target.closest('.w'))) hide();
  }, { passive: true });

  box.addEventListener('scroll', hide, true);
  window.addEventListener('scroll', hide, true);
}

function positionWordPop(pop, w) {
  const r = w.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = window.scrollX + r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - pr.width - 8));
  let top = window.scrollY + r.top - pr.height - 8;
  if (top < window.scrollY + 4) top = window.scrollY + r.bottom + 8; // flip below if no room
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

async function showWordPop(w) {
  const pop = state._wordpop;
  if (!pop) return;
  const verseEl = w.closest('.verse');
  if (!verseEl) return;
  const v = parseInt(verseEl.dataset.v, 10);
  const wi = parseInt(w.dataset.wi, 10);
  const tokens = tokenize(state.data.verses[v - 1].text);
  const token = tokens[wi] || '';
  const term = lookupTerm(token);
  pop._forEl = w;
  pop.innerHTML = `<div class="wp-head">${escapeHtml(term)}</div><div class="wp-body"><span class="wp-muted">looking up…</span></div>`;
  pop.hidden = false;
  positionWordPop(pop, w);
  const res = await lookupWord(token);
  if (pop._forEl !== w || pop.hidden) return; // hovered away / hidden meanwhile
  let body;
  if (res === null) body = '<span class="wp-muted">Lookup unavailable (offline).</span>';
  else if (!res.glosses.length) body = '<span class="wp-muted">No dictionary entry found.</span>';
  else body = `<ul>${res.glosses.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}</ul>`;
  const head = res && res.lemma ? `${escapeHtml(term)} <span class="wp-lemma">${escapeHtml(res.lemma)}</span>` : escapeHtml(term);
  pop.innerHTML = `<div class="wp-head">${head}</div><div class="wp-body">${body}</div>`;
  positionWordPop(pop, w);
}

// Hebrew numerals for verse labels (1..999).
function toHebrewNum(n) {
  const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  const tens = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
  const hundreds = ['', 'ק', 'ר', 'ש', 'ת'];
  let s = '';
  s += hundreds[Math.floor(n / 100)] || '';
  n %= 100;
  if (n === 15) return s + 'טו';
  if (n === 16) return s + 'טז';
  s += tens[Math.floor(n / 10)] || '';
  s += ones[n % 10] || '';
  return s;
}

init();
