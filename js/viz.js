// Canvas rendering for the practice timeline:
//  - coach note "steps" (per-syllable tones) derived from the recording,
//    drawn as horizontal bars on a shared time axis (no diagonal connectors),
//  - a faint raw pitch trace behind them,
//  - the live real-chant pitch (green) and the user's mic pitch (orange),
//  - a moving playhead.
// The x-axis is normalized time (0..1) across the current window (a single word
// or a whole verse), matching the time-aligned spectrogram below it.

// Right-to-left time axis (to match Hebrew): the semitone scale sits on the
// RIGHT, time t=0 is at the right edge and t=1 at the left.
const LM = 8;    // small left margin
const RM = 34;   // right margin for the semitone scale

export class ContourView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.steps = [];       // [{t0,t1,p,color,connector}]
    this.raw = [];         // [{t,p}] faint underlay
    this.wordBounds = [];  // [t01,...]
    this.noteStatus = {};  // {stepIndex: 'hit'|'miss'} — Note-hit "gem" shading
    this.userTrail = [];
    this.realTrail = [];
    this.playhead = null;
    this.yMin = -7; this.yMax = 7;
    this.dpr = window.devicePixelRatio || 1;
    this._resize();
    this._onResize = () => { this._resize(); this.draw(); };
    window.addEventListener('resize', this._onResize);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width; this.h = rect.height;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setCoach({ steps = [], raw = [], wordBounds = [] } = {}) {
    this.steps = steps;
    this.raw = raw;
    this.wordBounds = wordBounds;
    this.noteStatus = {};
    this.userTrail = [];
    this.realTrail = [];
    this.playhead = null;
    this._computeRange();
    this.draw();
  }

  _computeRange() {
    // Base the range on the clean note steps (outlier-free). Fall back to a
    // robust percentile of the raw trace if there are no steps.
    let lo = -3, hi = 3;
    if (this.steps.length) {
      lo = Math.min(...this.steps.map((s) => s.p));
      hi = Math.max(...this.steps.map((s) => s.p));
    } else if (this.raw.length) {
      const ps = this.raw.map((r) => r.p).sort((a, b) => a - b);
      const q = (f) => ps[Math.max(0, Math.min(ps.length - 1, Math.floor(f * (ps.length - 1))))];
      lo = q(0.05); hi = q(0.95);
    }
    lo = Math.floor(lo - 1.5); hi = Math.ceil(hi + 1.5);
    if (hi - lo < 6) { const mid = (hi + lo) / 2; lo = mid - 3; hi = mid + 3; }
    this.yMin = lo; this.yMax = hi;
  }

  // A pitch is an outlier (octave error / spurious) if it falls outside the
  // displayed dynamic range; such points are clipped out of the traces.
  _inRange(p) { return p >= this.yMin - 0.5 && p <= this.yMax + 0.5; }

  clearUser() { this.userTrail = []; this.noteStatus = {}; this.draw(); }
  // Guitar-Hero "gem lights up": mark a coach note-step (by its index) hit/missed
  // so its bar is shaded green/red once the playhead has passed it.
  setNoteStatus(idx, status) { this.noteStatus[idx] = status; this.draw(); }
  clearNoteStatus() { this.noteStatus = {}; this.draw(); }
  pushUser(t01, semitone, rms, hit, rawT) {
    // Keep the entire session (reset each new recording via clearUser).
    if (semitone != null) this.userTrail.push({ t: t01, p: semitone, rms: rms || 0, hit, rawT });
    this.draw();
  }
  clearReal() { this.realTrail = []; this.draw(); }
  pushReal(t01, semitone) {
    if (semitone != null) this.realTrail.push({ t: t01, p: semitone });
    this.draw();
  }
  setPlayhead(t01) { this.playhead = t01; this.draw(); }

  _x(t) { const plotW = this.w - LM - RM; return LM + (1 - t) * plotW; }
  _y(p) {
    const norm = (p - this.yMin) / (this.yMax - this.yMin);
    return this.h - 18 - norm * (this.h - 34);
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const xR = this.w - RM;
    // Pixels per semitone at the current canvas height. On the tall desktop
    // contour this is large, so we size the note "gems" and the user-pitch dots
    // RELATIVE to it: the bars read like piano keys and the trace never grows so
    // fat it swallows the gems (the original fixed-px sizes dwarfed them on a
    // short canvas). Slight tone variations stay legible because a semitone now
    // spans many pixels.
    const pxPerSemi = (this.h - 34) / Math.max(1e-3, this.yMax - this.yMin);

    // Semitone gridlines (labels on the right for the RTL axis).
    ctx.font = '10px system-ui, sans-serif';
    for (let s = this.yMin; s <= this.yMax; s++) {
      const y = this._y(s);
      ctx.strokeStyle = s === 0 ? 'rgba(140,140,160,0.5)' : 'rgba(120,120,140,0.12)';
      ctx.beginPath(); ctx.moveTo(LM, y); ctx.lineTo(xR + 2, y); ctx.stroke();
      if (s % 2 === 0) {
        ctx.fillStyle = 'rgba(150,150,170,0.8)';
        ctx.fillText(s > 0 ? '+' + s : '' + s, xR + 5, y + 3);
      }
    }

    // Word boundaries.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.setLineDash([2, 4]);
    for (const t of this.wordBounds) {
      const x = this._x(t);
      ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, this.h - 16); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Faint raw pitch trace (ground truth from the recording).
    if (this.raw.length) {
      ctx.strokeStyle = 'rgba(160,170,190,0.28)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < this.raw.length; i++) {
        const r = this.raw[i];
        if (!this._inRange(r.p)) { pen = false; continue; } // clip outliers
        const x = this._x(r.t), y = this._y(r.p);
        // break the line across word gaps
        if (i > 0 && (r.t - this.raw[i - 1].t) > 0.06) pen = false;
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Coach note steps: horizontal bars, no diagonal connectors. In Note-hit
    // mode a completed note's bar lights up green (hit) or red (missed). Bar
    // thickness scales with the vertical resolution (≈half a semitone band, so
    // the notes look like piano keys) but is clamped to stay readable on any
    // canvas height.
    const barW = Math.max(4, Math.min(pxPerSemi * 0.5, 16));
    const connW = Math.max(3, barW * 0.6);
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i];
      const xa = this._x(s.t0), xb = this._x(s.t1), y = this._y(s.p);
      let left = Math.min(xa, xb), right = Math.max(xa, xb);
      if (right - left < 3) right = left + 3;
      ctx.lineCap = 'round';
      const w = s.connector ? connW : barW;
      const status = this.noteStatus[i];
      // "Gem" halo behind the bar once the note is completed.
      if (status === 'hit' || status === 'miss') {
        ctx.strokeStyle = status === 'hit' ? 'rgba(70,240,140,0.55)' : 'rgba(255,90,80,0.5)';
        ctx.globalAlpha = 1; ctx.lineWidth = w + 10;
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      }
      ctx.strokeStyle = s.color || '#5aa0ff';
      ctx.globalAlpha = 0.25; ctx.lineWidth = w + 4;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    }

    // Live real-chant pitch (green), broken across gaps.
    if (this.realTrail.length) {
      ctx.strokeStyle = 'rgba(120,255,180,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < this.realTrail.length; i++) {
        const r = this.realTrail[i];
        if (!this._inRange(r.p)) { pen = false; continue; } // clip outliers
        const x = this._x(r.t), y = this._y(r.p);
        // Break the stroke across word gaps AND on any backward jump in time
        // (e.g. audio looping/seeking to the start), so no long line connects the
        // end of one pass to the beginning of the next.
        const dt = i > 0 ? r.t - this.realTrail[i - 1].t : 0;
        if (i > 0 && (dt > 0.05 || dt < 0)) pen = false;
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // User mic pitch dots, colored by how close to the target (guitar-hero).
    // A bang-on "perfect" note gets a bigger, glowing dot with a bright core so
    // it's unmistakable that you're nailing the pitch.
    for (const s of this.userTrail) {
      if (!this._inRange(s.p)) continue;
      const x = this._x(s.t), y = this._y(s.p);
      const alpha = Math.min(0.95, 0.35 + s.rms * 8);
      const perfect = s.hit === 'perfect';
      let r = (2.5 + Math.min(5, s.rms * 40)) * (perfect ? 1.7 : 1);
      // Never let a loud frame's dot spill past ~0.6 semitone, so the trace
      // can't swallow the note gems or blur out fine pitch differences.
      r = Math.max(1.5, Math.min(r, pxPerSemi * 0.6));
      const col = perfect ? `rgba(70,240,140,${alpha})`
        : s.hit === 'close' ? `rgba(255,205,85,${alpha})`
          : s.hit === 'far' ? `rgba(255,107,90,${alpha})`
            : `rgba(255,150,90,${alpha})`;
      if (perfect) { ctx.shadowColor = 'rgba(80,255,150,0.95)'; ctx.shadowBlur = 14; }
      ctx.beginPath();
      ctx.fillStyle = col;
      ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (perfect) {
        // bright inner core, no shadow, for extra pop
        ctx.shadowBlur = 0;
        ctx.fillStyle = `rgba(225,255,238,${Math.min(1, alpha + 0.25)})`;
        ctx.beginPath(); ctx.arc(x, y, r * 0.42, 0, Math.PI * 2); ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    // Playhead.
    if (this.playhead != null) {
      const x = this._x(this.playhead);
      ctx.strokeStyle = 'rgba(255,215,0,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, this.h - 14); ctx.stroke();
    }
  }
}

// Interpolate a contour (sorted by t) at time t.
export function sampleContour(points, t) {
  if (!points.length) return 0;
  if (t <= points[0].t) return points[0].p;
  const last = points[points.length - 1];
  if (t >= last.t) return last.p;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].t) {
      const a = points[i - 1], b = points[i];
      const f = (t - a.t) / (b.t - a.t || 1);
      return a.p + (b.p - a.p) * f;
    }
  }
  return last.p;
}

