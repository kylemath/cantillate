// Microphone pitch detection via time-domain autocorrelation.
// Emits a smoothed fundamental frequency (Hz) or null when unvoiced.

import { getCtx } from './audio.js';

let audioCtx = null;
let stream = null;
let analyser = null;
let source = null;
let running = false;
let rafId = null;
let buf = null;
let freqBuf = null;
let opening = null; // in-flight acquire(), so two takes can't open two devices
let idleTimer = null;
let sessionSeq = 0; // bumped by every stop/release, to abandon an open nobody wants

// Opening a capture device costs a few hundred milliseconds on a built-in mic
// and seconds on Bluetooth, and the take would be counting time (and scoring the
// power-up pop) throughout. So the device is opened once and kept warm between
// takes; releaseMic() below hands it back when the app is done with it.
const IDLE_RELEASE_MS = 60000;
// Frames pulled and discarded while a freshly opened input settles.
const WARMUP_MS = 150;
const WARMUP_MAX_MS = 700;
const STEADY_FRAMES = 3;

// Is the cached graph still usable? An input can vanish underneath us — a USB
// mic unplugged, the OS handing the device to another app — which ends its
// tracks. A persisted-but-dead mic would silently record nothing forever, so it
// has to be spotted and rebuilt rather than reused.
function micLive() {
  if (!audioCtx || audioCtx.state === 'closed' || !stream || !analyser) return false;
  if (stream.active === false) return false;
  const tracks = stream.getAudioTracks();
  return tracks.length > 0 && tracks.every((t) => t.readyState === 'live');
}

// Resolve once the mic is genuinely producing usable audio. Warm (cached from an
// earlier take) that is immediate; cold it pays the hardware open plus warm-up.
async function acquire() {
  if (micLive()) {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return;
  }
  if (!opening) opening = openDevice().finally(() => { opening = null; });
  return opening;
}

async function openDevice() {
  teardown(); // drop anything stale before rebuilding on top of it
  audioCtx = getCtx(); // shared with playback; only the capture nodes are ours
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  buf = new Float32Array(analyser.fftSize);
  freqBuf = new Uint8Array(analyser.frequencyBinCount);
  await warmUp();
}

// A device that has just powered up emits a DC step and a settling transient
// before its gain stage steadies. That burst is far LOUDER than the unvoiced
// gate in autoCorrelate, so it sails through and lands in the pitch trail and
// the live meter as if it had been sung — raising the gate would only punish
// quiet singing. Instead the first frames are pulled and thrown away, until both
// a minimum warm-up has passed and the level has held steady for a few buffers
// (slow-settling devices), with a hard cap so singing straight into the open
// can't stall the take.
function warmUp() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let prev = null;
    let steady = 0;
    let done = false;
    let cap = 0;
    const finish = () => { if (!done) { done = true; clearTimeout(cap); resolve(); } };
    const tick = () => {
      if (done) return;
      if (!analyser || !buf) { finish(); return; } // released mid warm-up
      analyser.getFloatTimeDomainData(buf);
      const rms = computeRms(buf);
      // An all-zero buffer means the graph has no audio in it yet, not that the
      // input has settled — even a quiet room has a noise floor.
      const usable = rms > 0 && prev != null && Math.abs(rms - prev) <= Math.max(0.002, prev * 0.5);
      steady = usable ? steady + 1 : 0;
      prev = rms;
      if (performance.now() - t0 >= WARMUP_MS && steady >= STEADY_FRAMES) { finish(); return; }
      requestAnimationFrame(tick);
    };
    // rAF drives the sampling, but it is frozen in a hidden tab, so the cap is a
    // timer: acquire() must always resolve or the take never begins.
    cap = setTimeout(finish, WARMUP_MAX_MS);
    requestAnimationFrame(tick);
  });
}

export async function startMic(onPitch, onLevel) {
  if (running) return;
  cancelIdleRelease();
  const seq = sessionSeq;
  await acquire();
  // The take can be cancelled (or replaced by the next one) while the device is
  // opening; don't strand a loop feeding callbacks nobody is listening to.
  if (running || seq !== sessionSeq || !micLive()) return;
  running = true;

  let lastHz = null;
  const loop = () => {
    if (!running) return;
    analyser.getFloatTimeDomainData(buf);
    analyser.getByteFrequencyData(freqBuf);
    const rms = computeRms(buf);
    if (onLevel) onLevel(rms);
    const hz = autoCorrelate(buf, audioCtx.sampleRate);
    const frame = { freq: freqBuf, sampleRate: audioCtx.sampleRate, fftSize: analyser.fftSize };
    if (hz > 0) {
      // Smooth (exponential) to reduce jitter -> "fuzzy line".
      lastHz = lastHz == null ? hz : lastHz * 0.6 + hz * 0.4;
      onPitch(lastHz, rms, frame);
    } else {
      lastHz = null;
      onPitch(null, rms, frame);
    }
    rafId = requestAnimationFrame(loop);
  };
  loop();
}

