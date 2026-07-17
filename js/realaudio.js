// Playback + live analysis of the real recorded chant (PocketTorah).
// Routes each audio file through Web Audio so we can (a) draw a spectrogram of
// the singing voice and (b) extract its pitch contour to compare against the
// idealized coach line. Supports playing any [start, end) slice (a whole verse
// or a single word) using the mp3 track times.

import { detectPitch } from './pitch.js';

let ctx = null;
const cache = new Map(); // url -> { el, source, analyser }
let active = null;       // { el, raf }

function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function getEntry(url) {
  let e = cache.get(url);
  if (!e) {
    const el = new Audio();
    el.preload = 'auto';
    el.src = url;
    const c = ensureCtx();
    const source = c.createMediaElementSource(el);
    const analyser = c.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    analyser.connect(c.destination);
    e = { el, source, analyser };
    cache.set(url, e);
  }
  return e;
}

export function stopVerseAudio() {
  if (active) {
    try { active.el.pause(); } catch (e) { /* noop */ }
    cancelAnimationFrame(active.raf);
    active.el.onended = null;
    active = null;
  }
}

// cb: { onProgress(t01), onAnalysis({t01,hz,freq,sampleRate,fftSize}), onEnd(), onError(e) }
export function playSegment(url, start, end, cb = {}) {
  ensureCtx();
  stopVerseAudio();
  const e = getEntry(url);
  const analyser = e.analyser;
  const timeBuf = new Float32Array(analyser.fftSize);
  const freqBuf = new Uint8Array(analyser.frequencyBinCount);

  const begin = () => {
    try { e.el.currentTime = start; } catch (err) { /* retry via canplay */ }
    const total = (end != null ? end : e.el.duration) - start;

    const finish = () => {
      e.el.pause();
      if (active) cancelAnimationFrame(active.raf);
      e.el.onended = null;
      const done = cb.onEnd;
      active = null;
      if (done) done();
    };

    const tick = () => {
      const t = e.el.currentTime;
      const t01 = Math.min(1, Math.max(0, (t - start) / (total || 1)));
      analyser.getFloatTimeDomainData(timeBuf);
      analyser.getByteFrequencyData(freqBuf);
      const hz = detectPitch(timeBuf, ctx.sampleRate);
      if (cb.onAnalysis) {
        cb.onAnalysis({ t01, hz, freq: freqBuf, sampleRate: ctx.sampleRate, fftSize: analyser.fftSize });
      }
      if (cb.onProgress) cb.onProgress(t01);
      if (end != null && t >= end) { finish(); return; }
      if (active) active.raf = requestAnimationFrame(tick);
    };

    e.el.onended = () => { if (active && active.el === e.el) finish(); };
    e.el.play().then(() => {
      active = { el: e.el, raf: requestAnimationFrame(tick) };
    }).catch((err) => { if (cb.onError) cb.onError(err); });
  };

  if (e.el.readyState >= 1 && !isNaN(e.el.duration)) begin();
  else e.el.addEventListener('loadedmetadata', begin, { once: true });
}

// Backward-compatible alias for verse-level playback.
export function playVerseAudio(url, start, end, cb = {}) {
  return playSegment(url, start, end, cb);
}
