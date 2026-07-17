import { tokenize, renderWord, toScroll } from './hebrew.js';
import { buildLineMelody, splitPhrases, FAMILIES, markGlyph } from './trope.js';
import { singSteps, playTone, stopPlayback } from './audio.js';
import { playSegment, stopVerseAudio } from './realaudio.js';
import { startMic, stopMic } from './pitch.js';
import { ContourView, Spectrogram, scoreTrail, sampleContour } from './viz.js';
import { LEVELS, levelById, VERSE_MODES, skillForLevel } from './levels.js';
import * as store from './store.js';

const AVAILABLE = [
  { slug: 'devarim1', file: 'data/devarim1.json', label: 'Devarim (Deuteronomy) 1' },
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
  overlay: 'off',     // left-column score overlay: 'off'|'word'|'phrase'|'verse'
  scrollView: false,  // render the text pane as a continuous Torah column
  scrollZoom: false,  // guitar-hero: zoom to ~5 words and auto-scroll the line
  tonicHz: 220,
  division: 'full',
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

async function init() {
  // Populate parashah selector.
  const sel = $('parashah');
  AVAILABLE.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.slug; o.textContent = p.label; sel.appendChild(o);
  });
  await loadData(AVAILABLE[0].slug);

  sel.addEventListener('change', () => loadData(sel.value));
  $('division').addEventListener('change', (e) => { state.division = e.target.value; renderVerses(); });
  $('tonic').addEventListener('change', (e) => { state.tonicHz = parseFloat(e.target.value); });

  bindToggle('tgVowels', () => { state.showVowels = !state.showVowels; refreshText(); });
  bindToggle('tgTaamim', () => { state.showTaamim = !state.showTaamim; refreshText(); });
  bindToggle('tgFont', () => { state.scroll = !state.scroll; refreshText(); });
  $('overlaySeg').querySelectorAll('.ov').forEach((b) => {
    b.addEventListener('click', () => { state.overlay = b.dataset.ov; syncToggleUI(); renderVerses(); });
  });
  bindToggle('tgScrollView', () => { state.scrollView = !state.scrollView; renderVerses(); });

  renderFamilyBar();
  document.addEventListener('keydown', onKey);
  setupSplitter();
}

// Draggable divider between the verse list and the practice pane. The width is
// persisted and never changes automatically, so the horizontal scale stays
// consistent across words/verses/levels.
const LEFTW_KEY = 'cantillate.leftw';
function applyLeftW(px) {
  const mainEl = document.querySelector('main');
  const max = Math.max(160, window.innerWidth - 380);
  const w = Math.max(0, Math.min(max, px));
  mainEl.style.setProperty('--leftw', w + 'px');
  mainEl.classList.toggle('narrow-left', w > 0 && w < 210);
  try { localStorage.setItem(LEFTW_KEY, String(Math.round(w))); } catch (e) { /* ignore */ }
}
function setupSplitter() {
  const mainEl = document.querySelector('main');
  const splitter = $('splitter');
  const saved = parseInt(localStorage.getItem(LEFTW_KEY) || '', 10);
  applyLeftW(Number.isFinite(saved) ? saved : 360);
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - mainEl.getBoundingClientRect().left;
    applyLeftW(x);
  };
  const stop = () => { dragging = false; splitter.classList.remove('dragging'); document.body.style.userSelect = ''; };
  const start = (e) => { dragging = true; splitter.classList.add('dragging'); document.body.style.userSelect = 'none'; e.preventDefault(); };
  splitter.addEventListener('mousedown', start);
  splitter.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', stop);
  window.addEventListener('touchend', stop);
  splitter.addEventListener('dblclick', () => applyLeftW(360)); // reset
}