// End the take: stop the frame loop and stop delivering callbacks. The device
// itself stays open and warm so the next take starts instantly and without a
// second power-up transient; it is only handed back after a spell of idleness.
export function stopMic() {
  sessionSeq++;
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  armIdleRelease();
}

// Give the microphone back to the OS. The browser lights a "microphone in use"
// indicator for as long as the stream is held, so an app that keeps it warm has
// to let go once it is plainly not recording any more — on an idle timeout, and
// whenever the page is hidden or torn down.
export function releaseMic() {
  sessionSeq++;
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  cancelIdleRelease();
  teardown();
}

// Hand back the capture device and drop the nodes hanging off it. The context
// itself deliberately survives: it is shared with the synth and the recorded
// chant (see getCtx), it cannot be reopened once closed, and closing it here
// would leave the rest of the page silent for good. audioCtx therefore keeps
// pointing at the live shared context — micLive() decides on the stream, not on
// the context, so a mic-less-but-running context reads as "not live" and the
// next take rebuilds only what it actually lost.
function teardown() {
  if (source) source.disconnect();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = analyser = source = null;
  buf = freqBuf = null;
}

function armIdleRelease() {
  cancelIdleRelease();
  idleTimer = setTimeout(() => { idleTimer = null; releaseMic(); }, IDLE_RELEASE_MS);
}

function cancelIdleRelease() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', releaseMic);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseMic(); });
}

function computeRms(b) {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i] * b[i];
  return Math.sqrt(s / b.length);
}

// Reusable pitch detector for an external time-domain buffer (e.g. audio
// element analysis). Returns Hz or -1.
export function detectPitch(buf, sampleRate) {
  return autoCorrelate(buf, sampleRate);
}

// The answer is only ever accepted inside the human vocal range, and since
// freq = rate / lag that bounds the lags worth looking at: everything outside
// VOICE_MIN_HZ..VOICE_MAX_HZ was being computed only to be thrown away by the
// guard at the bottom of autoCorrelate.
const VOICE_MIN_HZ = 65;
const VOICE_MAX_HZ = 1500;
const UNVOICED_RMS = 0.008;
// Nothing above VOICE_MAX_HZ says anything about the fundamental, so the window
// is decimated before it is correlated — which shrinks the sample count and the
// lag count at the same time, the difference between a couple of million
// multiply-adds per frame and a few tens of thousands. 8 kHz rather than a bare
// Nyquist 3 kHz leaves the anti-alias filter's transition band above the
// harmonics that give the correlation peak its shape.
const DECIM_TARGET_HZ = 8000;
// Decimating without filtering first would fold everything above the new
// Nyquist down into the vocal band and invent fundamentals nobody sang. Four
// cascaded one-poles, measured on a 48 kHz sweep: -6 dB at 1.5 kHz (harmless,
// the peak's position matters and not its height) and -49 dB at 6.5 kHz, which
// is the region that would otherwise land on 1.5 kHz.
const LP_CUTOFF_HZ = 2400;
// The least in-band energy, as a fraction of the buffer's total, that could
// plausibly hold a fundamental. Sound living entirely above the low-pass — a
// sibilant, a whistle, hiss — leaves almost nothing behind, and without this its
// filter residue would still be correlated and would still yield a peak.
const BAND_FLOOR_RATIO = 0.1;
// A signal periodic at T is also periodic at 2T and 3T. Searching at full rate
// the true peak always won, because the triangular envelope favours short lags;
// on the coarser decimated grid the true peak often falls between two samples
// while a multiple of it falls squarely on one, so the tallest peak is the
// wrong one. Take instead the earliest peak that comes within this of the best.
const PEAK_ACCEPT_RATIO = 0.9;
// Conversely a peak at a lag shorter than the range allows means the real period
// is shorter than VOICE_MAX_HZ — a whistle, feedback, a struck object. The
// full-rate search rejected those through the range guard, having actually
// found the short period; the decimated grid cannot see it, so it is inferred
// from the peak that does survive.
const HIGH_PEAK_RATIO = 0.7;

// Scratch for the detector, reused across frames. Allocating a window and a
// correlation table per frame fed GC pressure straight into the animation loop;
// they are sized to the largest caller (the analysers differ in fftSize) and
// both callers run to completion on the same thread, so one set is enough.
let decBuf = null;
let corrBuf = null;

