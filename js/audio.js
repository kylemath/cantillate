// Web Audio synthesis of a target cantillation melody from a contour.
import { semitoneToFreq } from './trope.js';

let ctx = null;
export function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

let current = null; // { osc, gain, stopAt }

export function stopPlayback() {
  if (current) {
    try {
      current.gain.gain.cancelScheduledValues(getCtx().currentTime);
      current.gain.gain.setTargetAtTime(0, getCtx().currentTime, 0.02);
      current.osc.stop(getCtx().currentTime + 0.1);
    } catch (e) { /* already stopped */ }
    current = null;
  }
}

// points: [{t,p}] normalized time 0..1, p in semitones relative to tonic.
// opts: { tonicHz, durationSec, onProgress(t01), onEnd() }
export function playMelody(points, opts = {}) {
  const { tonicHz = 220, durationSec = null, onProgress, onEnd } = opts;
  const c = getCtx();
  stopPlayback();

  const sorted = [...points].sort((a, b) => a.t - b.t);
  const dur = durationSec || Math.max(2.2, sorted.length * 0.32);

  const osc = c.createOscillator();
  osc.type = 'triangle';
  const gain = c.createGain();
  const t0 = c.currentTime + 0.05;

  // Slight vibrato via a second oscillator for a more "voice-like" tone.
  const vib = c.createOscillator();
  vib.frequency.value = 5.5;
  const vibGain = c.createGain();
  vibGain.gain.value = 3;
  vib.connect(vibGain).connect(osc.frequency);

  osc.connect(gain).connect(c.destination);

  // Frequency automation along the contour.
  const f0 = semitoneToFreq(tonicHz, sorted[0]?.p ?? 0);
  osc.frequency.setValueAtTime(f0, t0);
  sorted.forEach((pt) => {
    const when = t0 + pt.t * dur;
    const f = semitoneToFreq(tonicHz, pt.p);
    osc.frequency.linearRampToValueAtTime(f, when);
  });

  // Amplitude envelope.
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.22, t0 + 0.08);
  gain.gain.setValueAtTime(0.22, t0 + dur - 0.15);
  gain.gain.linearRampToValueAtTime(0, t0 + dur);

  osc.start(t0);
  vib.start(t0);
  osc.stop(t0 + dur + 0.05);
  vib.stop(t0 + dur + 0.05);
  current = { osc, gain };

  // Progress ticker for a moving playhead.
  let raf;
  const tick = () => {
    const elapsed = c.currentTime - t0;
    const t01 = Math.min(1, Math.max(0, elapsed / dur));
    if (onProgress) onProgress(t01);
    if (elapsed < dur) {
      raf = requestAnimationFrame(tick);
    } else {
      if (onProgress) onProgress(1);
      if (onEnd) onEnd();
      current = null;
    }
  };
  raf = requestAnimationFrame(tick);

  return { durationSec: dur, cancel: () => { cancelAnimationFrame(raf); stopPlayback(); } };
}

// Sing a line as an articulated, voice-like chant: pitch follows each word's
// contour, while a formant filter + per-syllable amplitude pulses give it the
// stops, gaps and "voice power" of real chanting instead of one pure tone.
// segs: [{ contour:[{t,p}], syllables:Number }]
export function singMelody(segs, opts = {}) {
  const { tonicHz = 220, onProgress, onEnd } = opts;
  const c = getCtx();
  stopPlayback();

  const nw = segs.length || 1;
  const totalSyl = segs.reduce((a, s) => a + (s.syllables || 1), 0);
  const dur = Math.max(1.4, totalSyl * 0.42);
  const t0 = c.currentTime + 0.06;
  const wordSlice = dur / nw;

  // Buzzy source + vibrato (voice-like glottal tone).
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  const vib = c.createOscillator();
  vib.frequency.value = 5.5;
  const vibGain = c.createGain();
  vibGain.gain.value = 3.2;
  vib.connect(vibGain).connect(osc.frequency);

  // Two formant band-passes (an "ah/eh" vowel color) + a little body.
  const master = c.createGain();
  master.gain.value = 0.0001;
  const f1 = c.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 700; f1.Q.value = 6;
  const f2 = c.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1150; f2.Q.value = 9;
  const g1 = c.createGain(); g1.gain.value = 1.0;
  const g2 = c.createGain(); g2.gain.value = 0.7;
  const low = c.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 2800;
  const gd = c.createGain(); gd.gain.value = 0.22;
  osc.connect(f1).connect(g1).connect(master);
  osc.connect(f2).connect(g2).connect(master);
  osc.connect(low).connect(gd).connect(master);
  master.connect(c.destination);

  // Pitch automation: follow each word's contour within its time slice.
  osc.frequency.setValueAtTime(semitoneToFreq(tonicHz, segs[0].contour[0].p), t0);
  segs.forEach((seg, i) => {
    const base = i * wordSlice;
    seg.contour.forEach((pt) => {
      const when = t0 + base + pt.t * wordSlice;
      osc.frequency.linearRampToValueAtTime(semitoneToFreq(tonicHz, pt.p), when);
    });
  });

  // Amplitude: one shaped pulse per syllable, with a dip between (articulation).
  master.gain.setValueAtTime(0.04, t0);
  segs.forEach((seg, i) => {
    const base = i * wordSlice;
    const s = seg.syllables || 1;
    const sylW = wordSlice / s;
    for (let k = 0; k < s; k++) {
      const on = t0 + base + k * sylW;
      master.gain.setValueAtTime(0.05, on);
      master.gain.linearRampToValueAtTime(0.30, on + sylW * 0.18);
      master.gain.linearRampToValueAtTime(0.17, on + sylW * 0.72);
      master.gain.linearRampToValueAtTime(0.04, on + sylW * 0.97);
    }
  });
  master.gain.linearRampToValueAtTime(0, t0 + dur + 0.05);

  osc.start(t0); vib.start(t0);
  osc.stop(t0 + dur + 0.12); vib.stop(t0 + dur + 0.12);
  current = { osc, gain: master };

  let raf;
  const tick = () => {
    const elapsed = c.currentTime - t0;
    const t01 = Math.min(1, Math.max(0, elapsed / dur));
    if (onProgress) onProgress(t01);
    if (elapsed < dur) raf = requestAnimationFrame(tick);
    else { if (onProgress) onProgress(1); if (onEnd) onEnd(); current = null; }
  };
  raf = requestAnimationFrame(tick);
  return { durationSec: dur, cancel: () => { cancelAnimationFrame(raf); stopPlayback(); } };
}

