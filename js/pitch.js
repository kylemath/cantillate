// Microphone pitch detection via time-domain autocorrelation.
// Emits a smoothed fundamental frequency (Hz) or null when unvoiced.

let audioCtx = null;
let stream = null;
let analyser = null;
let source = null;
let running = false;
let rafId = null;
let buf = null;

export async function startMic(onPitch, onLevel) {
  if (running) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  buf = new Float32Array(analyser.fftSize);
  const freqBuf = new Uint8Array(analyser.frequencyBinCount);
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

export function stopMic() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (source) source.disconnect();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  audioCtx = stream = analyser = source = null;
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

// Classic autocorrelation pitch detector (returns Hz or -1).
function autoCorrelate(b, sampleRate) {
  const SIZE = b.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += b[i] * b[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.008) return -1; // too quiet / unvoiced

  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(b[i]) < thres) { r1 = i; break; }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(b[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  }
  const buf2 = b.slice(r1, r2);
  const n = buf2.length;
  const c = new Array(n).fill(0);
  for (let lag = 0; lag < n; lag++) {
    for (let i = 0; i < n - lag; i++) c[lag] += buf2[i] * buf2[i + lag];
  }

  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < n; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  let T0 = maxpos;
  if (T0 <= 0) return -1;

  // Parabolic interpolation for sub-sample accuracy.
  const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2;
  const bb = (x3 - x1) / 2;
  if (a) T0 = T0 - bb / (2 * a);

  const freq = sampleRate / T0;
  if (freq < 65 || freq > 1500) return -1; // plausible human vocal range
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