// Keyboard shortcuts (RTL): ← next page/word, → previous, Space/P play,
// ↓ record, Escape stop. Modifier combos (e.g. Ctrl/Cmd+R to refresh) and
// typing in a control are left to the browser.
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
  const seg = $('overlaySeg');
  if (seg) seg.querySelectorAll('.ov').forEach((b) => b.classList.toggle('on', b.dataset.ov === state.overlay));
  $('tgScrollView').classList.toggle('on', state.scrollView);
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
  try {
    const pr = await fetch(`data/${slug}_pitch.json`);
    if (pr.ok) state.pitch = await pr.json();
  } catch (e) { /* no extracted pitch available */ }
  state.shapes = null;
  try {
    const sr = await fetch(`data/${slug}_shapes.json`);
    if (sr.ok) state.shapes = (await sr.json()).shapes;
  } catch (e) { /* no averaged trope shapes available */ }
  $('textTitle').textContent = `${state.data.book.en} ${state.data.chapter} — ${state.data.book.he}`;
  $('srcVersion').textContent = state.data.heVersionTitle || state.data.versionTitle || 'Masoretic text';
  renderVerses();
  renderStageBar();
  $('practice').innerHTML = '<p class="empty">Select a verse on the left to begin practicing.</p>';
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
function buildCoach(unitSegs) {
  const pv = pitchVerse(state.selectedVerse);
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

function divisionRange() {
  const verses = state.data.verses;
  const n = verses.length;
  if (state.division === 'full') return [1, n];
  const third = Math.ceil(n / 3);
  const part = parseInt(state.division, 10);
  const start = (part - 1) * third + 1;
  const end = Math.min(n, part * third);
  return [start, end];
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
  if (state.scrollView) { renderScrollColumn(); return; }
  const box = $('verses');
  box.innerHTML = '';
  const [start, end] = divisionRange();
  for (let i = start; i <= end; i++) {
    const v = state.data.verses[i - 1];
    const div = document.createElement('div');
    div.className = 'verse' + (state.selectedVerse === i ? ' active' : '');
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
    div.innerHTML = `<span class="vnum">${state.data.book.he} ${toHebrewNum(i)} · v${i}</span>${badge}
      <div class="hebrew ${state.scroll ? 'scroll' : ''}">${heHtml}</div>`;
    // Clicking a single word jumps to word practice for that word; clicking
    // elsewhere in the verse just selects the verse.
    div.addEventListener('click', (e) => {
      const wEl = e.target.closest('.w');
      if (wEl && wEl.dataset.wi != null) practiceWord(i, parseInt(wEl.dataset.wi, 10));
      else selectVerse(i);
    });
    box.appendChild(div);
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
    const base = store.getVerseModeScores(state.slug, verseN).base || 0;
    return { score: () => (base > 0 ? base : undefined), lo: 0, hi: 100 };
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
// parchment — a faithful representation of the scroll's format.
function renderScrollColumn() {
  const box = $('verses');
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
  // Keep the chosen stage consistent across verses (navigation is independent of
  // per-verse unlock progress).
  state.unitIndex = 0;
  renderVerses();
  renderStageBar();
  renderPractice();
}

// Persistent top-of-window stage selector. Any stage is navigable; stages not
// yet unlocked for the current verse are marked, and opening one shows a locked
// page (see renderPractice).
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
  bar.innerHTML = `<span class="label">Stage:</span>${btns}`;
  bar.querySelectorAll('.stagebtn').forEach((b) => {
    b.addEventListener('click', () => {
      state.level = parseInt(b.dataset.lvl, 10);
      state.unitIndex = 0;
      renderStageBar();
      if (state.selectedVerse != null) renderPractice();
    });
  });
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
  if (!state.scrollZoom) return;
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
      <h2>${state.data.book.he} ${toHebrewNum(state.selectedVerse)} · verse ${state.selectedVerse} <span class="stagetag">Stage ${level.id}: ${level.label}</span></h2>
    </div>
    <div class="aidchips">${chips}</div>
    <p class="leveldesc">${level.desc}</p>

    ${units.length > 1 ? `<div class="unit-nav">
      <button id="uPrev">◀</button>
      <span class="u-label">${cap(level.unit)} ${state.unitIndex + 1} / ${units.length}</span>
      <button id="uNext">▶</button>
    </div>` : ''}

    <div class="mode-indicator" id="modeIndicator"></div>
    ${hasReal ? '<p class="hint tapword">Tap a word, or use keys: <b>←</b> next word · <b>→</b> previous · <b>Space</b> replay · <b>↓</b> record · <b>Esc</b> stop.</p>' : ''}

    <div class="timeline">
      <div class="cmp-legend">
        <span><span class="swatch coach"></span> coach notes (from recording)</span>
        <span><span class="swatch real"></span> live recording pitch</span>
        <span><span class="swatch you"></span> your voice</span>
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
      <button id="btnStop" disabled>■ Stop</button>
    </div>
    <div class="result" id="result"><span class="hint">${hasReal
      ? 'Hear the real cantor chant the whole verse, or use the voice guide for this ' + level.unit + ', then record your try.'
      : (level.mode === 'listen' ? 'Listen, then record yourself repeating it.' : 'Follow the moving cue and sing along as you record.')}</span></div>

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

  // Guitar-hero zoom: widen the timeline to ~5 words visible and scroll it.
  // Must set the virtual width BEFORE creating the canvas views.
  const zoomable = level.unit === 'line' && state.scrollZoom;
  const tlScroll = $('tlScroll');
  const tlInner = $('tlInner');
  if (zoomable) {
    const visW = tlScroll.clientWidth || 800;
    const factor = Math.max(1, unitSegs.length / ZOOM_WORDS);
    tlInner.style.width = Math.round(visW * factor) + 'px';
    tlScroll.classList.add('scrolling');
  } else {
    tlInner.style.width = '100%';
    tlScroll.classList.remove('scrolling');
  }

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
  $('modeIndicator').innerHTML = `<span class="mode-pill">${modeName}</span>`
    + (units.length > 1 ? ` <span class="hint">— ◀ ▶ moves to the next ${level.unit} and updates the graph</span>` : '')
    + zoomBtn;
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
  $('btnRec').addEventListener('click', startRecording);
  $('btnStop').addEventListener('click', stopAll);

  renderLegend(unitSegs);
  renderAccuracyPanel();
  wireAccPanel();
  applyHighlight();
  // Start the zoom view at the beginning of the line (rightmost, RTL).
  if (zoomable) tlScroll.scrollLeft = tlScroll.scrollWidth - tlScroll.clientWidth;
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

// The whole-verse bar (one "division") rendered as a left-to-right gradient of
// the good/bad sections captured during the best full-verse run, so you can see
// where the whole-pasuk performance held up and where it slipped.
function verseGradientRow(segs, layout, active) {
  const base = store.getVerseModeScores(state.slug, state.selectedVerse).base || 0;
  const prof = store.getVerseProfile(state.slug, state.selectedVerse, 'base');
  let inner = '';
  if (prof && prof.profile) {
    const vals = segs.map((s) => prof.profile[s.index]).filter((x) => x != null && x > 0);
    if (vals.length) {
      const [lo, hi] = adaptiveRange(vals);
      const stops = [];
      segs.forEach((s, i) => {
        const sc = prof.profile[s.index];
        if (sc == null || sc <= 0) return;
        stops.push({ c: (layout[i].t0 + layout[i].t1) / 2, col: rampColor(sc, lo, hi, true) });
      });
      stops.sort((a, b) => a.c - b.c);
      // RTL: 'to left' puts 0% on the right (verse start). Pad both ends solid.
      const parts = [`${stops[0].col} 0%`]
        .concat(stops.map((st) => `${st.col} ${(st.c * 100).toFixed(1)}%`))
        .concat([`${stops[stops.length - 1].col} 100%`]);
      inner = `<div class="secseg clickable" data-kind="verse" style="flex:1 1 0" title="Whole verse: ${base}/100 — click to practice">`
        + `<div class="secfill" style="height:100%;background:linear-gradient(to left, ${parts.join(', ')})"></div>`
        + `${base > 0 ? `<span class="seclbl">${base}</span>` : ''}</div>`;
    }
  }
  if (!inner) {
    inner = `<div class="secseg clickable" data-kind="verse" style="flex:1 1 0" title="Whole verse: ${base > 0 ? base + '/100' : 'not yet practiced'} — click to practice">`
      + (base > 0
        ? `<div class="secfill" style="height:${Math.max(8, base)}%;background:${rampColor(base, 0, 100, true)}"></div><span class="seclbl">${base}</span>`
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
  container.style.fontSize = nWords === 1 ? '40px' : nWords <= 4 ? '30px' : nWords <= 9 ? '25px' : '20px';
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

async function startRecording() {
  if (state.recording) return;
  const level = levelById(state.level);
  // In "listen" mode, play the target first as a lead-in cue.
  if (level.mode === 'listen') playTarget();

  stopVerseAudio();
  state.playingReal = false;
  state.recording = true;
  // Transpose-invariant: track (target - rawPitch) each frame and shift the
  // whole line by the best-fit (median) offset, so singing the right shape in a
  // different key still scores well. Only the relative shape is judged.
  state._diffs = [];
  state.view.clearUser();
  if (state.userSpectro) state.userSpectro.clearPlot();
  $('btnRec').disabled = true;
  $('btnStop').disabled = false;
  $('result').innerHTML = '<span class="hint">Recording… start on any comfortable pitch; your first note is matched to the coach, so just follow the shape.</span>';

  const dur = unitDuration();
  state.expectedDur = dur;
  const bounds = state.coach ? state.coach.wordBounds : [0];
  const leadIn = level.mode === 'listen' ? dur * 1000 + 250 : 250;
  state.recStart = performance.now() + leadIn;

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
    } else {
      state.view.pushUser(t01, null, rms);
    }
  }, () => {});

  // Safety auto-stop.
  state._recTimer = setTimeout(finishRecording, (leadIn + dur * 1000 + 600));
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
  state.recording = false;
  clearTimeout(state._recTimer);
  stopMic();
  stopPlayback();
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
  const bounds = (coach && coach.wordBounds) || [0];
  const wordScores = [];
  const profileByGi = {}; // this take's per-word scores (good/bad shape)
  for (let wi = 0; wi < bounds.length; wi++) {
    const t0 = bounds[wi];
    const t1 = wi + 1 < bounds.length ? bounds[wi + 1] : 1.0001;
    const uS = trail.filter((s) => s.t >= t0 && s.t < t1);
    const tPts = coach ? coach.steps.filter((s) => s.w === wi).flatMap((s) => [{ t: s.t0, p: s.p }, { t: s.t1, p: s.p }]) : [];
    const sc = tPts.length ? Math.round(scoreTrail(uS, tPts)) : 0;
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
  const rawAcc = coach && coach.points && coach.points.length ? Math.round(scoreTrail(trail, coach.points))
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
  $('result').innerHTML = msg;
  renderAccuracyPanel();
  renderVerses();
  applyHighlight();
  renderStageBar();
}

// Greyed page shown when navigating to a stage not yet unlocked for this verse.
function renderLockedPage(level, unlocked) {
  const frontier = levelById(unlocked);
  const p = $('practice');
  p.innerHTML = `
    <div class="phead">
      <h2>${state.data.book.he} ${toHebrewNum(state.selectedVerse)} · verse ${state.selectedVerse} <span class="stagetag">Stage ${level.id}: ${level.label}</span></h2>
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