// Autocorrelation pitch detector over the vocal band (returns Hz or -1).
function autoCorrelate(b, sampleRate) {
  const SIZE = b.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += b[i] * b[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < UNVOICED_RMS) return -1; // too quiet / unvoiced

  const decim = Math.max(1, Math.floor(sampleRate / DECIM_TARGET_HZ));
  const decRate = sampleRate / decim;
  const n = Math.floor(SIZE / decim);
  if (n < 32) return -1; // too short to hold a period and a peak
  if (!decBuf || decBuf.length < n) decBuf = new Float32Array(n);
  if (!corrBuf || corrBuf.length < n) corrBuf = new Float64Array(n);

  // Low-pass and decimate in a single pass. The poles start on the first sample
  // so the filter doesn't ring on its own start-up step, and each output is the
  // mean of its group rather than one picked sample, which puts a boxcar's
  // nulls exactly on the frequencies that would fold onto DC.
  const k = 1 - Math.exp((-2 * Math.PI * LP_CUTOFF_HZ) / sampleRate);
  let p0 = b[0], p1 = b[0], p2 = b[0], p3 = b[0];
  let acc = 0, held = 0, w = 0, sum = 0;
  for (let i = 0; i < SIZE && w < n; i++) {
    p0 += k * (b[i] - p0);
    p1 += k * (p0 - p1);
    p2 += k * (p1 - p2);
    p3 += k * (p2 - p3);
    acc += p3;
    if (++held === decim) {
      const v = acc / decim;
      decBuf[w++] = v;
      sum += v;
      acc = 0;
      held = 0;
    }
  }

  // Centre the window. A DC offset — routine on cheap inputs, and precisely what
  // a just-powered-up device emits — adds a pedestal that shrinks with lag, and
  // so drags the peak towards the short end of the search.
  const mean = sum / n;
  let bandRms = 0;
  for (let i = 0; i < n; i++) {
    const v = decBuf[i] - mean;
    decBuf[i] = v;
    bandRms += v * v;
  }
  bandRms = Math.sqrt(bandRms / n);
  if (bandRms < BAND_FLOOR_RATIO * rms) return -1; // loud, but nothing in band

  const minLag = Math.max(2, Math.floor(decRate / VOICE_MAX_HZ));
  // Correlate one lag past the longest period so the winning peak always has a
  // right-hand neighbour to interpolate against, and never past half the window,
  // where too few samples overlap for the result to mean anything.
  let maxLag = Math.min(Math.floor(decRate / VOICE_MIN_HZ), n >> 1);
  const hi = Math.min(maxLag + 1, n - 1);
  maxLag = hi - 1;
  if (maxLag <= minLag) return -1;

  // Lags below minLag are not candidates, but they are computed anyway (a
  // handful of short sums) because the guard further down reads them.
  for (let lag = 1; lag <= hi; lag++) {
    let s = 0;
    const end = n - lag;
    for (let i = 0; i < end; i++) s += decBuf[i] * decBuf[i + lag];
    corrBuf[lag] = s;
  }

  // Step off the trivial peak at lag 0: for a low note its shoulder is still the
  // tallest thing in the search range, and it is not a period.
  let d = 1;
  while (d < maxLag && corrBuf[d] > corrBuf[d + 1]) d++;
  const from = Math.max(d, minLag);
  if (from >= maxLag) return -1;

  let maxval = -Infinity, maxpos = -1;
  for (let i = from; i <= maxLag; i++) {
    if (corrBuf[i] > maxval) { maxval = corrBuf[i]; maxpos = i; }
  }
  if (maxpos < 0 || maxval <= 0) return -1;

  let T0 = maxpos;
  for (let i = from; i <= maxLag; i++) {
    if (corrBuf[i] >= corrBuf[i - 1] && corrBuf[i] >= corrBuf[i + 1]
        && corrBuf[i] >= PEAK_ACCEPT_RATIO * maxval) { T0 = i; break; }
  }

  let highval = 0, highpos = -1;
  for (let i = 2; i < minLag; i++) {
    if (corrBuf[i] >= corrBuf[i - 1] && corrBuf[i] >= corrBuf[i + 1] && corrBuf[i] > highval) {
      highval = corrBuf[i]; highpos = i;
    }
  }
  if (highpos > 0 && highval >= HIGH_PEAK_RATIO * corrBuf[T0]) return -1; // above the vocal range

  // Parabolic interpolation for sub-sample accuracy, on the three points with
  // the triangular (n - lag) envelope divided back out: left in, the envelope's
  // downslope tilts the parabola and biases every reading sharp.
  const x1 = corrBuf[T0 - 1] / (n - T0 + 1);
  const x2 = corrBuf[T0] / (n - T0);
  const x3 = corrBuf[T0 + 1] / (n - T0 - 1);
  const a = (x1 + x3 - 2 * x2) / 2;
  const bb = (x3 - x1) / 2;
  let T = T0;
  if (a) T = T0 - bb / (2 * a);

  const freq = decRate / T;
  if (freq < VOICE_MIN_HZ || freq > VOICE_MAX_HZ) return -1; // plausible human vocal range
  return freq;
}

// Convert a frequency to semitone offset relative to a tonic (Hz), folded into
// the octave nearest the target so octave errors don't ruin the overlay.
export function freqToSemitone(freqHz, tonicHz) {
  if (!freqHz || freqHz <= 0) return null;
  let st = 12 * Math.log2(freqHz / tonicHz);
  // Fold to within +/- 6 semitones of tonic for stable display.
  while (st > 7) st -= 12;
  while (st < -7) st += 12;
  return st;
}
