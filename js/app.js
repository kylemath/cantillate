import { tokenize, renderWord, toScroll, stripNikud, stripTaamim } from './hebrew.js';
import { buildLineMelody, splitPhrases, FAMILIES, markGlyph, NAMES,
  motifFor, nameFor, SOF_PASUK_MOTIF, SOF_PASUK_NAME } from './trope.js';
import { singSteps, playTone, stopPlayback } from './audio.js';
import { playSegment, stopVerseAudio } from './realaudio.js';
import { startMic, stopMic } from './pitch.js';
import { ContourView, Spectrogram, scoreTrail, scoreNotes, stepsToPoints, sampleContour } from './viz.js';
import { LEVELS, levelById, VERSE_MODES, skillForLevel } from './levels.js';
import { aliyotFor, parashahOf, currentTriennialYear } from './aliyot.js';
import * as store from './store.js';
import * as auth from './auth.js';
import * as scores from './scores.js';
import * as offline from './offline.js';
import { loadTikkunData, renderTikkunPages, TIKKUN_DATA_URL } from './tikkun.js';

// An aliyah's scroll+yad challenge unlocks once every pasuk in it has reached at
// least this stage (i.e., the learner has worked it up to whole-verse practice).
const ALIYAH_READY_LEVEL = 4;

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
  overlay: 'off',     // left-column score overlay: 'off'|'word'|'phrase'|'verse'
  // The "Portion" selector drives these two: annual = whole parashah;
  // triennial + triYear = one shorter year (its own aliyot AND verse range).
  cycle: 'triennial', // aliyah cycle: 'annual' | 'triennial'
  triYear: 1,         // triennial cycle year (1-3)
  aliyah: null,       // currently-open aliyah challenge (null = normal practice)
  aliyahCue: 'word',  // yad outline granularity in aliyah mode: 'word' | 'phrase'
  scrollView: false,  // render the text pane as a continuous Torah column
  scrollZoom: false,  // guitar-hero: zoom to ~5 words and auto-scroll the line
  tonicHz: 220,
  division: 'full',  // legacy field; verse range now derives from cycle/triYear (see divisionRange)
  readScale: 1.6,     // reading-size multiplier: bigger Hebrew, smaller notation
  showAnalysis: false, // desktop: reveal the spectrograms + accuracy bars (off = the
                       // coaching contour fills the pane so slight tone shifts show)
  selectedVerse: null,
  level: 1,
  unitIndex: 0,
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

// Neutral ink for words/vowels when colour is limited to the trope (or off).
const INK_GREY = '#aab0c8';

const $ = (id) => document.getElementById(id);

// User-facing label for a verse. Multi-chapter readings carry per-verse chapter
// (c) and verse (v) numbers, shown as plain "chapter:verse" so the reference is
// unambiguous across chapters. Single-chapter readings (no c/v) fall back to the
// Hebrew-numeral verse index, as before.
function verseRefLabel(verse, n) {
  if (verse && verse.c != null && verse.v != null) return `${verse.c}:${verse.v}`;
  return `${toHebrewNum(n)}`;
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

async function init() {
  // Auto-discover readings from the manifest (falls back to the hardcoded list).
  try {
    const rr = await fetch('data/readings.json');
    if (rr.ok) {
      const list = await rr.json();
      if (Array.isArray(list) && list.length) AVAILABLE = list;
    }
  } catch (e) { /* keep the hardcoded fallback */ }

  // Populate parashah selector.
  const sel = $('parashah');
  AVAILABLE.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.slug; o.textContent = p.label; sel.appendChild(o);
  });
  // Open the upcoming week's parashah by default (falls back to the first).
  const startSlug = upcomingParashahSlug(AVAILABLE) || AVAILABLE[0].slug;
  sel.value = startSlug;
  await loadData(startSlug);

  sel.addEventListener('change', () => loadData(sel.value));
  $('tonic').addEventListener('change', (e) => { state.tonicHz = parseFloat(e.target.value); });
  $('audioSource').addEventListener('change', (e) => { switchAudioSource(e.target.value); });

  bindToggle('tgVowels', () => { state.showVowels = !state.showVowels; refreshText(); });
  bindToggle('tgTaamim', () => { state.showTaamim = !state.showTaamim; refreshText(); });
  bindToggle('tgFont', () => { state.scroll = !state.scroll; refreshText(); });
  bindToggle('tgEnglish', () => { state.showEnglish = !state.showEnglish; renderVerses(); });
  $('overlaySeg').querySelectorAll('.ov').forEach((b) => {
    b.addEventListener('click', () => { state.overlay = b.dataset.ov; syncToggleUI(); renderVerses(); });
  });
  initScoreModel();
  $('scoreModelSeg').querySelectorAll('.sm').forEach((b) => {
    b.addEventListener('click', () => setScoreModel(b.dataset.sm));
  });
  bindToggle('tgScrollView', () => { if (state.aliyah) return; state.scrollView = !state.scrollView; renderVerses(); maybeShowRotate(); });

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
  setupOfflineButton();
  setupNetBadge();
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

