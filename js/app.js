import { tokenize, renderWord, toScroll } from './hebrew.js';
import { buildLineMelody, splitPhrases, FAMILIES, markGlyph } from './trope.js';
import { singSteps, playTone, stopPlayback } from './audio.js';
import { playSegment, stopVerseAudio } from './realaudio.js';
import { startMic, stopMic } from './pitch.js';
import { ContourView, Spectrogram, scoreTrail, sampleContour } from './viz.js';
import { LEVELS, levelById, VERSE_MODES, skillForLevel } from './levels.js';
import { aliyotFor, parashahOf, currentTriennialYear } from './aliyot.js';
import * as store from './store.js';
import * as auth from './auth.js';
import * as scores from './scores.js';

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
  audio: null,        // per-verse recorded-chant ranges
  pitch: null,        // per-word extracted note steps
  shapes: null,       // averaged per-trope shapes (for legend icons)
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
};

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
  await loadData(AVAILABLE[0].slug);

  sel.addEventListener('change', () => loadData(sel.value));
  $('tonic').addEventListener('change', (e) => { state.tonicHz = parseFloat(e.target.value); });

  bindToggle('tgVowels', () => { state.showVowels = !state.showVowels; refreshText(); });
  bindToggle('tgTaamim', () => { state.showTaamim = !state.showTaamim; refreshText(); });
  bindToggle('tgFont', () => { state.scroll = !state.scroll; refreshText(); });
  bindToggle('tgEnglish', () => { state.showEnglish = !state.showEnglish; renderVerses(); });
  $('overlaySeg').querySelectorAll('.ov').forEach((b) => {
    b.addEventListener('click', () => { state.overlay = b.dataset.ov; syncToggleUI(); renderVerses(); });
  });
  bindToggle('tgScrollView', () => { state.scrollView = !state.scrollView; renderVerses(); });

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
  renderFamilyBar();
  document.addEventListener('keydown', onKey);
  setupSplitter();
  setupLeftSize();
  setupPasukDrawer();
  setupWordLookup();
  setupAuth();
  setupLeaderboard();
  setupAliyotEditor();
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
  if (backdrop) backdrop.addEventListener('click', closePasukDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closePasukDrawer);
  if (closeBtnScroll) closeBtnScroll.addEventListener('click', closePasukDrawer);
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
  auth.initAuth({
    onUserChange: (user, info) => {
      authState.configured = !!(info && info.configured);
      authState.user = user;
      authState.busy = false;
      renderAuthBox();
    },
    // Cloud progress merged into local on sign-in — refresh everything so the
    // newly-synced scores/levels show up immediately.
    onProgressMerged: () => refreshProgressViews(),
  });
}

