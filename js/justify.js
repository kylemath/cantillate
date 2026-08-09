// Scribal column justification: keep inter-word gaps tight and uniform, and
// absorb leftover width by elongating the sofer's stretchable letters
// (אותיות רחבות) rather than by space-between. Matches how a real scroll (and a
// good tikkun's STA"M page) fills a line; the printed pointed page of a tikkun
// korim usually just spaces words, but we apply the same treatment to both
// surfaces so they stay line-for-line twins.

import { splitClusters } from './hebrew.js';

// Letters whose roof stroke a sofer may lengthen to justify a line.
export const STRETCHABLE = new Set(['\u05D4', '\u05D7', '\u05DC', '\u05E8', '\u05EA', '\u05D3', '\u05DD']);

// Soft cap on how far one letter may grow, relative to its natural advance.
// Beyond ~2× the glyph starts to look like a kashida rather than a wide letter.
const MAX_STRETCH = 2.25;
// Ignore residual slack smaller than this (sub-pixel rounding).
const SLACK_EPS = 0.4;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Wrap each stretchable base letter (plus any marks that ride with it) in a
// <span class="stretch"> so the justifier can widen it after layout.
export function wrapStretchHtml(text) {
  return splitClusters(String(text || '')).map((cluster) => {
    const base = cluster.codePointAt(0);
    const body = escapeHtml(cluster);
    if (base != null && STRETCHABLE.has(String.fromCodePoint(base))) {
      return `<span class="stretch">${body}</span>`;
    }
    return body;
  }).join('');
}

function clearStretch(el) {
  el.style.removeProperty('display');
  el.style.removeProperty('width');
  el.style.removeProperty('transform');
  el.style.removeProperty('transform-origin');
  el.style.removeProperty('vertical-align');
}

function clearFragment(frag) {
  frag.style.removeProperty('gap');
  frag.style.removeProperty('letter-spacing');
  frag.querySelectorAll('.stretch').forEach(clearStretch);
}

// Measure a fragment's content width with stretches reset and the CSS gap in
// force, then push any leftover (or shortfall) onto the stretch spans.
function justifyFragment(frag) {
  clearFragment(frag);
  const line = frag.closest('.scroll-line');
  if (!line || line.classList.contains('petucha')) return;
  if (frag.classList.contains('setuma')) return;

  const words = frag.querySelectorAll(':scope > .scroll-word');
  if (words.length < 2) return;

  const avail = frag.clientWidth;
  if (avail < 8) return;

  let content = 0;
  words.forEach((w) => { content += w.getBoundingClientRect().width; });
  const styles = getComputedStyle(frag);
  const gapPx = parseFloat(styles.columnGap || styles.gap) || 0;
  const natural = content + gapPx * (words.length - 1);
  let slack = avail - natural;

  const stretches = [...frag.querySelectorAll('.stretch')];

  if (slack < -SLACK_EPS) {
    // Line still overflows at the scribal gap: pull the gap in first, then a
    // hair of negative tracking if needed. Prefer this over squashing letters —
    // the overflow is almost always from a dense line plus a too-generous gap.
    const minGap = Math.max(0, gapPx + slack / Math.max(1, words.length - 1));
    frag.style.gap = `${minGap}px`;
    content = 0;
    words.forEach((w) => { content += w.getBoundingClientRect().width; });
    slack = avail - (content + minGap * (words.length - 1));
    if (slack < -SLACK_EPS) {
      const letters = Math.max(1, (frag.textContent || '').replace(/\s/g, '').length);
      frag.style.letterSpacing = `${slack / letters}px`;
    }
    return;
  }

  if (slack <= SLACK_EPS || !stretches.length) {
    // No stretchable letters (or nothing to do): open the gaps evenly so the
    // line still meets the left margin rather than sitting ragged.
    if (slack > SLACK_EPS && words.length > 1) {
      frag.style.gap = `${gapPx + slack / (words.length - 1)}px`;
    }
    return;
  }

  // Prefer letters toward the left of the line (the "open" side in RTL): a
  // sofer fills from the right margin and lengthens as needed near the left.
  // DOM order is RTL-visual already for our flex row, so later stretches in
  // document order sit further left — weight them a little more.
  const n = stretches.length;
  const weights = stretches.map((_, i) => 1 + (i / Math.max(1, n - 1)) * 0.6);
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let remaining = slack;
  stretches.forEach((el, i) => {
    if (remaining <= SLACK_EPS) return;
    const base = el.getBoundingClientRect().width;
    if (base < 0.5) return;
    const share = (weights[i] / weightSum) * slack;
    const extra = Math.min(share, base * (MAX_STRETCH - 1), remaining);
    if (extra <= SLACK_EPS) return;
    const target = base + extra;
    el.style.display = 'inline-block';
    el.style.verticalAlign = 'baseline';
    el.style.width = `${target}px`;
    el.style.transform = `scaleX(${target / base})`;
    // RTL: the letter starts on the right of its box; grow the roof leftward.
    el.style.transformOrigin = 'right center';
    remaining -= extra;
  });

  // Whatever the letters couldn't absorb (hit the stretch cap) goes into the
  // gaps — a sofer widens spaces only after the wide letters have done their
  // share, and only a little.
  if (remaining > SLACK_EPS && words.length > 1) {
    frag.style.gap = `${gapPx + remaining / (words.length - 1)}px`;
  }
}

// Justify every fixed tikkun page under `root`. Safe to call repeatedly (e.g.
// on resize); each pass clears prior stretch before remeasuring.
export function justifyTikkun(root) {
  if (!root) return;
  root.querySelectorAll('.tikkun-column .scroll-line-fragment').forEach(justifyFragment);
}