// Mobile pull-down "settings" sheet: on a phone the dense header controls and
// display toolbar live in a sheet that slides down from the slim app-bar, so
// they stop eating the screen. On desktop the sheet is display:contents (a
// no-op wrapper) and the app-bar is hidden, so this is inert there.
function setupSettingsSheet() {
  const toggle = $('settingsToggle');
  const backdrop = $('settingsBackdrop');
  const closeBtn = $('settingsClose');
  const setOpen = (open) => {
    document.body.classList.toggle('settings-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  if (toggle) toggle.addEventListener('click', () => setOpen(!document.body.classList.contains('settings-open')));
  if (backdrop) backdrop.addEventListener('click', () => setOpen(false));
  if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('settings-open')) setOpen(false);
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
    state.scrollView = false; syncToggleUI(); renderVerses(); maybeShowRotate();
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
    },
    // Cloud progress merged into local on sign-in — refresh everything so the
    // newly-synced scores/levels show up immediately, and (on the very first
    // login) offer to pick an anonymous nickname/avatar.
    onProgressMerged: () => {
      refreshProgressViews();
      renderAuthBox();
      if (auth.getUser() && !auth.hasChosenProfile()) openProfileModal({ firstTime: true });
    },
  });
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
  btn.addEventListener('click', () => openLeaderboard());
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
      let data;
      if (state.slug === meta.slug && state.data) data = state.data;
      else { const r = await fetch(meta.file); if (!r.ok) continue; data = await r.json(); }
      out.push({ slug: meta.slug, label: meta.label, data });
    } catch (e) { /* skip a reading whose data file is missing */ }
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
          label: `Aliyah ${a.n}${a.ref ? ` · ${a.ref}` : ''}`,
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
        label: a.n === 'M' ? `Maftir${a.ref ? ` · ${a.ref}` : ''}` : `Aliyah ${a.n}${a.ref ? ` · ${a.ref}` : ''}`,
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
    for (const a of defaultAliyot(cycle, year)) scoreUnit(a, `Aliyah ${a.n} · ${a.ref || ''}`);
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
    tw.style.height = Math.round(readingFontPx(n) * 1.35) + 'px';
  }
  if (rerender && state.selectedVerse != null && !state.aliyah
      && !state.recording && !state.playingReal) {
    renderPractice();
  }
}