function renderAuthBox() {
  const box = $('authBox');
  if (!box) return;
  if (authState.user) {
    const u = authState.user;
    const initial = (u.displayName || u.email || '?').trim().charAt(0).toUpperCase();
    const avatar = u.photoURL
      ? `<img class="av-img" src="${escapeHtml(u.photoURL)}" alt="" referrerpolicy="no-referrer" />`
      : `<span class="av-fallback">${escapeHtml(initial)}</span>`;
    box.innerHTML = `
      <span class="auth-user" title="${escapeHtml(u.email || u.displayName || '')}">
        ${avatar}<span class="auth-name">${escapeHtml(u.displayName || u.email || 'Signed in')}</span>
      </span>
      <button id="btnSignOut" class="auth-btn" title="Sign out">Sign out</button>`;
    $('btnSignOut').addEventListener('click', async () => {
      try { await auth.signOutUser(); } catch (e) { /* ignore */ }
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

let lbTab = 'aliyah';

// How many per-scope board tops we're willing to fetch on one browse render.
// Aliyot across the shipped readings stay well under this; the far larger pasuk
// set exceeds it, so for pesukim we only enrich the ones you've scored (keeping
// the modal snappy) — see renderScopeBrowse.
const MAX_BOARD_FETCH = 160;

async function openLeaderboard() {
  const modal = $('lbModal');
  const body = $('lbBody');
  if (!modal || !body) return;
  modal.hidden = false;
  renderLbShell(body);
}

// Tab strip + a body region that each tab fills in. "Overall" is the classic
// global XP board; "Aliyot"/"Pesukim" browse the top score for EVERY aliyah /
// pasuk across all readings (grouped by parashah), each row linking straight to
// practicing that unit — so the board doubles as a challenge directory.
function renderLbShell(body) {
  const tabs = [
    ['aliyah', 'Aliyot'],
    ['pasuk', 'Pesukim'],
    ['overall', 'Overall'],
  ];
  body.innerHTML = `<div class="lb-tabs">${tabs.map(([id, l]) =>
    `<button class="lb-tab ${lbTab === id ? 'on' : ''}" data-tab="${id}">${l}</button>`).join('')}</div>
    <div class="lb-tabbody" id="lbTabBody"><p class="lb-empty">Loading…</p></div>`;
  body.querySelectorAll('.lb-tab').forEach((b) => {
    b.addEventListener('click', () => { lbTab = b.dataset.tab; renderLbShell(body); });
  });
  renderLbTab();
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
      <td class="lb-who">${avatarHtml(r)}<span class="lb-name">${escapeHtml(r.name || 'Anonymous')}${isMe ? ' <span class="lb-youtag">you</span>' : ''}${cyc}${star}</span></td>
      ${numCols}
    </tr>`;
  }).join('');
  return `<table class="lb-table"><thead><tr><th></th><th>Reader</th>${cols.map((c) => `<th title="${escapeHtml(c.title || '')}">${c.label}</th>`).join('')}</tr></thead><tbody>${list}</tbody></table>`;
}

async function renderLbTab() {
  const el = $('lbTabBody');
  if (!el) return;
  const me = auth.getUser();

  if (lbTab === 'overall') {
    if (!auth.isConfigured()) { el.innerHTML = lbNotConfigured(); return; }
    el.innerHTML = '<p class="lb-empty">Loading…</p>';
    const rows = await auth.getLeaderboard(25);
    if (!rows.length) {
      el.innerHTML = `<p class="lb-empty">No one's on the board yet — ${me ? 'keep practicing to climb it!' : 'sign in and start practicing to be the first!'}</p>${localSummaryHtml()}`;
      return;
    }
    el.innerHTML = boardTable(rows, {
      me,
      cols: [
        { key: 'xp', label: 'XP', title: 'Sum of best whole-verse & aliyah accuracies' },
        { key: 'versesMastered', label: 'Verses', title: 'Verses at whole-verse stage or beyond' },
        { key: 'aliyotComplete', label: 'Aliyot', title: 'Aliyot chanted at 80+' },
      ],
    }) + (me ? '' : '<p class="hint lb-signin-note">Sign in to appear here.</p>');
    return;
  }

  // 'aliyah' | 'pasuk' — the browsable top-scores directory.
  renderScopeBrowse(lbTab);
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
      for (const a of list) {
        scopes.push({
          type: 'aliyah', slug: m.slug, cycle, year, n: a.n, ref: a.ref,
          refId: scores.aliyahIdFor(parId, cycle, year, a.n),
          parName,
          cycleLabel: cycle === 'triennial' ? `Triennial · Yr ${year}` : 'Annual',
          label: `Aliyah ${a.n}${a.ref ? ` · ${a.ref}` : ''}`,
          localBest: store.getAliyahScore(m.slug, cycle, year, a.n),
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

async function renderScopeBrowse(type) {
  const el = $('lbTabBody');
  if (!el) return;
  el.innerHTML = '<p class="lb-empty">Loading…</p>';
  const me = auth.getUser();
  const metas = await loadAllReadingsMeta();
  const scopes = type === 'aliyah' ? enumerateAliyahScopes(metas) : enumeratePasukScopes(metas);

  // Fetch shared record-holders: for the (small) aliyah set, all of them; for
  // the (large) pasuk set only the ones you've scored, to keep it responsive.
  const configured = auth.isConfigured();
  const canFetchAll = configured && scopes.length <= MAX_BOARD_FETCH;
  const toFetch = configured ? (canFetchAll ? scopes : scopes.filter((s) => s.localBest > 0)) : [];
  await Promise.all(toFetch.map(async (s) => { s.top = await boardTop(type, s.refId); }));

  const rows = scopes.map((s) => {
    const topScore = s.top ? s.top.score : 0;
    return { s, best: Math.max(topScore, s.localBest || 0) };
  }).filter((r) => r.best > 0);

  if (!rows.length) {
    const noun = type === 'aliyah' ? 'aliyah' : 'pasuk';
    el.innerHTML = `<p class="lb-empty">No ${noun} scores yet — record ${type === 'aliyah' ? 'an aliyah' : 'a pasuk'} to put it on the board.</p>` + localSummaryHtml();
    return;
  }

  // Group by parashah, sort rows within a group and groups by their best score.
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.s.parName)) groups.set(r.s.parName, []);
    groups.get(r.s.parName).push(r);
  }
  const groupArr = [...groups.entries()].map(([name, gr]) => {
    gr.sort((a, b) => b.best - a.best);
    return { name, gr, max: gr[0].best };
  }).sort((a, b) => b.max - a.max);

  _lbBrowse = [];
  const partial = configured && !canFetchAll;
  let html = `<p class="lb-scope">🏆 Top ${type === 'aliyah' ? 'aliyot' : 'pesukim'} across all readings — tap a row to practice &amp; challenge it`
    + `${partial ? ` <span class="hint">(showing the ${type === 'aliyah' ? 'aliyot' : 'pesukim'} you've scored)</span>` : ''}</p>`;
  for (const g of groupArr) {
    html += `<div class="lb-group"><h3 class="lb-group-h">📖 ${escapeHtml(g.name)}</h3><table class="lb-table"><tbody>`;
    for (const r of g.gr) {
      const s = r.s;
      const idx = _lbBrowse.push(s) - 1;
      const isMine = (s.localBest || 0) > 0;
      const holder = r.s.top
        ? `${avatarHtml(r.s.top)}<span class="lb-name">${escapeHtml(r.s.top.name || 'Anonymous')}${(me && r.s.top.uid === me.uid) ? ' <span class="lb-youtag">you</span>' : ''}</span>`
        : `<span class="lb-av fallback">★</span><span class="lb-name lb-you-only">You</span>`;
      const yourTag = (r.s.top && isMine) ? `<span class="lb-yourbest" title="Your best on this ${type}">you ${s.localBest}</span>` : '';
      html += `<tr class="lb-browserow" data-idx="${idx}" title="Practice &amp; challenge">
        <td class="lb-scopelbl"><b>${escapeHtml(s.label)}</b>${s.cycleLabel ? `<span class="lb-cyc-tag">${escapeHtml(s.cycleLabel)}</span>` : ''}</td>
        <td class="lb-who">${holder}${yourTag}</td>
        <td class="lb-num lb-bignum" style="color:${scoreColorSolid(r.best)}">${r.best}</td>
        <td class="lb-go">▶</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
  el.querySelectorAll('.lb-browserow').forEach((tr) => {
    tr.addEventListener('click', () => navigateToScope(_lbBrowse[parseInt(tr.dataset.idx, 10)]));
  });
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
    const list = aliyotForReading(scope.cycle, scope.triYear);
    const a = list.find((x) => x.n === scope.n)
      || defaultAliyot(scope.cycle, scope.triYear).find((x) => x.n === scope.n);
    if (a) openAliyah(a);
  } else {
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
      entries.push({ type: 'pasuk', refId: scores.pasukIdFor(state.data, n), score: sc, label: `${(state.data.book && state.data.book.en) || ''} ${verseRefLabel(state.data.verses[n - 1], n)}` });
    }
  }

  // Aliyah: for every DEFAULT partition (annual + each triennial year), the
  // max(direct take, derived floor from its pesukim).
  const partitions = [['annual', 0]];
  for (let y = 1; y <= 3; y++) partitions.push(['triennial', y]);
  for (const [cycle, year] of partitions) {
    const list = defaultAliyot(cycle, year);
    for (const a of list) {
      const childBests = [];
      for (let n = a.start; n <= Math.min(a.end, maxV); n++) {
        const b = pasukBest(n);
        if (b > 0) childBests.push(b);
      }
      const direct = store.getAliyahScore(state.slug, cycle, year, a.n);
      const sc = scores.deriveScore(direct, childBests);
      if (sc > 0) {
        entries.push({ type: 'aliyah', refId: scores.aliyahIdFor(parId, cycle, year, a.n), score: sc, cycle, label: `Aliyah ${a.n} · ${a.ref || ''}` });
      }
    }
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
function noteHeights() {
  const s = state.readScale || 1;
  const mobile = window.innerWidth <= 720;
  const cBase = mobile ? 150 : 210, sBase = mobile ? 90 : 120;
  const contour = Math.round(Math.max(mobile ? 66 : 88, cBase - (s - 1) * 62));
  const spectro = Math.round(Math.max(mobile ? 30 : 40, sBase - (s - 1) * 46));
  return { contour, spectro };
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
// in a control are left to the browser.
function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
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

// Clickable color key of trope families; click to highlight all members in the
// text, click again (or "Clear") to reset.
function renderFamilyBar() {
  const bar = $('famBar');
  if (!bar) return;
  const chips = FAMILIES.map((f) => {
    const glyphs = f.members
      .map((m) => `<span class="mk">${markGlyph(m)}</span>`)
      .join('');
    return `
    <button class="famchip" data-fam="${f.id}" style="--c:${f.color}">
      <span class="sw" style="background:${f.color}"></span>
      <span class="markicon">${glyphs}</span>${f.label}
    </button>`;
  }).join('');
  bar.innerHTML = `<span class="label">Trope families:</span>${chips}
    <button id="famClear" class="famclear">Clear</button>
    <span class="hint famhint">Connectors take the color of the accent they lead into.</span>`;
  bar.querySelectorAll('.famchip').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.fam;
      if (state.highlight && state.highlight.kind === 'family' && state.highlight.value === id) {
        state.highlight = null;
      } else {
        state.highlight = { kind: 'family', value: id };
      }
      applyHighlight();
    });
  });
  $('famClear').addEventListener('click', () => { state.highlight = null; applyHighlight(); });
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
  $('tgScrollView').classList.toggle('on', state.scrollView);
  document.body.classList.toggle('scroll-view', state.scrollView);
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

async function loadData(slug) {
  const meta = AVAILABLE.find((p) => p.slug === slug);
  const resp = await fetch(meta.file);
  state.data = await resp.json();
  state.slug = slug;
  state.selectedVerse = null;
  // Optional recorded-chant data (may not exist for every reading).
  state.audio = null;
  state.pitch = null;
  try {
    const ar = await fetch(`data/${slug}_audio.json`);
    if (ar.ok) state.audio = await ar.json();
  } catch (e) { /* no recorded audio available */ }
  // Prefer the slim pitch payload (no heavy per-frame `raw` arrays ≈ 40% smaller);
  // fall back to the original monolith if the slim file hasn't been generated yet.
  try {
    let pr = await fetch(`data/${slug}_pitch.slim.json`);
    if (!pr.ok) pr = await fetch(`data/${slug}_pitch.json`);
    if (pr.ok) state.pitch = await pr.json();
  } catch (e) { /* no extracted pitch available */ }
  // Phase 2: the faint-underlay `raw` contours are NOT loaded up front anymore.
  // They're fetched per-verse (tiny shard) when a pasuk is practiced, or as the
  // whole-reading monolith when an aliyah (many verses) is opened.
  _rawLoaded = new Set();
  _rawMonolithTried = false;
  state.shapes = null;
  try {
    const sr = await fetch(`data/${slug}_shapes.json`);
    if (sr.ok) state.shapes = (await sr.json()).shapes;
  } catch (e) { /* no averaged trope shapes available */ }
  const par = state.data.parashah;
  $('textTitle').textContent = par
    ? `${par.en} — ${par.he}`
    : `${state.data.book.en} ${state.data.chapter} — ${state.data.book.he}`;
  $('srcVersion').textContent = state.data.heVersionTitle || state.data.versionTitle || 'Masoretic text';
  renderVerses();
  renderAliyot();
  renderStageBar();
  $('practice').classList.remove('aliyah-fill');
  $('practice').innerHTML = '<p class="empty">Select a verse on the left to begin practicing.</p>';
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
    const rr = await fetch(`data/pitch/${slug}/${n}.raw.json`);
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
    const rr = await fetch(`data/${slug}_pitch.raw.json`);
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
  // Aliyah cards are woven in after the verse that completes each aliyah.
  const maxV = state.data.verses.length;
  const aliyahByEnd = {};
  aliyotForReading(state.cycle, state.triYear).forEach((a) => {
    aliyahByEnd[Math.min(a.end, maxV)] = a;
  });
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
    if (aliyahByEnd[i]) box.appendChild(buildAliyahCard(aliyahByEnd[i]));
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

// Render the whole reading as a continuous, justified Torah-scroll column:
// consonants only (no niqqud / te'amim / verse numbers), STA"M script, on
// parchment — a faithful representation of the scroll's format. This lives in
// its own pane (#scrollVerses) so it can sit beside the pointed verses rather
// than replacing them; it only populates when scroll view is on.
function renderScrollPane() {
  const box = $('scrollVerses');
  if (!box) return;
  if (!state.scrollView) { box.innerHTML = ''; return; }
  const [start, end] = divisionRange();
  let html = '<div class="scroll-column">';
  for (let i = start; i <= end; i++) {
    const segs = buildLineMelody(tokenize(state.data.verses[i - 1].text));
    segs.forEach((s) => {
      const sel = state.selectedVerse === i ? ' sel' : '';
      html += `<span class="sw${sel}" data-verse="${i}" data-taam="${s.taam == null ? 'none' : s.taam}" data-fam="${s.familyId}">${escapeHtml(toScroll(s.token))}</span> `;
    });
  }
  html += '</div>';
  box.innerHTML = html;
  box.querySelectorAll('.sw').forEach((el) => {
    el.addEventListener('click', () => selectVerse(parseInt(el.dataset.verse, 10)));
  });
}

function selectVerse(n) {
  state.selectedVerse = n;
  state.aliyah = null; // leave aliyah mode when a single verse is chosen
  closePasukDrawer();
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

// A single aliyah card element, inserted inline after its last unlocking pasuk.
function buildAliyahCard(a) {
  const r = aliyahReadiness(a);
  const score = store.getAliyahScore(state.slug, state.cycle, state.triYear, a.n);
  const pct = r.total ? Math.round((r.ready / r.total) * 100) : 0;
  const open = state.aliyah && state.aliyah.n === a.n && state.aliyah.cycle === state.cycle && state.aliyah.year === state.triYear;
  const badge = score > 0 ? `<span class="al-score" style="background:${scoreColor(score)}">${score}</span>` : '';
  const action = r.done
    ? `<button class="al-go">${score > 0 ? '↻ Chant again' : '▶ Chant aliyah'}</button>`
    : `<span class="al-lock" title="Reach stage ${ALIYAH_READY_LEVEL} on every pasuk first">🔒 ${r.ready}/${r.total} pesukim ready</span>`;
  const el = document.createElement('div');
  el.className = `aliyah${open ? ' open' : ''}${r.done ? ' ready' : ''}`;
  el.innerHTML = `
    <div class="al-main">
      <span class="al-n">${toHebrewNum(a.n)}</span>
      <span class="al-label">Aliyah ${a.n} <span class="hint">ends ${a.ref}</span></span>
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
  renderAliyot();
  renderAliyahView();
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
  const maxV = state.data.verses.length;
  const first = a.start, last = Math.min(a.end, maxV);
  const from = Math.max(1, first - ALIYAH_CONTEXT);
  const to = Math.min(maxV, last + ALIYAH_CONTEXT);
  // Render surrounding verses too (dimmed) so the aliyah's start and end are seen
  // in the context of the scroll's columns, like a real reading.
  const scrollHtml = [];
  for (let n = from; n <= to; n++) {
    const segs = buildLineMelody(tokenize(state.data.verses[n - 1].text));
    const inAliyah = n >= first && n <= last;
    const words = segs.map((s, wi) => `<span class="sw${inAliyah ? '' : ' ctx'}" data-verse="${n}" data-widx="${wi}">${escapeHtml(toScroll(s.token))}</span>`).join(' ');
    scrollHtml.push(`<span class="al-verse${inAliyah ? '' : ' ctx'}">${words}</span>`);
  }
  const p = $('practice');
  p.classList.add('aliyah-fill');
  p.innerHTML = `
    <div class="aliyah-view">
    <div class="phead">
      <h2>${par.he} · Aliyah ${a.n} <span class="stagetag">${a.cycle === 'triennial' ? 'Triennial Yr ' + a.year : 'Annual'} · ${a.ref}</span></h2>
      <button id="alBack">← Verses</button>
    </div>
    <p class="leveldesc">Chant the whole aliyah from the bare scroll. A grey outline marks the current spot and, subtly, where to begin and end — as in a real reading. Faded text is the surrounding scroll for context.</p>
    <div class="al-cuebar">
      <span class="label">Outline:</span>
      <span class="seg" id="aliyaCueSeg">
        <button class="cue" data-cue="word">Word</button>
        <button class="cue" data-cue="phrase">Phrase</button>
      </span>
    </div>
    <div class="aliyah-scroll scroll-column" id="aliyahScroll">${scrollHtml.join(' ')}</div>
    <div class="aliyah-dock">
    <div class="transport">
      <button class="primary" id="alGuide">▶ Guided read (real chant)</button>
      <button class="warn" id="alRec">● Record my aliyah</button>
      <button id="alStop" disabled>■ Stop</button>
    </div>
    <div class="livemeter" id="aliyaMeter" hidden>
      <span class="lm-label">Live aliyah</span>
      <div class="lm-track"><div class="lm-fill" id="aliyaMeterFill"></div></div>
      <span class="lm-val"><b id="aliyaMeterVal">0</b>%</span>
    </div>
    <div class="result" id="aliyaResult"><span class="hint">Listen to the guided read to learn the flow, then record your own chant of the whole aliyah.</span></div>
    </div>
    </div>
  `;
  const tl = aliyahTimeline(a);
  state._aliyaTl = tl;
  markAliyahEnds(tl, false);
  // One-time: bring the aliyah's start into view (with context above it).
  const startEl = $('aliyahScroll').querySelector('.sw.yad-start');
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
    renderAliyot();
    if (state.selectedVerse) renderPractice();
    else { $('practice').classList.remove('aliyah-fill'); $('practice').innerHTML = '<p class="empty">Select a verse on the left to begin practicing.</p>'; }
  });
  $('alGuide').addEventListener('click', () => playAliyahGuided(tl));
  $('alRec').addEventListener('click', () => recordAliyahRun(tl));
  $('alStop').addEventListener('click', () => { stopAliyah(); setAliyahButtons(false); });
}

function setAliyahButtons(running) {
  const g = $('alGuide'), r = $('alRec'), s = $('alStop');
  if (g) g.disabled = running;
  if (r) r.disabled = running;
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

function stopAliyah() {
  state._aliyaRunning = null;
  window.__cantillateBusy = false;
  clearTimeout(state._aliyaTimer);
  stopVerseAudio();
  stopMic();
  stopLiveMeter();
}

// Guided read: play the real chant across the whole aliyah, chaining verses, the
// yad following the current word — a listening/reading run to learn the flow.
function playAliyahGuided(tl) {
  stopAliyah();
  state._aliyaRunning = 'guide';
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
  setAliyahButtons(false);
  highlightAliyah(null);
  markAliyahEnds(tl, true);
  $('aliyaResult').innerHTML = '<span class="hint">That\'s the whole aliyah. Now record your own chant.</span>';
}

// Record run: one continuous mic session over the aliyah timeline. The yad paces
// you (start cue → moving pointer → end cue); afterward each verse slice is
// scored against its coach and averaged into the aliyah accuracy.
async function recordAliyahRun(tl) {
  stopAliyah();
  state._aliyaRunning = 'rec';
  window.__cantillateBusy = true; // hold off any service-worker auto-reload
  state._aliyaSamples = [];
  state._aliyaDiffs = [];
  setAliyahButtons(true);
  markAliyahEnds(tl, false);
  startLiveMeter('aliyaMeter', 'aliyaMeterFill', 'aliyaMeterVal');
  const leadIn = 500;
  const t0 = performance.now() + leadIn;
  $('aliyaResult').innerHTML = '<span class="hint">Get ready… begin at the glowing first word and follow the yad.</span>';
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
      highlightAliyah(seg.n, wordAtTime(seg.coach, t01));
      // Live meter: instantaneous accuracy vs a running key-offset estimate.
      if (hz > 0 && rms >= 0.01) {
        const rawT = 12 * Math.log2(hz / (seg.coach.tonicHz || 200));
        const tgt = sampleContour(seg.coach.points, t01);
        state._aliyaDiffs.push(tgt - rawT);
        if (state._aliyaDiffs.length > 200) state._aliyaDiffs.shift();
        feedLiveMeter((rawT + median(state._aliyaDiffs)) - tgt);
      }
    } else {
      highlightAliyah(null);
    }
  }, () => {});
  state._aliyaTimer = setTimeout(() => finishAliyahRecord(tl), leadIn + tl.total * 1000 + 900);
}

function scoreAliyahVerse(seg, samples) {
  if (!seg.coach || !seg.coach.points.length) return 0;
  const local = samples.filter((s) => s.tG >= seg.gStart && s.tG < seg.gEnd && s.hz > 0);
  if (local.length < 3) return 0;
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
  return Math.round(scoreTrail(trail, seg.coach.points));
}

function finishAliyahRecord(tl) {
  if (state._aliyaRunning !== 'rec') return;
  state._aliyaRunning = null;
  window.__cantillateBusy = false;
  clearTimeout(state._aliyaTimer);
  stopMic();
  stopLiveMeter();
  highlightAliyah(null);
  const samples = state._aliyaSamples || [];
  const perVerse = tl.segs.map((seg) => scoreAliyahVerse(seg, samples)).filter((x) => x > 0);
  const score = perVerse.length ? Math.round(perVerse.reduce((a, b) => a + b, 0) / perVerse.length) : 0;
  const a = state.aliyah;
  store.recordAliyahScore(state.slug, a.cycle, a.year, a.n, score);
  markAliyahEnds(tl, true);
  setAliyahButtons(false);
  const msg = score >= 80 ? 'Beautiful — that\'s reading-ready.'
    : score > 0 ? 'Keep polishing the weaker pesukim, then run the aliyah again.'
      : 'No clear pitch captured — check your mic and follow the yad.';
  $('aliyaResult').innerHTML = `<span class="scorelabel">Aliyah accuracy</span> `
    + `<span class="num">${score}</span><span class="ceil"> / 100</span>`
    + `<br><span class="hint">${msg}</span>`;
  renderAliyot();
  maybePushScopes();
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
  // The hardest level presents the text as a continuous Torah column.
  if (level.scrollColumn && !state.scrollView) {
    state.scrollView = true;
    syncToggleUI();
    renderVerses();
  }
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
    ${level.unit === 'line' && state.showEnglish && v.en ? `<p class="practice-en">${escapeHtml(v.en)}</p>` : ''}

    <div class="topstatus">
      <div class="result" id="result"><span class="hint">${hasReal
        ? 'Hear the real cantor, or use the voice guide, then record your try.'
        : (level.mode === 'listen' ? 'Listen, then record yourself repeating it.' : 'Follow the moving cue and sing along as you record.')}</span></div>
      <div class="livemeter" id="liveMeter" hidden>
        <span class="lm-label">Live ${level.unit === 'line' ? 'verse' : level.unit}</span>
        <div class="lm-track"><div class="lm-fill" id="liveMeterFill"></div></div>
        <span class="lm-val"><b id="liveMeterVal">0</b>%</span>
      </div>
    </div>

    <div class="timeline">
      <div class="cmp-legend">
        <span><span class="swatch coach"></span> coach</span>
        <span><span class="swatch real"></span> recording</span>
        <span><span class="swatch you"></span> you</span>
      </div>
      <div class="tl-scroll" id="tlScroll">
        <div class="tl-inner" id="tlInner">
          <div class="timeline-words hebrew ${aids.scroll ? 'scroll' : ''}" id="timelineWords"></div>
          <div class="canvas-wrap"><canvas class="contour" id="contour"></canvas></div>
          <div class="spectro-label">Example spectrogram <span class="hint">— fundamental (white) &amp; harmonics</span></div>
          <div class="canvas-wrap"><canvas class="spectro" id="spectro"></canvas></div>
          <div class="spectro-label">Your voice <span class="hint">— record to compare &amp; match the example</span></div>
          <div class="canvas-wrap"><canvas class="spectro" id="userSpectro"></canvas></div>
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

    <div class="legend">
      <h3>Cantillation in this ${level.unit} — tap a trope to highlight it in the text</h3>
      <div class="tropes" id="tropes"></div>
    </div>
  `;

  if (units.length > 1) {
    $('uPrev').addEventListener('click', () => goToUnit(state.unitIndex - 1, true));
    $('uNext').addEventListener('click', () => goToUnit(state.unitIndex + 1, true));
  }

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

  // Shrink the notation (contour + spectrograms) so the enlarged reading has
  // room — the notes cost the space, not the words.
  const nh = noteHeights();
  $('contour').style.height = nh.contour + 'px';
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
  const readSize = $('readSize');
  if (readSize) {
    // Live text resize while dragging (no rebuild), then re-render on release so
    // the note canvases are re-created crisply at their new heights.
    readSize.addEventListener('input', (e) => applyReadScale(parseFloat(e.target.value), false));
    readSize.addEventListener('change', (e) => applyReadScale(parseFloat(e.target.value), true));
  }

  renderLegend(unitSegs);
  renderAccuracyPanel();
  wireAccPanel();
  applyHighlight();
  // Start a scrolling line at its beginning (rightmost, RTL).
  if (scrolling) tlScroll.scrollLeft = tlScroll.scrollWidth - tlScroll.clientWidth;
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
  el.innerHTML =
      accTextRow(segs, layout)
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
    const tPts = coach.steps.filter((s) => s.w >= a && s.w <= b).flatMap((s) => [{ t: s.t0, p: s.p }, { t: s.t1, p: s.p }]);
    return tPts.length ? Math.round(scoreTrail(uS, tPts)) : 0;
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
  document.querySelectorAll('.verse.active .w, #timelineWords .w').forEach((w) => w.classList.remove('cur'));
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
  if (coach) {
    state.targetPoints = coach.points;
    state.view.setCoach({ steps: coach.steps, raw: coach.raw, wordBounds: coach.wordBounds });
    renderStretchedWords($('timelineWords'), coach, aidsForLevel(), verseSegs);
    wireTimelineWordClicks(verseSegs, true);
  }
  if ($('modeIndicator')) $('modeIndicator').innerHTML = '<span class="mode-pill">Whole-verse timeline (piano-trope)</span>';
  const card = document.querySelector('.verse.active');
  const words = card ? card.querySelectorAll('.w') : [];
  const tonic = coach ? coach.tonicHz : 200;
  $('btnStop').disabled = false;
  $('result').innerHTML = '<span class="hint">Playing the recorded chant of the whole verse…</span>';
  playSegment(info.file, info.start, info.end, {
    onProgress: (t01) => {
      state.view.setPlayhead(t01);
      const wi = wordAtTime(coach, t01);
      highlightWord(wi);
      words.forEach((w, i) => w.classList.toggle('cur', i === wi));
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
  return `<span class="w" data-wi="${wi}" data-taam="${taam}" data-fam="${seg.familyId}"${title}`
    + ` style="color:${seg.color}${bg}">${escapeHtml(renderWord(token, ctx))}</span>`;
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
    span.style.color = ow.seg.color;
    // Center the whole word over the midpoint of its notes (RTL axis).
    const centerT = (ow.t0 + ow.t1) / 2;
    span.style.left = ((1 - centerT) * 100) + '%';
    span.textContent = renderWord(ow.seg.token, aids);
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
  window.__cantillateBusy = true; // hold off any service-worker auto-reload
  // Transpose-invariant: track (target - rawPitch) each frame and shift the
  // whole line by the best-fit (median) offset, so singing the right shape in a
  // different key still scores well. Only the relative shape is judged.
  state._diffs = [];
  state.view.clearUser();
  if (state.userSpectro) state.userSpectro.clearPlot();
  startLiveMeter('liveMeter', 'liveMeterFill', 'liveMeterVal');
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
    highlightWord(wordAtTime(state.coach, t01));
    scrollFollow(t01);
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
      // Guitar-hero "magnet": snap to target when close, pull + clamp when off.
      const err = aligned - tgt, ae = Math.abs(err), sgn = Math.sign(err);
      let styled, hit;
      if (ae <= DEADZONE) { styled = tgt + err * 0.2; hit = 'perfect'; }
      else {
        const off2 = Math.min(MAXDEV, DEADZONE + (ae - DEADZONE) * PULL);
        styled = tgt + sgn * off2;
        hit = ae <= 2.0 ? 'close' : 'far';
      }
      state.view.pushUser(t01, styled, rms, hit, rawT);
      if (rms >= 0.01) feedLiveMeter(err);
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
      playSegment(info.file, state.coach.start, state.coach.end, {
        onProgress: anchor,
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
    document.querySelectorAll('.verse.active .w, #timelineWords .w').forEach((w) => w.classList.remove('cur'));
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
  stopLiveMeter();
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
    const tPts = coach ? coach.steps.filter((s) => s.w === wi).flatMap((s) => [{ t: s.t0, p: s.p }, { t: s.t1, p: s.p }]) : [];
    const sc = tPts.length ? grade(scoreTrail(uS, tPts)) : 0;
    wordScores.push(sc);
    const gi = state.unitSegs[wi] ? state.unitSegs[wi].index : wi;
    profileByGi[gi] = sc;
    store.recordWordScore(state.slug, state.selectedVerse, gi, sc);
  }

  // --- Continuous take score (per section, never summed) -------------------
  // Score the take as one continuous pass (so transitions/timing count) and file
  // it under the right layer: a phrase take updates that phrase's best; a whole-
  // verse take updates BOTH each phrase it contains and the verse's score for the
  // current skill (aids config). Word bests were already updated above.
  const rawAcc = coach && coach.points && coach.points.length ? grade(scoreTrail(trail, coach.points))
    : (wordScores.length ? Math.round(wordScores.reduce((a, b) => a + b, 0) / wordScores.length) : 0);
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
    const md = VERSE_MODES.find((m) => m.key === skill);
    label = `${md ? md.label : 'Full verse'} accuracy`;
  } else {
    label = 'Word accuracy';
  }

  const stars = headline >= 95 ? '★★★' : headline >= 85 ? '★★' : headline >= level.threshold ? '★' : '';
  const prize = headline >= 95 ? ' ✨ Masterful!' : headline >= 85 ? ' 🎉 Great!' : '';
  let msg = `<span class="scorelabel">${label}</span> `
    + `<span class="num" style="color:${headline >= level.threshold ? 'var(--good)' : 'var(--accent-2)'}">${headline}</span>`
    + `<span class="ceil"> / 100</span> <span class="stars">${stars}</span>${prize} `;
  // Point out the trickiest word in this take.
  if (wordScores.length > 1) {
    let minI = 0; for (let i = 1; i < wordScores.length; i++) if (wordScores[i] < wordScores[minI]) minI = i;
    const seg = state.unitSegs[minI];
    if (seg && wordScores[minI] < 85) {
      msg += `<br><span class="hint">Trickiest: <b style="color:${seg.color}">${renderWord(seg.token, aidsForLevel())}</b> (${wordScores[minI]}) — see the score bars below.</span>`;
    }
  }
  if (headline >= level.threshold) {
    const next = Math.min(LEVELS.length, level.id + 1);
    store.recordVerseLevel(state.slug, state.selectedVerse, next);
    if (next > level.id) msg += `<br><span class="hint" style="color:var(--good)">Stage ${next} unlocked!</span>`;
  } else {
    msg += `<br><span class="hint">Reach ${level.threshold}+ to unlock the next stage.</span>`;
  }
  if (assisted) {
    msg += `<br><span class="hint">🎧 Assisted take (sang with the guide): scaled to ${Math.round(scores.ASSIST_MULT * 100)}% and capped at ${scores.ASSIST_CAP}. Record solo to break the cap, reach 100, and top the leaderboard.</span>`;
  }
  $('result').innerHTML = msg;
  renderAccuracyPanel();
  renderVerses();
  renderAliyot();
  applyHighlight();
  renderStageBar();
  maybePushScopes();
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
      <p class="next">To unlock it, complete <b>Stage ${unlocked}: ${frontier.label}</b> on this verse — score <b>${frontier.threshold}+</b>.</p>
      <button class="primary" id="btnGoFrontier">▶ Go to Stage ${unlocked}: ${frontier.label}</button>
    </div>`;
  $('btnGoFrontier').addEventListener('click', () => {
    state.level = unlocked;
    state.unitIndex = 0;
    renderStageBar();
    renderPractice();
  });
}

function renderLegend(segs) {
  const box = $('tropes');
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
  if (state._lm && state._lm.c) state._lm.c.hidden = true;
  state._lm = null;
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
  const box = $('verses');
  if (!box) return;
  const hide = () => { clearTimeout(timer); pop.hidden = true; pop._forEl = null; };
  box.addEventListener('mouseover', (e) => {
    const w = e.target.closest('.w');
    if (!w) return;
    clearTimeout(timer);
    timer = setTimeout(() => showWordPop(w), 450); // hover-hold delay
  });
  box.addEventListener('mouseout', (e) => {
    const w = e.target.closest('.w');
    if (!w) return;
    if (e.relatedTarget && (w.contains(e.relatedTarget) || pop.contains(e.relatedTarget))) return;
    hide();
  });
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