// Sing a sequence of discrete note steps (the coach line derived from the
// recording). Each step is a held, voice-like note for its own duration, with
// silent gaps between steps for articulation — matching the stepped display.
// steps: [{ t0, t1, p }] with t0,t1 normalized 0..1; durationSec = window length.
export function singSteps(steps, opts = {}) {
  const { tonicHz = 220, durationSec = 2.5, onProgress, onEnd } = opts;
  const c = getCtx();
  stopPlayback();
  if (!steps.length) { if (onEnd) onEnd(); return { durationSec, cancel: () => {} }; }
  const dur = durationSec;
  const t0 = c.currentTime + 0.06;

  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  const vib = c.createOscillator(); vib.frequency.value = 5.5;
  const vibGain = c.createGain(); vibGain.gain.value = 3;
  vib.connect(vibGain).connect(osc.frequency);

  const master = c.createGain(); master.gain.value = 0.0001;
  const f1 = c.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 700; f1.Q.value = 6;
  const f2 = c.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1150; f2.Q.value = 9;
  const g1 = c.createGain(); g1.gain.value = 1.0;
  const g2 = c.createGain(); g2.gain.value = 0.7;
  const low = c.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 2800;
  const gd = c.createGain(); gd.gain.value = 0.22;
  osc.connect(f1).connect(g1).connect(master);
  osc.connect(f2).connect(g2).connect(master);
  osc.connect(low).connect(gd).connect(master);
  master.connect(c.destination);

  osc.frequency.setValueAtTime(semitoneToFreq(tonicHz, steps[0].p), t0);
  steps.forEach((s) => {
    const on = t0 + s.t0 * dur;
    const off = t0 + s.t1 * dur;
    const f = semitoneToFreq(tonicHz, s.p);
    osc.frequency.setValueAtTime(f, on);
    // amplitude: attack, sustain, release within the step; silence between.
    master.gain.setValueAtTime(0.03, on);
    master.gain.linearRampToValueAtTime(0.28, on + Math.min(0.05, (off - on) * 0.25));
    master.gain.setValueAtTime(0.24, Math.max(on + 0.02, off - 0.05));
    master.gain.linearRampToValueAtTime(0.03, off);
  });
  master.gain.linearRampToValueAtTime(0, t0 + dur + 0.05);

  osc.start(t0); vib.start(t0);
  osc.stop(t0 + dur + 0.12); vib.stop(t0 + dur + 0.12);
  current = { osc, gain: master };

  let raf;
  const tick = () => {
    const elapsed = c.currentTime - t0;
    const t01 = Math.min(1, Math.max(0, elapsed / dur));
    if (onProgress) onProgress(t01);
    if (elapsed < dur) raf = requestAnimationFrame(tick);
    else { if (onProgress) onProgress(1); if (onEnd) onEnd(); current = null; }
  };
  raf = requestAnimationFrame(tick);
  return { durationSec: dur, cancel: () => { cancelAnimationFrame(raf); stopPlayback(); } };
}

// Play a single sustained reference tone (for "give me the tonic").
export function playTone(freq, durSec = 1.0) {
  const c = getCtx();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  osc.connect(gain).connect(c.destination);
  const t0 = c.currentTime;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.2, t0 + 0.05);
  gain.gain.linearRampToValueAtTime(0, t0 + durSec);
  osc.start(t0);
  osc.stop(t0 + durSec + 0.05);
}