// Keyboard shortcuts (RTL): ← next page/word, → previous, Space/P play,
// ↓ record (press again to restart), ↑ sing along (voice guide + record in
// sync), Escape stop. Modifier combos (e.g. Ctrl/Cmd+R to refresh) and typing
// in a control are left to the browser. In aliyah mode the same keys drive the
// aliyah transport (Space guided read, ↓ record, ↑ duet, Esc stop).
function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
  if (state.aliyah) {
    const tl = state._aliyaTl;
    if (!tl) return;
    if (e.key === ' ' || e.key === 'p') { e.preventDefault(); if (!state._aliyaRunning) playAliyahGuided(tl); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); recordAliyahRun(tl); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); recordAliyahRun(tl, { duet: true }); }
    else if (e.key === 'Escape') { e.preventDefault(); stopAliyah(); setAliyahButtons(false); }
    return;
  }
  if (state.selectedVerse == null) return;
  const units = state.units;
  if (!units || !units.length) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); goToUnit(state.unitIndex + 1, true); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); goToUnit(state.unitIndex - 1, true); }
  else if (e.key === ' ' || e.key === 'p') { e.preventDefault(); playUnit(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); startRecording(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); startRecording({ singAlong: true }); }
  else if (e.key === 'Escape') { e.preventDefault(); stopAll(); }
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
  $('result').innerHTML = '<span class="hint">Playing this ' + (state.unitSegs.length > 1 ? 'unit (with the pauses between words)' : 'word') + ' from the recording…</span>';
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
function setupGuide() {
  renderGuide();
  const tg = $('tgGuide');
  if (tg) tg.addEventListener('click', () => toggleGuide());
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
function tropeCardHtml(m, color) {
  const isSof = m === 'sof';
  const taamVal = isSof ? 'sof' : String(m);
  const name = isSof ? SOF_PASUK_NAME : nameFor(m);
  const glyph = markGlyph(m);
  const shapeKey = isSof ? 'sof' : String(m);
  const shape = state.shapes && state.shapes[shapeKey];
  const avgNote = shape ? ` <span class="avgn">of ${shape.n}</span>` : '';
  const meaning = name.meaning ? `<div class="tmean">“${name.meaning}”</div>` : '';
  return `<div class="trope g-trope" data-taam="${taamVal}" data-member="${shapeKey}" data-color="${color}" style="--c:${color}">
    <div class="tname"><span class="sw" style="background:${color}"></span>${name.he} · ${name.en}${avgNote}</div>
    ${meaning}
    <div class="trole">${glyph ? `<span class="markicon big" style="color:${color}">${glyph}</span>` : ''}${name.role}${name.role === 'conjunctive' ? ' → coloured by the accent it leads into' : ''}</div>
    <canvas width="150" height="42"></canvas>
    <div class="tnote">${name.note}</div>
  </div>`;
}

// Draw a trope's melodic diagram: the averaged shape from the recording when we
// have one, else the stylized motif from trope.js.
function drawTropeDiagram(canvas, member, color) {
  if (!canvas) return;
  const shape = state.shapes && state.shapes[member];
  if (shape && shape.steps && shape.steps.length) { drawMiniSteps(canvas, shape.steps, color); return; }
  const motif = member === 'sof' ? SOF_PASUK_MOTIF : motifFor(Number(member));
  drawMini(canvas, motif, color);
}

function renderGuide() {
  const body = $('guideBody');
  if (!body) return;
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
function syncToggleUI() {
  $('tgVowels').classList.toggle('on', state.showVowels);
  $('tgTaamim').classList.toggle('on', state.showTaamim);
  $('tgFont').classList.toggle('on', state.scroll);
  $('tgEnglish').classList.toggle('on', state.showEnglish);
  const seg = $('overlaySeg');
  if (seg) seg.querySelectorAll('.ov').forEach((b) => b.classList.toggle('on', b.dataset.ov === state.overlay));
  const sms = $('scoreModelSeg');
  if (sms) sms.querySelectorAll('.sm').forEach((b) => b.classList.toggle('on', b.dataset.sm === state.scoreModel));
  $('tgScrollView').classList.toggle('on', state.scrollView);
  document.body.classList.toggle('scroll-view', state.scrollView);
  if (state.scrollView) requestAnimationFrame(fitScrollPages);
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

// The sources a reading advertises (from its manifest entry). Falls back to a
// single default PocketTorah source so older manifest entries keep working.
function readingSources(meta) {
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
  try {
    const ar = await fetch(srcPath(slug, sid, 'audio.json'));
    if (ar.ok) state.audio = await ar.json();
  } catch (e) { /* no recorded audio available */ }
  // Prefer the slim pitch payload (no heavy per-frame `raw` arrays ≈ 40% smaller);
  // fall back to the original monolith if the slim file hasn't been generated yet.
  try {
    let pr = await fetch(srcPath(slug, sid, 'pitch.slim.json'));
    if (!pr.ok) pr = await fetch(srcPath(slug, sid, 'pitch.json'));
    if (pr.ok) state.pitch = await pr.json();
  } catch (e) { /* no extracted pitch available */ }
  try {
    const sr = await fetch(srcPath(slug, sid, 'shapes.json'));
    if (sr.ok) state.shapes = (await sr.json()).shapes;
  } catch (e) { /* no averaged trope shapes available */ }
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

async function loadData(slug) {
  const meta = AVAILABLE.find((p) => p.slug === slug);
  const [resp, tikkun] = await Promise.all([
    fetch(meta.file),
    loadTikkunData().catch((e) => {
      console.warn('[tikkun] fixed page data unavailable; using continuous fallback', e);
      return null;
    }),
  ]);
  state.data = await resp.json();
  state.tikkun = tikkun;
  state.slug = slug;
  state.selectedVerse = null;
  if (state.aliyah) setAliyahLayout(false); // leave aliyah layout when the reading changes
  state.aliyah = null;
  // Resolve which recorded voice (audio source) to load for this reading, then
  // fetch its recorded-chant / pitch / shapes data. Honours the user's saved
  // voice preference when this reading offers it, else the reading's default.
  state.sources = readingSources(meta);
  const effectiveSource = resolveAudioSource(state.sources);
  await loadAudioSource(slug, effectiveSource);
  renderSourceSelector();
  const par = state.data.parashah;
  $('textTitle').textContent = par
    ? `${par.en} — ${par.he}`
    : `${state.data.book.en} ${state.data.chapter} — ${state.data.book.he}`;
  $('srcVersion').textContent = state.data.heVersionTitle || state.data.versionTitle || 'Masoretic text';
  renderVerses();
  renderAliyot();
  renderStageBar();
  renderGuide();   // redraw the trope diagrams now that this reading's averaged shapes are in
  applyHighlight();
  $('practice').classList.remove('aliyah-fill');
  $('practice').innerHTML = '<p class="empty">Select a verse on the left to begin practicing.</p>';
  // Offline: register any already-downloaded audio for this reading so playback
  // uses local blobs, and refresh the "⬇ Offline" button to reflect its state.
  try {
    await offline.primeReading(readingAudioFiles());
  } catch (e) { /* offline store unavailable */ }
  refreshOfflineButton();
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

function pitchVerse(verseN) {
  return state.pitch && state.pitch.verses && state.pitch.verses[String(verseN)];
}

// Build the coach line (note steps derived from the recording) for a set of
// unit segments, laid out on a shared time window (the exact recorded times), so
// it aligns with the time-aligned spectrogram and the stretched word overlay.
function buildCoach(unitSegs, verseN = state.selectedVerse) {
  const pv = pitchVerse(verseN);
  if (!pv) return null;
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

// The range of verses to show, derived from the current portion. Annual shows
// the whole parashah; a triennial year shows only that year's span. We use the
// year's actual aliyot (first start .. last end) so the verses on screen match
// exactly what you practice that year, falling back to even thirds only if a
// reading has no triennial aliyot data.
function divisionRange() {
  const n = state.data.verses.length;
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

function renderVerses() {
  // The pointed per-verse list always renders here; the STA"M Torah column is a
  // separate, optional pane (renderScrollPane) shown alongside it in scroll view.
  renderScrollPane();
  const box = $('verses');
  box.innerHTML = '';
  const [start, end] = divisionRange();
  // Aliyah cards are woven in after the verse that completes each aliyah; the
  // maftir card follows the aliyah it shares an ending pasuk with (same end
  // verse), so several cards can attach to one verse.
  const maxV = state.data.verses.length;
  const cardsByEnd = {};
  const attachCard = (a) => {
    const key = Math.min(a.end, maxV);
    (cardsByEnd[key] = cardsByEnd[key] || []).push(buildAliyahCard(a));
  };
  aliyotForReading(state.cycle, state.triYear).forEach(attachCard);
  const maftir = maftirForReading(state.cycle, state.triYear);
  if (maftir) attachCard(maftir);
  for (let i = start; i <= end; i++) {
    const v = state.data.verses[i - 1];
    const div = document.createElement('div');
    div.className = 'verse' + (state.selectedVerse === i ? ' active' : '');
    div.dataset.v = i;
    // No single summed verse score: show the base full-verse accuracy as the
    // badge, with a pip per earned handicap skill (each its own score).
    const modeScores = store.getVerseModeScores(state.slug, i);
    const base = modeScores.base || 0;
    const tokens = tokenize(v.text);
    const segs = buildLineMelody(tokens);
    // Per-token overlay score, chosen by the current overlay mode, so the left
    // column can show word / phrase / whole-verse skill on the text itself.
    const ov = overlayScorer(i, segs);
    const heHtml = tokens
      .map((t, wi) => wordSpan(t, segs[wi], state, wi, ov.score(wi), ov.lo, ov.hi))
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
    div.innerHTML = `<span class="vnum">${state.data.book.he} ${verseRefLabel(v, i)}${state.data.multiChapter ? '' : ` · v${i}`}</span>${badge}
      <div class="vbody${state.showEnglish ? ' bilingual' : ''}">${enHtml}<div class="hebrew ${state.scroll ? 'scroll' : ''}">${heHtml}</div></div>`;
    // Clicking a single word jumps to word practice for that word; clicking
    // elsewhere in the verse just selects the verse.
    div.addEventListener('click', (e) => {
      const wEl = e.target.closest('.w');
      if (wEl && wEl.dataset.wi != null) practiceWord(i, parseInt(wEl.dataset.wi, 10));
      else selectVerse(i);
    });
    box.appendChild(div);
    if (cardsByEnd[i]) cardsByEnd[i].forEach((el) => box.appendChild(el));
  }
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
  const segs = buildLineMelody(tokenize(state.data.verses[verseN - 1].text));
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
  gotoPractice(verseN, cur.unit === 'line' ? cur.id : 4, 0);
}

// Jump to a specific stage (e.g. a handicap skill badge).
function practiceStage(verseN, levelId) {
  gotoPractice(verseN, levelId, 0);
}

function gotoPractice(verseN, levelId, unitIndex) {
  state.selectedVerse = verseN;
  state.level = levelId;
  state.unitIndex = unitIndex;
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
  const start = box && box.querySelector('.range-start');
  if (!pane || !start || !pane.clientHeight) return;
  const delta = start.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  pane.scrollTop = Math.max(0, pane.scrollTop + delta - 48);
  delete box.dataset.scrollToStart;
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
  if (title) title.innerHTML = 'Torah column (STA&ldquo;M)';
  if (!state.scrollView) { box.innerHTML = ''; return; }
  const [start, end] = divisionRange();
  const layoutKey = `${state.slug}:${start}-${end}`;
  const previousKey = box.dataset.layoutKey;
  const tikkun = renderTikkunPages(state.tikkun, state.data, {
    focusStart: start,
    focusEnd: end,
    contextStart: start,
    contextEnd: end,
    selectedVerse: state.selectedVerse,
  });
  if (tikkun) {
    box.innerHTML = tikkun.html;
    box.dataset.layoutKey = layoutKey;
    if (previousKey !== layoutKey) box.dataset.scrollToStart = '1';
    bindScrollWordSelection(box);
    fitScrollPages();
    if (box.dataset.scrollToStart === '1') requestAnimationFrame(scrollTikkunStartIntoView);
    applyScrollWordHits();
    return;
  }

  let html = '<div class="scroll-column">';
  for (let i = start; i <= end; i++) {
    const segs = buildLineMelody(tokenize(state.data.verses[i - 1].text));
    segs.forEach((s) => {
      const sel = state.selectedVerse === i ? ' sel' : '';
      html += `<span class="sw${sel}" data-verse="${i}" data-widx="${s.index}" data-taam="${s.taam == null ? 'none' : s.taam}" data-fam="${s.familyId}">${escapeHtml(toScroll(s.token))}</span> `;
    });
  }
  html += '</div>';
  box.innerHTML = html;
  bindScrollWordSelection(box);
  // Re-apply the per-word accuracy shading after any rebuild (a toolbar toggle,
  // pasuk change, etc.), so the STA"M column keeps its last take's clue.
  applyScrollWordHits();
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
    box.innerHTML = tikkun.html;
  } else {
    const scrollHtml = [];
    for (let n = from; n <= to; n++) {
      const segs = buildLineMelody(tokenize(state.data.verses[n - 1].text));
      const inAliyah = n >= first && n <= last;
      const words = segs.map((s, wi) => `<span class="sw${inAliyah ? '' : ' ctx'}" data-verse="${n}" data-widx="${wi}">${escapeHtml(toScroll(s.token))}</span>`).join(' ');
      scrollHtml.push(`<span class="al-verse${inAliyah ? '' : ' ctx'}">${words}</span>`);
    }
    box.innerHTML = `<div class="scroll-column aliyah-scroll" id="aliyahScroll">${scrollHtml.join(' ')}</div>`;
  }
  const title = document.querySelector('#scrollpane .pane-title');
  if (title) title.innerHTML = `${a.n === 'M' ? 'Maftir' : 'Aliyah ' + a.n} <span class="hint" style="text-transform:none;letter-spacing:0">STA&ldquo;M</span>`;
  fitScrollPages();
  // Re-apply the start/end cues after any rebuild (e.g. a toolbar toggle) so the
  // yad markers survive re-renders of the pane.
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
  const par = parashahForReading();
  if (!par) { box.innerHTML = ''; return; }
  const list = aliyotForReading(state.cycle, state.triYear);
  const cycleLabel = state.cycle === 'triennial' ? `Triennial · Year ${state.triYear}` : 'Annual';
  let html = `<div class="aliyot-head">${par.he} <span class="hint">${cycleLabel} · ${par.ref}</span></div>`;
  html += list.length
    ? '<p class="hint aliyot-note">Each aliyah appears in the text below, after the pesukim that unlock it.</p>'
    : `<p class="hint aliyot-note">This cycle's reading falls outside the loaded chapter (${state.data.book.en} ${state.data.chapter}). Switch cycle or add more chapters.</p>`;
  box.innerHTML = html;
}

// A single aliyah (or maftir) card element, inserted inline after its last
// unlocking pasuk. The maftir (a.n === 'M') repeats the closing pesukim, so it's
// labelled distinctly but otherwise practised and scored just like an aliyah.
function buildAliyahCard(a) {
  const isMaftir = a.n === 'M';
  const r = aliyahReadiness(a);
  const score = store.getAliyahScore(state.slug, state.cycle, state.triYear, a.n);
  const pct = r.total ? Math.round((r.ready / r.total) * 100) : 0;
  const open = state.aliyah && state.aliyah.n === a.n && state.aliyah.cycle === state.cycle && state.aliyah.year === state.triYear;
  const badge = score > 0 ? `<span class="al-score" style="background:${scoreColor(score)}">${score}</span>` : '';
  const unit = isMaftir ? 'maftir' : 'aliyah';
  const action = r.done
    ? `<button class="al-go">${score > 0 ? '↻ Chant again' : `▶ Chant ${unit}`}</button>`
    : `<span class="al-lock" title="Reach stage ${ALIYAH_READY_LEVEL} on every pasuk first">🔒 ${r.ready}/${r.total} pesukim ready</span>`;
  const el = document.createElement('div');
  el.className = `aliyah${isMaftir ? ' maftir' : ''}${open ? ' open' : ''}${r.done ? ' ready' : ''}`;
  const label = isMaftir
    ? `Maftir <span class="hint">${a.ref}</span>`
    : `Aliyah ${a.n} <span class="hint">ends ${a.ref}</span>`;
  el.innerHTML = `
    <div class="al-main">
      <span class="al-n">${isMaftir ? 'מפ' : toHebrewNum(a.n)}</span>
      <span class="al-label">${label}</span>
      ${badge}
    </div>
    <div class="al-prog"><span style="width:${pct}%;background:${r.done ? 'var(--good)' : 'var(--accent-2)'}"></span></div>
    <div class="al-actions">${action}</div>`;
  const go = el.querySelector('.al-go');
  if (go) go.addEventListener('click', () => openAliyah(a));
  return el;
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
  } else if (state._scrollViewBeforeAliyah != null) {
    state.scrollView = state._scrollViewBeforeAliyah;
    state._scrollViewBeforeAliyah = null;
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
    const vsegs = buildLineMelody(tokenize(state.data.verses[n - 1].text));
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
  loadRawContoursDeferred(state.slug); // phase-2: an aliyah spans many verses → load the raw monolith
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
      <h2>${par.he} · ${a.n === 'M' ? 'Maftir' : 'Aliyah ' + a.n} <span class="stagetag">${a.cycle === 'triennial' ? 'Triennial Yr ' + a.year : 'Annual'} · ${a.ref}</span></h2>
      <button id="alBack">← Verses</button>
    </div>
    <p class="leveldesc">Chant the whole aliyah from the bare scroll on the left. A grey outline marks the current spot and, subtly, where to begin and end — as in a real reading. Faded text is the surrounding scroll for context.</p>
    <div class="al-cuebar">
      <span class="label">Outline:</span>
      <span class="seg" id="aliyaCueSeg">
        <button class="cue" data-cue="word">Word</button>
        <button class="cue" data-cue="phrase">Phrase</button>
      </span>
    </div>
    <div class="aliyah-top">
    <div class="transport">
      <button class="primary" id="alGuide" title="Play the real chant across the whole aliyah (Space)">▶ Guided read (real chant)</button>
      <button class="warn" id="alRec" title="Record your solo chant of the aliyah (↓)">● Record my aliyah</button>
      <button id="alDuet" title="Sing along with the real chant while recording (↑)">⇅ Duet (sing along)</button>
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
  // One-time: bring the aliyah's start into view (with context above it).
  const box = $('aliyahScroll');
  const startEl = box && box.querySelector('.sw.yad-start');
  if (startEl) startEl.scrollIntoView({ block: 'center' });
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
}

function setAliyahButtons(running) {
  const g = $('alGuide'), r = $('alRec'), d = $('alDuet'), s = $('alStop');
  if (g) g.disabled = running;
  if (r) r.disabled = running;
  if (d) d.disabled = running;
  if (s) s.disabled = !running;
}

// Subtle start/end cueing: glow the aliyah's first word (where to begin) always,
// and its last word (where to end) once the read/recording completes.
function markAliyahEnds(tl, atEnd) {
  const box = $('aliyahScroll');
  if (!box) return;
  box.querySelectorAll('.yad-start,.yad-end').forEach((e) => e.classList.remove('yad-start', 'yad-end'));
  const first = tl.segs[0];
  if (first) {
    const el = box.querySelector(`.sw[data-verse="${first.n}"][data-widx="0"]`);
    if (el) el.classList.add('yad-start');
  }
  if (atEnd) {
    const last = tl.segs[tl.segs.length - 1];
    if (last && last.vsegs.length) {
      const el = box.querySelector(`.sw[data-verse="${last.n}"][data-widx="${last.vsegs.length - 1}"]`);
      if (el) el.classList.add('yad-end');
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
  const box = $('aliyahScroll');
  if (!box) return;
  box.querySelectorAll('.yad-cur').forEach((e) => e.classList.remove('yad-cur'));
  if (verseN == null) return;
  let members = [widx];
  if (state.aliyahCue === 'phrase' && state._aliyaTl) {
    const seg = state._aliyaTl.segs.find((s) => s.n === verseN);
    if (seg) members = aliyahPhraseMembers(seg, widx);
  }
  members.forEach((wi) => {
    const el = box.querySelector(`.sw[data-verse="${verseN}"][data-widx="${wi}"]`);
    if (el) el.classList.add('yad-cur');
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
  paintWordTint($('aliyahScroll'), verseN, widx, w.inband / w.total);
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
  const el = box.querySelector(`.sw[data-verse="${verseN}"][data-widx="${widx}"]`);
  if (!el) return;
  el.classList.remove('word-hit', 'word-partial', 'word-miss');
  el.classList.add(frac >= 0.66 ? 'word-hit' : frac >= 0.33 ? 'word-partial' : 'word-miss');
}

function stopAliyah() {
  state._aliyaRunning = null;
  window.__cantillateBusy = false;
  clearTimeout(state._aliyaTimer);
  if (state._aliyaGuideTimers) { state._aliyaGuideTimers.forEach(clearTimeout); state._aliyaGuideTimers = []; }
  stopVerseAudio();
  stopMic();
  stopLiveMeter();
}

// Guided read: play the real chant across the whole aliyah, chaining verses, the
// yad following the current word — a listening/reading run to learn the flow.
function playAliyahGuided(tl) {
  stopAliyah();
  state._aliyaRunning = 'guide';
  state._aliyaEnded = false;
  setAliyahButtons(true);
  markAliyahEnds(tl, false);
  let i = 0;
  const playNext = () => {
    if (state._aliyaRunning !== 'guide') return;
    if (i >= tl.segs.length) { finishGuide(tl); return; }
    const seg = tl.segs[i];
    if (!seg.file) { i++; playNext(); return; }
    $('aliyaResult').innerHTML = `<span class="hint">Reading verse ${seg.n}…</span>`;
    playSegment(seg.file, seg.aStart, seg.aEnd, {
      onProgress: (t01) => { if (seg.coach) highlightAliyah(seg.n, wordAtTime(seg.coach, t01)); },
      onEnd: () => { i += 1; playNext(); },
      onError: () => { i += 1; playNext(); },
    });
  };
  playNext();
}

function finishGuide(tl) {
  if (state._aliyaRunning !== 'guide') return;
  state._aliyaRunning = null;
  state._aliyaEnded = true;
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
  // Mark your best + the record holder for this aliyah on the meter.
  {
    const a = state.aliyah;
    if (a) {
      const parId = scores.parashaIdFor(parashahForReading(), state.slug);
      showRecordMeterMarks('aliyaMeterFill', 'aliyah', scores.aliyahIdFor(parId, a.cycle, a.year, a.n), store.getAliyahScore(state.slug, a.cycle, a.year, a.n));
    }
  }
  const leadIn = 500;
  const t0 = performance.now() + leadIn;
  $('aliyaResult').innerHTML = duet
    ? '<span class="hint">Duet — sing along with the real chant (use headphones + a wired mic) as you follow the yad.</span>'
    : '<span class="hint">Get ready… begin at the glowing first word and follow the yad.</span>';
  // Duet: play the real chant in time with your take, one segment per verse,
  // each scheduled at its slot on the shared timeline so the two stay aligned.
  if (duet) {
    for (const seg of tl.segs) {
      if (!seg.file) continue;
      const delay = Math.max(0, (t0 + seg.gStart * 1000) - performance.now());
      state._aliyaGuideTimers.push(setTimeout(() => {
        if (state._aliyaRunning !== 'rec') return;
        playSegment(seg.file, seg.aStart, seg.aEnd, { onEnd: () => {}, onError: () => {} });
      }, delay));
    }
  }
  await startMic((hz, rms) => {
    if (state._aliyaRunning !== 'rec') return;
    const now = performance.now();
    if (now < t0) return;
    const tG = (now - t0) / 1000;
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
  state._aliyaTimer = setTimeout(() => finishAliyahRecord(tl), leadIn + tl.total * 1000 + 900);
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
  const box = $('aliyahScroll');
  if (!box) return;
  box.querySelectorAll('.sw.word-hit, .sw.word-partial, .sw.word-miss')
    .forEach((e) => e.classList.remove('word-hit', 'word-partial', 'word-miss'));
}

function applyAliyahWordHits(perVerse) {
  const box = $('aliyahScroll');
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
  window.__cantillateBusy = false;
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
  store.recordAliyahScore(state.slug, a.cycle, a.year, a.n, score);
  // Log this continuous take (with the duet flag) for the score-over-runs
  // colourbar, and separately record a genuine solo chain so the leaderboard can
  // rank solo takes above duet takes above a derived-from-pesukim floor.
  store.recordAliyahRunLog(state.slug, a.cycle, a.year, a.n, score, assisted);
  if (!assisted && raw > 0) store.recordAliyahSolo(state.slug, a.cycle, a.year, a.n, raw);
  store.addPracticeSeconds(tl.total || 0);
  markAliyahEnds(tl, true);
  setAliyahButtons(false);
  const msg = score <= 0 ? 'No clear pitch captured — check your mic and follow the yad.'
    : assisted ? 'Nice duet. Now try it solo — a solo take can score higher.'
      : score >= 80 ? 'Beautiful — that\'s reading-ready.'
        : 'Keep polishing the weaker pesukim, then run the aliyah again.';
  $('aliyaResult').innerHTML = `<span class="scorelabel">${assisted ? 'Duet accuracy' : (a.n === 'M' ? 'Maftir accuracy' : 'Aliyah accuracy')}</span> `
    + `<span class="num">${score}</span><span class="ceil"> / 100</span>`
    + `<br><span class="hint">${msg}</span>`;
  renderAliyot();
  maybePushScopes();
  // Paint the per-word "notes hit" clue LAST, so no earlier render can wipe it,
  // and remember it so a later pane rebuild (toolbar toggle) can re-apply it.
  state._aliyaWordHits = perVerse;
  applyAliyahWordHits(perVerse);
}

// Persistent top-of-window stage selector. Any stage is navigable; stages not
// yet unlocked for the current verse are marked, and opening one shows a locked
// page (see renderPractice).
function selectStage(levelId) {
  state.level = levelId;
  state.unitIndex = 0;
  renderStageBar();
  if (state.selectedVerse != null) renderPractice();
}

function renderStageBar() {
  const bar = $('stageBar');
  if (!bar) return;
  const unlocked = state.selectedVerse != null ? store.getVerseLevel(state.slug, state.selectedVerse) : 1;
  const btns = LEVELS.map((l) => {
    const locked = l.id > unlocked;
    const cur = l.id === state.level;
    return `<button class="stagebtn ${cur ? 'cur' : ''} ${locked ? 'locked' : ''}" data-lvl="${l.id}">`
      + `${locked ? '🔒 ' : '✓ '}${l.id}. ${l.label}</button>`;
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

function currentUnits() {
  const v = state.data.verses[state.selectedVerse - 1];
  const tokens = tokenize(v.text);
  const segs = buildLineMelody(tokens);
  const level = levelById(state.level);
  if (level.unit === 'word') return groupByMaqaf(segs);
  if (level.unit === 'phrase') return splitPhrases(segs);
  return [segs];
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
  ensureRawForVerse(state.selectedVerse); // phase-2: load this pasuk's underlay on demand
  state.verseSegs = buildLineMelody(tokenize(v.text));
  const units = currentUnits();
  state.units = units;
  state.unitIndex = Math.max(0, Math.min(state.unitIndex, units.length - 1));
  const unitSegs = units[state.unitIndex];
  state.unitSegs = unitSegs;
  state.focusIndex = unitSegs[0] ? unitSegs[0].index : 0;

  const aids = level.aids;
  const renderCtx = { showVowels: aids.showVowels, showTaamim: aids.showTaamim, scroll: aids.scroll };

  const hasReal = !!verseAudio(state.selectedVerse);

  const chips = [
    chip('Vowels', aids.showVowels),
    chip('Cantillation', aids.showTaamim),
    chip('Scroll font', aids.scroll),
  ].join('');

  const p = $('practice');
  p.innerHTML = `
    <div class="phead">
      <h2>${state.data.book.he} ${verseRefLabel(v, state.selectedVerse)}${state.data.multiChapter ? '' : ` · v${state.selectedVerse}`}<span class="stagetag">${level.id}. ${level.label}</span></h2>
      <div class="aidchips">${chips}</div>
      ${units.length > 1 ? `<div class="unit-nav">
        <button id="uPrev">◀</button>
        <span class="u-label">${cap(level.unit)} ${state.unitIndex + 1}/${units.length}</span>
        <button id="uNext">▶</button>
      </div>` : ''}
      <span class="mode-indicator" id="modeIndicator"></span>
      <label class="readsize" title="Reading size — enlarge the Hebrew, shrink the notation">
        <span class="rs-ico">א</span>
        <input type="range" id="readSize" min="${READ_MIN}" max="${READ_MAX}" step="0.1" value="${state.readScale}" aria-label="Reading size">
      </label>
      ${hasReal ? '<span class="keyshint" title="Tap a word, or keys: ← → next/prev word · Space replay · ↓ record · ↑ sing along · Esc stop">⌨</span>' : ''}
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
      <button class="${hasReal ? '' : 'primary'}" id="btnPlay">▶ Hear voice guide</button>
      <button id="btnTonic">Give me the tonic</button>
      <button class="warn" id="btnRec">● Record my try</button>
      <button id="btnSing">▶● Sing along</button>
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
  // Pasuk-advance arrows (STA"M view): left = next pasuk (RTL), right = previous.
  const pNext = $('pEdgeNext'), pPrev = $('pEdgePrev');
  if (pNext) pNext.addEventListener('click', () => goToVerse(1));
  if (pPrev) pPrev.addEventListener('click', () => goToVerse(-1));
  // Large call-to-action (level 8): open the full STA"M scroll on demand rather
  // than forcing it on. The scroll's own ✕ closes it back to this coach.
  const openStam = $('openStam');
  if (openStam) openStam.addEventListener('click', () => {
    state.scrollView = true; syncToggleUI(); renderVerses(); maybeShowRotate();
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
  const needW = Math.round(unitSegs.length * fpx * 4.0); // room per word at this size
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
  state.view = new ContourView($('contour'));
  state.spectro = new Spectrogram($('spectro'));
  state.userSpectro = new Spectrogram($('userSpectro'));
  const coach = buildCoach(unitSegs);
  state.coach = coach;
  const modeName = level.unit === 'word' ? 'Single-word focus'
    : level.unit === 'phrase' ? 'Phrase timeline' : 'Whole-verse timeline (piano-trope)';
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
  $('btnPlay').addEventListener('click', playTarget);
  $('btnTonic').addEventListener('click', () => playTone(state.tonicHz, 1.2));
  $('btnRec').addEventListener('click', () => startRecording());
  $('btnSing').addEventListener('click', () => startRecording({ singAlong: true }));
  $('btnStop').addEventListener('click', stopAll);
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

// Compute the mp3 time range for a single display token within a verse, using
// the Masoretic word onsets (maqaf-joined tokens span multiple onsets).
function wordTimeRange(verseN, tokenIndex) {
  const info = verseAudio(verseN);
  if (!info) return null;
  const onsets = info.onsets;
  if (tokenIndex < 0 || tokenIndex >= onsets.length) return null;
  const start = onsets[tokenIndex];
  let end;
  if (tokenIndex + 1 < onsets.length) end = onsets[tokenIndex + 1];
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
  const verseSegs = buildLineMelody(tokenize(state.data.verses[state.selectedVerse - 1].text));
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
  $('result').innerHTML = '<span class="hint">Playing the recorded chant of the whole verse…</span>';
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
    + ` style="color:${textColor}${bg}">${inner}</span>`;
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
  const words = document.querySelectorAll('.hebrew .w');
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
  const swEl = document.querySelector(`#scrollVerses .sw[data-verse="${v}"][data-widx="${gi}"]`);
  if (swEl) swEl.classList.add('cur');
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
  container.style.height = Math.round(fpx * 1.35) + 'px';
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
    if (mode === 'trope') span.innerHTML = renderWordTropeColored(ow.seg.token, aids, ow.seg.color);
    else span.textContent = renderWord(ow.seg.token, aids);
    container.appendChild(span);
  });
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
  // Voice guide holds the window closed (recStart in the future) until the audio
  // actually begins; every other mode starts after a fixed lead-in.
  state.recStart = voiceGuide ? Infinity : performance.now() + leadIn;

  await startMic((hz, rms, frame) => {
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
}

// Play the coach's target contour as audio only (no visual callbacks), so the
// live recording keeps driving the playhead/highlight while the singer hears
// the exact shape being scored.
function playGuideAudioOnly() {
  if (!state.coach || !state.coach.steps.length) return;
  singSteps(state.coach.steps, { tonicHz: state.tonicHz, durationSec: state.coach.dur });
}

function stopAll() {
  stopVerseAudio();
  if (state.playingReal) {
    state.playingReal = false;
    document.querySelectorAll('.verse.active .w, #timelineWords .w, #scrollVerses .sw').forEach((w) => w.classList.remove('cur'));
    if (state.view) state.view.setPlayhead(null);
    $('btnStop').disabled = true;
  }
  if (state.recording) finishRecording();
  else stopPlayback();
}

function finishRecording() {
  if (!state.recording) return;
  const assisted = !!state._singAlong; // duet take: scored lower, capped (see scores.js)
  state.recording = false;
  state._singAlong = false;
  window.__cantillateBusy = false;
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
}

// Greyed page shown when navigating to a stage not yet unlocked for this verse.
function renderLockedPage(level, unlocked) {
  const frontier = levelById(unlocked);
  const v = state.data.verses[state.selectedVerse - 1];
  const p = $('practice');
  p.innerHTML = `
    <div class="phead">
      <h2>${state.data.book.he} ${verseRefLabel(v, state.selectedVerse)}${state.data.multiChapter ? '' : ` · verse ${state.selectedVerse}`} <span class="stagetag">Stage ${level.id}: ${level.label}</span></h2>
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
