// First run, for a reader who has been sent a link and told "learn your maftir".
//
// Expert mode opens on a reading menu of 33 entries, a portion selector, nine
// numbered stages and four panes. That is the right surface for someone who
// already knows what a triennial cycle is. It is the wrong one for a twelve-year-
// old and their parent, who between them know exactly one fact — the date — and
// need to be walked from that to "here is the first thing to sing".
//
// So: one question per screen, each with an obvious default, no jargon that isn't
// immediately explained, and a visible way back. The date is the load-bearing
// answer — it fixes the parashah, the triennial year and the haftarah (see
// js/calendar.js) — so it gets the most care, and the parashah it resolves to is
// shown as a card to confirm rather than silently assumed.

import * as calendar from './calendar.js';
import * as plan from './plan.js';

// The screens, in order, each paired with what it draws. One table rather than a
// list plus a switch, so adding a question can't leave a step that renders the
// wrong screen — the step order IS the keys of this object.
const BODIES = {
  install: installBody,
  who: whoBody,
  whose: whoseBody,
  name: nameBody,
  date: dateBody,
  parashah: parashahBody,
  cycle: cycleBody,
  parts: partsBody,
  ready: readyBody,
};
const STEPS = Object.keys(BODIES);

let root = null;
let onDone = null;
let installPrompt = null;   // a captured beforeinstallprompt, where the browser offers one
let draft = null;
let step = 0;

// Chrome and Edge fire this when the app is installable; capturing it lets the
// first screen offer a real install button instead of describing the menu item.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    const btn = document.getElementById('obInstall');
    if (btn) btn.hidden = false;
  });
}

// Already running from the home screen: there is nothing to teach on the first
// screen, so it is skipped rather than shown with its advice already taken.
export function isInstalled() {
  try {
    if (window.navigator.standalone) return true;
    return window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || window.matchMedia('(display-mode: minimal-ui)').matches;
  } catch (e) { return false; }
}