// Score how closely the user's trail matches the coach steps (0..100).
//
// The mapping is exponential in the mean semitone error: score = 100·e^(-e/tau).
// This spreads out the middle of the range (clear gradation between an OK and a
// good take) while making the very top asymptotic — reaching 95+ demands a
// nearly flawless take, so experts have a high ceiling to compete for. A small
// deadzone forgives sub-quartertone jitter, and a per-note clamp keeps one bad
// note from tanking the whole score. Returns fractional precision (round only
// at display time) so aggregates stay smooth.
//
// Reliability: the raw user trail arrives at a jittery ~60Hz rAF rate, so a plain
// per-frame mean depends on how many frames happened to land during each note —
// sustained notes get overweighted and run-to-run frame counts vary. To make the
// score reproducible we (1) resample the user pitch onto a FIXED uniform time
// grid so every equal slice of the timeline counts equally regardless of frame
// rate, (2) aggregate with a TRIMMED mean so a couple of dropout/octave-glitch
// cells can't dominate, and (3) apply a smooth COVERAGE factor so sparse/silent
// takes can't score high. Public signature and 0..100 exponential character are
// unchanged.
export function scoreTrail(userTrail, targetPoints, opts = {}) {
  if (!userTrail.length || !targetPoints.length) return 0;
  const dead = opts.deadzone ?? 0.35;
  const maxdev = opts.maxdev ?? 4;
  const tau = opts.tau ?? 2.5;
  const GRID = opts.grid ?? 200;          // fixed uniform samples over [0,1]
  const trim = opts.trim ?? 0.1;          // fraction of worst cells dropped
  const minCoverage = opts.minCoverage ?? 0.35;
  const sorted = [...targetPoints].sort((a, b) => a.t - b.t);

  // Voiced user frames only, sorted by time, using offset-corrected pitch.
  const voiced = [];
  for (const s of userTrail) {
    if (s.rms < 0.01) continue;
    const up = s.sp != null ? s.sp : s.p; // offset-corrected pitch when available
    if (up == null) continue;
    voiced.push({ t: s.t, p: up });
  }
  voiced.sort((a, b) => a.t - b.t);
  if (!voiced.length) return 0;

  const step = 1 / GRID;
  const window = 1.5 * step; // max distance from a grid time to a voiced frame
  const errors = [];         // per-cell errors over VOICED grid cells only
  let voicedCells = 0;
  let j = 0;                 // sweep pointer into `voiced` (grid times increase)

  for (let g = 0; g < GRID; g++) {
    const tg = (g + 0.5) * step; // sample at cell centers
    // Advance so voiced[j-1].t <= tg < voiced[j].t (bracketing frames).
    while (j < voiced.length && voiced[j].t < tg) j++;
    const before = j > 0 ? voiced[j - 1] : null;
    const after = j < voiced.length ? voiced[j] : null;

    // Interpolate the user's pitch at tg from the nearest voiced frame(s).
    let up = null;
    if (before && after) {
      // Linear interp only when the bracket is tight; else use the nearer frame.
      if (tg - before.t <= window && after.t - tg <= window) {
        const f = (tg - before.t) / (after.t - before.t || 1);
        up = before.p + (after.p - before.p) * f;
      } else if (tg - before.t <= after.t - tg) {
        if (tg - before.t <= window) up = before.p;
      } else if (after.t - tg <= window) {
        up = after.p;
      }
    } else if (before && tg - before.t <= window) {
      up = before.p;
    } else if (after && after.t - tg <= window) {
      up = after.p;
    }

    // No voiced frame near this cell -> a gap: counts toward coverage, not error.
    if (up == null) continue;
    voicedCells++;
    let e = Math.abs(up - sampleContour(sorted, tg));
    e = Math.min(maxdev, e);
    e = Math.max(0, e - dead);
    errors.push(e);
  }

  if (!errors.length) return 0;

  // Trimmed mean: drop the worst `trim` fraction so a few glitch cells (dropouts,
  // octave errors) don't tank an otherwise good take. Fall back to plain mean
  // when there are too few cells for trimming to be meaningful.
  let meanErr;
  if (errors.length >= 5) {
    const asc = errors.slice().sort((a, b) => a - b);
    const keep = Math.max(1, asc.length - Math.floor(trim * asc.length));
    let sum = 0;
    for (let i = 0; i < keep; i++) sum += asc[i];
    meanErr = sum / keep;
  } else {
    meanErr = errors.reduce((a, b) => a + b, 0) / errors.length;
  }

  // Coverage: fraction of the timeline the user actually sang over. Below the
  // threshold the take is too sparse to trust, so smoothly scale the score down
  // (monotonic, never a hard zero) rather than rewarding silence.
  const coverage = voicedCells / GRID;
  let covFactor = 1;
  if (coverage < minCoverage) {
    const r = coverage / minCoverage;      // 0..1
    covFactor = r * r * (3 - 2 * r);       // smoothstep: smooth & monotonic
  }

  const score = 100 * Math.exp(-meanErr / tau) * covFactor;
  return Math.max(0, Math.min(100, score));
}

