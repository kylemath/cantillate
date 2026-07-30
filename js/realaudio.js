// Playback + live analysis of the real recorded chant (PocketTorah).
// Routes each audio file through Web Audio so we can (a) draw a spectrogram of
// the singing voice and (b) extract its pitch contour to compare against the
// idealized coach line. Supports playing any [start, end) slice (a whole verse
// or a single word) using the mp3 track times.

import { detectPitch } from './pitch.js';
import { getCtx } from './audio.js';
import { getObjectUrl } from './offline.js';

let ctx = null;
const cache = new Map(); // url -> { el, source, analyser }
// The one segment currently loaded in the transport. It survives a pause (so the
// window can be resumed or scrubbed word-by-word) and is only torn down by
// stopVerseAudio or by reaching the end of the segment.
let active = null;       // { el, raf, start, end, total, cb, paused, previewFrom, previewUntil }

// The page's single AudioContext (see getCtx in audio.js). It matters here twice
// over: a MediaElementSource is welded to the context that made it and the cache
// below outlives any one playback, so every entry has to sit on the same one;
// and scoring a duet means comparing the recording's clock with the mic's, which
// is only meaningful while they are the same clock.
function ensureCtx() {
  ctx = getCtx();
  return ctx;
}

// Stretches of a recording that belong to no word: a false start, a cough, an
// aside to the room. Somebody chanting live into a phone leaves them behind, and
// they are cut out by ear in scripts/label.html (see scripts/onsettrack.py).
// They belong to the recording rather than to any one playback, so they are
// registered per file and jumped by every kind of playback there is — a verse,
// a chained aliyah, the duet guide, a spliced drill.
const cuts = new Map();  // url -> [[from, to], ...] in order

export function setAudioCuts(url, list) {
  if (!list || !list.length) cuts.delete(url);
  else cuts.set(url, [...list].sort((a, b) => a[0] - b[0]));
}

// What has been cut out of a file, for whoever wants to check (the harness does).
export function audioCutsFor(url) { return cuts.get(url) || []; }

// Where playback should land if `t` fell inside a cut, else null.
function pastCut(url, t) {
  const list = cuts.get(url);
  if (!list) return null;
  for (const [from, to] of list) {
    if (t > from && t < to) return to;
    if (from > t) break;
  }
  return null;
}

function getEntry(url) {
  let e = cache.get(url);
  if (!e) {
    const el = new Audio();
    el.preload = 'auto';
    // Prefer a locally-stored blob (downloaded for offline) so playback uses no
    // network; fall back to the network path when the reading isn't downloaded.
    el.src = getObjectUrl(url) || url;
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
      if (!active || active.paused) return;
      const t = e.el.currentTime;
      // Jump anything cut out of the reading. The playhead is read back from the
      // element rather than from elapsed time, so everything on screen follows
      // the jump by itself.
      const resume = pastCut(url, t);
      if (resume != null) {
        if (end != null && resume >= end) { finish(); return; }
        try { e.el.currentTime = resume; } catch (err) { /* seek refused; play on */ }
        active.raf = requestAnimationFrame(tick);
        return;
      }
      const t01 = Math.min(1, Math.max(0, (t - start) / (total || 1)));
      analyser.getFloatTimeDomainData(timeBuf);
      analyser.getByteFrequencyData(freqBuf);
      const hz = detectPitch(timeBuf, ctx.sampleRate);
      if (cb.onAnalysis) {
        cb.onAnalysis({ t01, hz, freq: freqBuf, sampleRate: ctx.sampleRate, fftSize: analyser.fftSize });
      }
      if (cb.onProgress) cb.onProgress(t01);
      // A word preview plays one word and parks the transport back at its start,
      // so scrubbing while paused stays paused.
      if (active.previewUntil != null && t >= active.previewUntil) {
        holdAt(active.previewFrom);
        return;
      }
      if (end != null && t >= end) { finish(); return; }
      active.raf = requestAnimationFrame(tick);
    };

    // Freeze the transport at an absolute track time without tearing it down.
    const holdAt = (time) => {
      if (!active) return;
      cancelAnimationFrame(active.raf);
      active.paused = true;
      active.previewUntil = null;
      try { active.el.pause(); } catch (err) { /* noop */ }
      if (time != null) { try { active.el.currentTime = time; } catch (err) { /* noop */ } }
      if (cb.onProgress) cb.onProgress(clamp01((active.el.currentTime - start) / (total || 1)));
    };

    e.el.onended = () => { if (active && active.el === e.el) finish(); };
    e.el.play().then(() => {
      active = { el: e.el, raf: 0, start, end, total, cb, paused: false, tick, holdAt };
      active.raf = requestAnimationFrame(tick);
    }).catch((err) => { if (cb.onError) cb.onError(err); });
  };

  if (e.el.readyState >= 1 && !isNaN(e.el.duration)) begin();
  else e.el.addEventListener('loadedmetadata', begin, { once: true });
}

function clamp01(x) { return Math.min(1, Math.max(0, x)); }

// --- Transport: pause / resume / scrub the loaded segment -------------------
// The verse window stays loaded while paused, so a reader who fumbles a word can
// stop, step back over it, and carry on from there instead of restarting.

export function isVerseAudioLoaded() { return !!active; }
export function isVerseAudioPaused() { return !!(active && active.paused); }
export function isVerseAudioPlaying() { return !!(active && !active.paused); }

// Where the transport sits in the current segment, 0..1, or null if idle.
export function verseAudioProgress() {
  if (!active) return null;
  return clamp01((active.el.currentTime - active.start) / (active.total || 1));
}

export function pauseVerseAudio() {
  if (!active || active.paused) return false;
  active.holdAt(null);
  return true;
}

export function resumeVerseAudio() {
  if (!active) return false;
  // Cancel any word preview first: left armed, it would park the transport again
  // a moment after we resumed, and playback would silently stop.
  active.previewUntil = null;
  if (!active.paused) return true;
  active.paused = false;
  active.el.play().then(() => {
    if (active) active.raf = requestAnimationFrame(active.tick);
  }).catch(() => { if (active) active.paused = true; });
  return true;
}

// Jump to a normalized position in the segment. While paused the transport stays
// paused (the playhead just moves); while playing it keeps rolling from there.
export function seekVerseAudio(t01) {
  if (!active) return false;
  const time = active.start + clamp01(t01) * (active.total || 1);
  try { active.el.currentTime = time; } catch (e) { return false; }
  if (active.paused && active.cb.onProgress) active.cb.onProgress(clamp01(t01));
  return true;
}

// Play a single stretch of the segment and return to `fromT01` paused, so
// stepping between words while paused lets you hear the word you land on.
export function previewVerseAudio(fromT01, toT01) {
  if (!active) return false;
  const dur = active.total || 1;
  const from = active.start + clamp01(fromT01) * dur;
  try { active.el.currentTime = from; } catch (e) { return false; }
  active.previewFrom = from;
  active.previewUntil = Math.min(active.end != null ? active.end : Infinity, active.start + clamp01(toT01) * dur);
  if (active.paused) {
    active.paused = false;
    active.el.play().then(() => {
      if (active) active.raf = requestAnimationFrame(active.tick);
    }).catch(() => { if (active) active.paused = true; });
  }
  return true;
}

// Backward-compatible alias for verse-level playback.
export function playVerseAudio(url, start, end, cb = {}) {
  return playSegment(url, start, end, cb);
}