function isIOS() {
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports itself as a Mac, so the touch test is what catches it.
  return /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function newDraft() {
  return {
    role: 'self',
    occasion: 'barmitzvah',
    learner: '',
    enteredDate: '',
    rec: null,          // the resolved Shabbat (a normalized calendar record)
    cycle: 'annual',
    parts: null,
    browseFrom: null,   // set when the reader asked to pick the parashah by name
    custom: null,       // substituted passages carried through an edit (plan.setCustom)
  };
}

// --- Entry points -----------------------------------------------------------

export function isOpen() { return !!root; }

// Run the wizard. Resolves through `done(plan)` when the reader finishes, or
// `done(null)` if they back all the way out.
export function open({ done, editing = null } = {}) {
  onDone = done || (() => {});
  draft = newDraft();
  if (editing) {
    draft.role = editing.role || draft.role;
    draft.occasion = editing.occasion || draft.occasion;
    draft.learner = editing.learner || '';
    draft.enteredDate = editing.enteredDate || editing.date || '';
    draft.cycle = editing.cycle || draft.cycle;
    draft.parts = (editing.parts || []).slice();
    // A passage the reader deliberately substituted for the appointed one (see
    // plan.setCustom) is their choice, not the calendar's, so changing the date or
    // the cycle here must not quietly throw it away.
    draft.custom = editing.custom || null;
  }
  // Someone changing an existing plan doesn't need to be taught how to install
  // the app, and neither does someone who already has.
  step = (editing || isInstalled()) ? 1 : 0;
  mount();
  calendar.load().then(() => { if (root) render(); });
  render();
}

export function close() {
  if (!root) return;
  root.remove();
  root = null;
  document.body.classList.remove('onboarding');
}

function mount() {
  close();
  root = document.createElement('div');
  root.className = 'onboard';
  root.id = 'onboard';
  document.body.appendChild(root);
  document.body.classList.add('onboarding');
}

// --- Step machine -----------------------------------------------------------

// Steps that don't apply to this reader are skipped in both directions, so Back
// never lands on a screen that was never shown.
function applies(name) {
  if (name === 'install') return !isInstalled();
  // Nobody else's simcha to ask about, and no date to hang it on, when someone is
  // just learning to chant: they go straight to choosing a parashah by name.
  if (name === 'whose' || name === 'date') return draft.occasion !== 'learning';
  if (name === 'name') return draft.occasion !== 'learning' && draft.role !== 'self';
  if (name === 'parashah') return !draft.rec || !!draft.browseFrom;
  return true;
}

function go(delta) {
  let i = step;
  do { i += delta; } while (i > 0 && i < STEPS.length - 1 && !applies(STEPS[i]));
  if (i < 0) { close(); onDone(null); return; }
  step = Math.min(STEPS.length - 1, Math.max(0, i));
  render();
}

function next() { go(1); }
function back() { go(-1); }

function finish() {
  const built = plan.fromShabbat(draft.rec, {
    role: draft.role,
    occasion: draft.occasion,
    learner: draft.learner,
    cycle: draft.cycle,
    parts: draft.parts,
    enteredDate: draft.enteredDate,
  });
  if (!built) return;
  if (draft.custom) built.custom = draft.custom;
  plan.save(built);
  close();
  onDone(built);
}

// --- Rendering --------------------------------------------------------------

function render() {
  if (!root) return;
  const name = STEPS[step];
  const shown = STEPS.filter(applies);
  const at = shown.indexOf(name);
  const dots = shown.map((s, i) =>
    `<span class="ob-dot${i === at ? ' on' : ''}${i < at ? ' done' : ''}"></span>`).join('');
  root.innerHTML = `
    <div class="ob-card" role="dialog" aria-modal="true" aria-label="Set up what you are learning">
      <div class="ob-top">
        ${step > 0 ? '<button class="ob-back" id="obBack" aria-label="Back">\u2039</button>' : '<span class="ob-back-sp"></span>'}
        <div class="ob-dots" aria-hidden="true">${dots}</div>
      </div>
      <div class="ob-body" id="obBody">${bodyFor(name)}</div>
    </div>`;
  const b = document.getElementById('obBack');
  if (b) b.addEventListener('click', back);
  wireFor(name);
  const focusable = root.querySelector('.ob-body input, .ob-body button.ob-choice, .ob-body .ob-go');
  if (focusable && name !== 'install') focusable.focus({ preventScroll: true });
}

function bodyFor(name) {
  const body = BODIES[name];
  return body ? body() : '';
}

// 1. Keep it on the home screen. A reader who practises daily for eight months
// should not be hunting for a link each time, and a standalone window loses the
// browser chrome that eats a phone's short side.
function installBody() {
  const ios = isIOS();
  const how = ios
    ? `<li>Tap <b>Share</b> <span class="ob-ico">\u2191</span> at the bottom of Safari</li>
       <li>Choose <b>Add to Home Screen</b></li>
       <li>Tap <b>Add</b></li>`
    : `<li>Open your browser\u2019s <b>\u22ee</b> menu</li>
       <li>Choose <b>Install app</b> (or <b>Add to Home screen</b>)</li>`;
  return `
    <h2 class="ob-h">Keep this on your home screen</h2>
    <p class="ob-sub">You\u2019ll come back most days. Installed, it opens like an app, fills the screen and works without signal.</p>
    <ol class="ob-steps">${how}</ol>
    <button class="ob-go" id="obInstall" ${installPrompt ? '' : 'hidden'}>\u2b07 Install now</button>
    <button class="ob-go ob-ghost" id="obSkipInstall">I\u2019ll do it later \u2014 let\u2019s start</button>`;
}

// 2. What the occasion is. Tapping an answer IS moving on — a question with four
// tappable answers and a Next button underneath makes the reader do the work
// twice, and this wizard has enough screens without doubling the taps.
function whoBody() {
  const occ = (id) => `<button class="ob-choice${draft.occasion === id ? ' on' : ''}" data-occ="${id}">
      <span class="ob-choice-main">${plan.OCCASIONS[id].label}</span>
      <span class="ob-choice-sub">${plan.OCCASIONS[id].sub}</span></button>`;
  return `
    <h2 class="ob-h">What are you learning for?</h2>
    <div class="ob-choices">${occ('barmitzvah')}${occ('batmitzvah')}${occ('aliyah')}${occ('learning')}</div>`;
}

// 3. Whose it is. Decides whether the app says "your haftarah" or "Noa's", and
// whether it asks for a name at all.
function whoseBody() {
  const label = plan.OCCASIONS[draft.occasion] ? plan.OCCASIONS[draft.occasion].label.toLowerCase() : 'reading';
  const role = (id) => `<button class="ob-choice${draft.role === id ? ' on' : ''}" data-role="${id}">
      <span class="ob-choice-main">${plan.ROLES[id].label}</span>
      <span class="ob-choice-sub">${plan.ROLES[id].sub}</span></button>`;
  return `
    <h2 class="ob-h">Whose ${escapeHtml(label)} is it?</h2>
    <div class="ob-choices">${role('self')}${role('family')}${role('student')}</div>`;
}

// 4. A name, only when it isn't the reader's own. It changes every sentence in
// the app from "your maftir" to "J's maftir", which is the whole point of asking.
function nameBody() {
  const who = draft.role === 'student' ? 'your student' : 'them';
  return `
    <h2 class="ob-h">What shall we call ${who}?</h2>
    <p class="ob-sub">Just a first name, so the app can talk about the right person. It stays on this device unless you sign in.</p>
    <input class="ob-input" id="obName" type="text" maxlength="40" autocomplete="given-name"
      placeholder="First name" value="${escapeAttr(draft.learner)}" />
    <button class="ob-go" id="obNext">Next</button>
    <button class="ob-go ob-ghost" id="obSkipName">Skip</button>`;
}

// 4. The date. This is the one fact the reader definitely has, and it fixes
// everything else — so it is asked for on its own, and the parashah it resolves
// to appears live underneath as they type it.
function dateBody() {
  const cov = calendar.coverage();
  const loading = !calendar.isLoaded();
  // Coming BACK to this screen (from the browse-by-name list, or with Back) has to
  // find it as it was left: the date is still in the field, so the parashah it
  // resolves to must be on screen and Next must work. Resolving here rather than
  // only in the input handler is what makes the screen self-sufficient.
  if (!loading && !draft.rec && draft.enteredDate) {
    draft.rec = calendar.forDate(draft.enteredDate);
  }
  // Being on this screen with a date in hand means the reader is answering by date
  // after all, so the browse-by-name detour is dropped from the flow rather than
  // reappearing the next time they press Next.
  if (draft.rec) draft.browseFrom = null;
  return `
    <h2 class="ob-h">When is it?</h2>
    <p class="ob-sub">The date tells us which parashah you\u2019ll be reading. Not sure of the exact day? Any date that week is close enough.</p>
    <input class="ob-input ob-date" id="obDate" type="date"
      ${cov ? `min="${cov.from}" max="${cov.to}"` : ''}
      value="${escapeAttr(draft.enteredDate)}" />
    <div class="ob-resolved" id="obResolved">${loading
    ? '<p class="ob-sub">Loading the calendar\u2026</p>' : resolvedCard()}</div>
    <button class="ob-go" id="obNext" ${draft.rec ? '' : 'disabled'}>Next</button>
    <button class="ob-go ob-ghost" id="obNoDate">I don\u2019t know the date \u2014 let me pick the parashah</button>`;
}

// The confirmation card: the parashah in both languages, the Hebrew date, and the
// passages that go with it. Shown as something to APPROVE, because a wrong date
// silently learned for six months is the worst outcome this wizard can produce.
function resolvedCard() {
  const rec = draft.rec;
  if (!draft.enteredDate) return '';
  if (!calendar.covers(draft.enteredDate)) {
    const cov = calendar.coverage();
    return `<p class="ob-warn">That date is outside the calendar bundled with the app${cov
      ? ` (${plan.formatDate(cov.from)} \u2013 ${plan.formatDate(cov.to)})` : ''}. Pick the parashah by name instead.</p>`;
  }
  if (!rec) return '';
  // Only claim "the Shabbat of that week" when it really is: a reader who typed a
  // date and then chose a different parashah by name should not be told their
  // simcha week is the one they browsed to.
  const gap = (new Date(`${rec.date}T12:00:00`) - new Date(`${draft.enteredDate}T12:00:00`)) / 86400000;
  const shifted = rec.date !== draft.enteredDate && gap > 0 && gap < 7;
  return `
    <div class="ob-parashah">
      <p class="ob-pname">${escapeHtml(rec.parashah)}</p>
      <p class="ob-phe" lang="he" dir="rtl">${escapeHtml(rec.hebrew)}</p>
      <p class="ob-pmeta">${escapeHtml(plan.formatDate(rec.date))}${rec.hebrewDate ? ` \u00b7 ${escapeHtml(rec.hebrewDate)}` : ''}</p>
      ${shifted ? `<p class="ob-note">Read on the Shabbat of that week.</p>` : ''}
      ${rec.date !== draft.enteredDate && !shifted
    ? `<p class="ob-warn">This is a different week from ${escapeHtml(plan.formatDate(draft.enteredDate))} \u2014 you chose this parashah by name. If that isn\u2019t right, go back and pick again.</p>` : ''}
      ${rec.combined ? `<p class="ob-note">Two parshiyot are read together that week.</p>` : ''}
      <dl class="ob-refs">
        ${rec.torahRef ? `<div><dt>Torah</dt><dd>${escapeHtml(rec.torahRef)}</dd></div>` : ''}
        ${rec.maftirRef ? `<div><dt>Maftir</dt><dd>${escapeHtml(rec.maftirRef)}</dd></div>` : ''}
        ${rec.haftarahRef ? `<div><dt>Haftarah</dt><dd>${escapeHtml(rec.haftarahRef)}</dd></div>` : ''}
      </dl>
      ${rec.special ? `<p class="ob-note">${escapeHtml(rec.special)} \u2014 the maftir and haftarah that week are the special ones, not the parashah\u2019s own. Worth checking with whoever is teaching you.</p>` : ''}
    </div>`;
}

// 4b. No date, or the wrong parashah: browse the schedule by name. Each entry
// shows the next Shabbat it comes round on, which is usually enough to recognise.
function parashahBody() {
  const from = draft.browseFrom || calendar.today();
  const list = calendar.parashiyot(from);
  const rows = list.map((r) => `
    <button class="ob-prow${draft.rec && draft.rec.date === r.date ? ' on' : ''}" data-date="${r.date}">
      <span class="ob-prow-name">${escapeHtml(r.parashah)}</span>
      <span class="ob-prow-he" lang="he" dir="rtl">${escapeHtml(r.hebrew)}</span>
      <span class="ob-prow-when">${escapeHtml(plan.formatDate(r.date))}</span>
    </button>`).join('');
  return `
    <h2 class="ob-h">Which parashah?</h2>
    <p class="ob-sub">${list.length ? 'Every parashah, with the next Shabbat it is read on.' : 'Loading the calendar\u2026'}</p>
    <input class="ob-input" id="obFilter" type="search" placeholder="Search by name" autocomplete="off" />
    <div class="ob-plist" id="obPlist">${rows}</div>
    <button class="ob-go" id="obNext" ${draft.rec ? '' : 'disabled'}>Next</button>`;
}

// 5. How much of the parashah. Asked as "the whole thing or a third of it", with
// the rite named as a hint rather than as the question — a reader who doesn't
// know which cycle their shul uses can still recognise their own denomination.
function cycleBody() {
  const rec = draft.rec || {};
  const opt = (id) => `<button class="ob-choice${draft.cycle === id ? ' on' : ''}" data-cycle="${id}">
      <span class="ob-choice-main">${plan.CYCLES[id].label}</span>
      <span class="ob-choice-sub">${plan.CYCLES[id].sub}</span>
    </button>`;
  return `
    <h2 class="ob-h">How much is being read?</h2>
    <p class="ob-sub">If you\u2019re not sure, ask whoever is teaching you \u2014 you can change it later without losing any practice.</p>
    <div class="ob-choices">${opt('annual')}${opt('triennial')}</div>
    ${rec.triYear ? `<p class="ob-note">That Shabbat falls in <b>year ${rec.triYear}</b> of the three-year cycle, so that is the third we\u2019ll use.</p>` : ''}
    <button class="ob-go" id="obNext">Next</button>`;
}

// 6. Which parts they will actually chant. Pre-selected from the occasion, so the
// common case (a bar mitzvah reading maftir and haftarah) is one tap.
function partsBody() {
  const chosen = draft.parts || plan.defaultParts(draft.occasion);
  const ids = new Set(chosen.map(plan.partId));
  const row = (part) => {
    const id = plan.partId(part);
    return `<button class="ob-part${ids.has(id) ? ' on' : ''}" data-part="${id}">
        <span class="ob-part-check" aria-hidden="true">${ids.has(id) ? '\u2713' : ''}</span>
        <span class="ob-part-main">
          <span class="ob-part-name">${plan.partLabel(part)}</span>
          <span class="ob-part-sub">${plan.partBlurb(part)}</span>
        </span>
      </button>`;
  };
  const aliyot = plan.ALIYAH_NUMBERS.map((n) => {
    const id = `aliyah-${n}`;
    return `<button class="ob-alnum${ids.has(id) ? ' on' : ''}" data-part="${id}">${n}</button>`;
  }).join('');
  return `
    <h2 class="ob-h">What will ${draft.role === 'self' ? 'you' : (draft.learner || 'they')} be chanting?</h2>
    <p class="ob-sub">Pick everything for now \u2014 you can add or drop a part later.</p>
    <div class="ob-parts">
      ${row(plan.maftirPart())}
      ${row(plan.haftarahPart())}
    </div>
    <p class="ob-label">Or one of the seven aliyot</p>
    <div class="ob-alnums">${aliyot}</div>
    <button class="ob-go" id="obNext" ${ids.size ? '' : 'disabled'}>Next</button>`;
}

// 7. The plan, in one screen, before anything is committed.
function readyBody() {
  const rec = draft.rec || {};
  const chosen = draft.parts || plan.defaultParts(draft.occasion);
  const who = draft.role === 'self' ? 'You' : (draft.learner || 'They');
  // A part with a substituted passage says so here, because "Haftarah" on its own
  // would hide the very thing the reader went out of their way to choose.
  const items = chosen.map((p) => {
    const swap = (draft.custom || {})[plan.partId(p)];
    return `<li>${plan.partLabel(p)}${swap
      ? ` <span class="ob-choice-sub">\u2726 ${escapeHtml(swap.ref)}</span>` : ''}</li>`;
  }).join('');
  return `
    <h2 class="ob-h">Ready</h2>
    <div class="ob-parashah ob-parashah-sm">
      <p class="ob-pname">${escapeHtml(rec.parashah || '')}</p>
      <p class="ob-phe" lang="he" dir="rtl">${escapeHtml(rec.hebrew || '')}</p>
      <p class="ob-pmeta">${escapeHtml(plan.formatDate(rec.date))}</p>
    </div>
    <p class="ob-ready">${who} will be chanting:</p>
    <ul class="ob-readylist">${items}</ul>
    <p class="ob-sub">${plan.CYCLES[draft.cycle].label} \u00b7 ${plan.CYCLES[draft.cycle].sub}</p>
    <button class="ob-go ob-primary" id="obFinish">Start learning</button>`;
}

// --- Wiring -----------------------------------------------------------------

function wireFor(name) {
  const byId = (id) => document.getElementById(id);
  const nextBtn = byId('obNext');
  if (nextBtn) nextBtn.addEventListener('click', next);

  if (name === 'install') {
    byId('obSkipInstall').addEventListener('click', next);
    const inst = byId('obInstall');
    if (inst) inst.addEventListener('click', async () => {
      if (!installPrompt) return;
      const p = installPrompt;
      installPrompt = null;
      try { await p.prompt(); } catch (e) { /* dismissed */ }
      next();
    });
  }

  if (name === 'who') {
    root.querySelectorAll('[data-occ]').forEach((b) => b.addEventListener('click', () => {
      draft.occasion = b.dataset.occ;
      draft.parts = null; // the default set follows the occasion until they choose
      next();
    }));
  }

  if (name === 'whose') {
    root.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
      draft.role = b.dataset.role;
      next();
    }));
  }

  if (name === 'name') {
    const input = byId('obName');
    input.addEventListener('input', () => { draft.learner = input.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') next(); });
    byId('obSkipName').addEventListener('click', () => { draft.learner = ''; next(); });
  }

  if (name === 'date') {
    const input = byId('obDate');
    const resolve = () => {
      draft.enteredDate = input.value;
      draft.rec = draft.enteredDate ? calendar.forDate(draft.enteredDate) : null;
      draft.browseFrom = null;
      byId('obResolved').innerHTML = resolvedCard();
      nextBtn.disabled = !draft.rec;
    };
    // Date pickers are inconsistent about which event a committed value fires:
    // Chrome's inline picker fires `input`, iOS Safari's wheel fires `change` when
    // it closes. Listening to both means the parashah card appears either way.
    input.addEventListener('input', resolve);
    input.addEventListener('change', resolve);
    byId('obNoDate').addEventListener('click', () => {
      draft.browseFrom = calendar.today();
      draft.rec = null;
      step = STEPS.indexOf('parashah');
      render();
    });
  }

  if (name === 'parashah') {
    const filter = byId('obFilter');
    const list = byId('obPlist');
    const bind = () => list.querySelectorAll('.ob-prow').forEach((b) =>
      b.addEventListener('click', () => {
        draft.rec = calendar.on(b.dataset.date);
        // A date they actually gave us is theirs to keep: picking the parashah by
        // name here overrides which reading it is, not when the simcha is.
        if (!draft.enteredDate && draft.rec) draft.enteredDate = draft.rec.date;
        draft.browseFrom = null;
        next();
      }));
    bind();
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      list.querySelectorAll('.ob-prow').forEach((b) => {
        b.hidden = !!q && !b.textContent.toLowerCase().includes(q);
      });
    });
  }

  if (name === 'cycle') {
    root.querySelectorAll('[data-cycle]').forEach((b) => b.addEventListener('click', () => {
      draft.cycle = b.dataset.cycle;
      render();
    }));
  }

  if (name === 'parts') {
    root.querySelectorAll('[data-part]').forEach((b) => b.addEventListener('click', () => {
      const chosen = draft.parts || plan.defaultParts(draft.occasion);
      const id = b.dataset.part;
      const kept = chosen.filter((p) => plan.partId(p) !== id);
      draft.parts = kept.length === chosen.length
        ? chosen.concat(plan.partFromId(id)).filter(Boolean)
        : kept;
      render();
    }));
  }

  if (name === 'ready') byId('obFinish').addEventListener('click', finish);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) { return escapeHtml(s); }