// Flatten coach note-steps ({t0,t1,p}) into the polyline of {t,p} points the
// contour scorer consumes (two points per step: on at t0, off at t1). This is
// exactly how buildCoach derives `coach.points`, so scoring a subset of steps
// this way reproduces the melody scorer's existing behaviour.
export function stepsToPoints(steps) {
  const pts = [];
  for (const s of steps || []) { pts.push({ t: s.t0, p: s.p }); pts.push({ t: s.t1, p: s.p }); }
  return pts;
}

// --- Guitar-Hero-style NOTE scoring (alternative to the melody/contour scorer) -
//
// Each coach step is a "note gem": a target pitch `p` (semitones vs the tonic)
// held over a time window [t0,t1] on the normalized 0..1 timeline. A note is
// graded by the FRACTION of its duration your (offset-corrected) pitch sits
// within `band` semitones of the target; the note "hits" once that fraction
// clears `minFrac`. Unlike scoreTrail — which samples a uniform time grid, so
// long held notes dominate — every note is weighted EQUALLY here, so quick
// ornamental steps count as much as sustained ones. Timing is forgiven by the
// note's own duration plus a small interpolation `window`; being early/late just
// eats into the in-band fraction rather than being mischarged as a pitch error.
//
// Returns { score (0..100 = mean per-note in-band fraction), hits, total,
// longest (longest hit streak), notes: [{w, frac, hit}] } so callers can show
// the headline number, a "hits/total" badge and a combo streak.
export function scoreNotes(userTrail, steps, opts = {}) {
  const band = opts.band ?? 1.5;        // semitones counted as "on the note"
  const minFrac = opts.minFrac ?? 0.5;  // in-band fraction needed to "hit" a note
  const K = opts.samples ?? 8;          // sub-samples across each note window
  const window = opts.window ?? 0.04;   // max time gap (in t01) to a voiced frame
  const total = (steps || []).length;
  if (!userTrail || !userTrail.length || !total) return { score: 0, hits: 0, total, longest: 0, notes: [] };

  // Voiced, offset-corrected user frames, sorted by time (same filter as scoreTrail).
  const voiced = [];
  for (const s of userTrail) {
    if (s.rms < 0.01) continue;
    const up = s.sp != null ? s.sp : s.p;
    if (up == null) continue;
    voiced.push({ t: s.t, p: up });
  }
  voiced.sort((a, b) => a.t - b.t);
  if (!voiced.length) return { score: 0, hits: 0, total, longest: 0, notes: [] };

  // User pitch at time tg: linear interp inside `window`, nearer frame otherwise,
  // null when there's no voiced frame close enough (a gap -> counts as off-note).
  const pitchAt = (tg) => {
    let before = null, after = null;
    for (let i = 0; i < voiced.length; i++) {
      if (voiced[i].t <= tg) before = voiced[i];
      else { after = voiced[i]; break; }
    }
    if (before && after) {
      if (tg - before.t <= window && after.t - tg <= window) {
        const f = (tg - before.t) / (after.t - before.t || 1);
        return before.p + (after.p - before.p) * f;
      }
      if (tg - before.t <= after.t - tg) return (tg - before.t <= window) ? before.p : null;
      return (after.t - tg <= window) ? after.p : null;
    }
    if (before && tg - before.t <= window) return before.p;
    if (after && after.t - tg <= window) return after.p;
    return null;
  };

  const notes = [];
  let hits = 0, sumFrac = 0, streak = 0, longest = 0;
  const ordered = [...steps].sort((a, b) => a.t0 - b.t0);
  for (const st of ordered) {
    const dur = Math.max(1e-4, st.t1 - st.t0);
    let inBand = 0;
    for (let k = 0; k < K; k++) {
      const tg = st.t0 + ((k + 0.5) / K) * dur;
      const up = pitchAt(tg);
      if (up != null && Math.abs(up - st.p) <= band) inBand++;
    }
    const frac = inBand / K;
    const hit = frac >= minFrac;
    sumFrac += frac;
    if (hit) { hits++; streak++; if (streak > longest) longest = streak; }
    else streak = 0;
    notes.push({ w: st.w, frac, hit });
  }
  const score = Math.max(0, Math.min(100, 100 * (sumFrac / ordered.length)));
  return { score, hits, total: ordered.length, longest, notes };
}

// Time-aligned spectrogram: columns are placed by their position in the played
// window (0..1), so voice energy sits under the matching notes/words above.
export class Spectrogram {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fMin = 90;
    this.fMax = 3600;
    this.lm = 8;  // small left margin (match ContourView)
    this.rm = 34; // right margin for the Hz scale (RTL axis)
    this._resize();
    window.addEventListener('resize', () => { this._resize(); this.clearPlot(); });
    this.clearPlot();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(120, Math.round(rect.width));
    this.canvas.height = Math.max(80, Math.round(rect.height));
  }

  _freqToY(f) {
    const h = this.canvas.height;
    const lf = Math.log(f / this.fMin) / Math.log(this.fMax / this.fMin);
    return (h - 1) - lf * (h - 1);
  }
  _yToFreq(y) {
    const h = this.canvas.height;
    const frac = (h - 1 - y) / (h - 1);
    return this.fMin * Math.pow(this.fMax / this.fMin, frac);
  }

  clearPlot() {
    const { ctx, canvas } = this;
    ctx.fillStyle = '#05060d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.lastX = null;
    this._drawAxis();
  }

  _drawAxis() {
    const { ctx, canvas } = this;
    const xR = canvas.width - this.rm;
    ctx.fillStyle = '#0b0e1a';
    ctx.fillRect(xR, 0, this.rm, canvas.height);
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(180,185,210,0.85)';
    [100, 200, 400, 800, 1600, 3200].forEach((f) => {
      if (f < this.fMin || f > this.fMax) return;
      const y = this._freqToY(f);
      ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), xR + 3, y + 3);
    });
  }

  _color(v) {
    const t = v / 255;
    const r = Math.floor(255 * Math.min(1, Math.max(0, t * 1.9 - 0.25)));
    const g = Math.floor(255 * Math.min(1, Math.max(0, t * 1.7 - 0.75)));
    const b = Math.floor(255 * Math.min(1, Math.max(0, t < 0.5 ? t * 1.5 : (1 - t) * 1.4)));
    return `rgb(${r},${g},${b})`;
  }

  // Place a spectrum column at normalized time t01 within the window on the RTL
  // axis (t=0 at the right). Each column is filled up to the previous one (to its
  // right) so there are no black stripes.
  pushAt(t01, freq, sampleRate, fftSize, f0) {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    const plotW = w - this.lm - this.rm;
    const x = Math.round(this.lm + (1 - Math.min(1, Math.max(0, t01))) * plotW);
    // Time advances -> x decreases; fill from current x rightward to the last x.
    const width = this.lastX == null ? 3 : Math.max(1, this.lastX - x);
    const binHz = sampleRate / fftSize;
    const nb = freq.length;
    for (let y = 0; y < h; y++) {
      const f = this._yToFreq(y);
      const bin = Math.round(f / binHz);
      const v = bin >= 0 && bin < nb ? freq[bin] : 0;
      ctx.fillStyle = this._color(v);
      ctx.fillRect(x, y, width, 1);
    }
    if (f0 > 0) {
      for (let k = 1; k <= 6; k++) {
        const y = this._freqToY(f0 * k);
        if (y >= 0 && y < h) {
          ctx.fillStyle = k === 1 ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.4)';
          ctx.fillRect(x, y - 1, width, k === 1 ? 3 : 2);
        }
      }
    }
    this.lastX = x;
  }
}
