#!/usr/bin/env python3
"""Extract the real sung pitch contour from the recorded chant and derive, for
each word, a set of discrete note "steps" (per-syllable tones) that match the
spectrogram fundamental. These become the app's ground-truth coach line.

Pipeline:
  1. afconvert the mp3s to 16 kHz WAV (done separately / here if missing).
  2. Autocorrelation f0 track per audio file (numpy).
  3. Per verse: tonic = median voiced f0; per word: slice the track by the
     Masoretic word onsets, convert to semitones, and segment into stable steps.

Output: data/devarim1_pitch.json

Run inside the project venv:
  .venv/bin/python scripts/extract_pitch.py
"""
import json
import os
import subprocess
import wave

import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(HERE, "audio")
WAV_DIR = "/tmp/cw"
TEXT = os.path.join(HERE, "data", "devarim1.json")
AUDIO_JSON = os.path.join(HERE, "data", "devarim1_audio.json")
OUT = os.path.join(HERE, "data", "devarim1_pitch.json")
MAQAF = "\u05be"

FILES = [1, 2, 3, 4]
FMIN, FMAX = 80.0, 500.0
SR = 16000
FRAME = 1024
HOP = 160  # 10 ms


def ensure_wav(i):
    src = os.path.join(AUDIO_DIR, f"devarim-{i}.mp3")
    dst = os.path.join(WAV_DIR, f"devarim-{i}.wav")
    if not os.path.exists(dst):
        os.makedirs(WAV_DIR, exist_ok=True)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{SR}", src, dst], check=True)
    return dst


def read_wav_mono(path):
    w = wave.open(path, "rb")
    n, ch = w.getnframes(), w.getnchannels()
    raw = w.readframes(n)
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return a / 32768.0


def f0_track(sig):
    # Gate voicing on periodicity STRENGTH (autocorrelation), not loudness, so
    # the quiet-but-clearly-pitched tail of a descending trope is kept. A very
    # low rms floor still rejects true silence.
    minlag = int(SR / FMAX)
    maxlag = int(SR / FMIN)
    win = np.hanning(FRAME)
    times, f0s = [], []
    nfft = 2 * FRAME
    RMS_FLOOR = 0.003
    STRENGTH = 0.55
    for start in range(0, len(sig) - FRAME, HOP):
        fr = sig[start:start + FRAME] * win
        t = (start + FRAME / 2) / SR
        rms = np.sqrt(np.mean(fr * fr))
        if rms < RMS_FLOOR:
            times.append(t); f0s.append(0.0); continue
        f = np.fft.rfft(fr, nfft)
        ac = np.fft.irfft(f * np.conj(f))[:FRAME]
        if ac[0] <= 0:
            times.append(t); f0s.append(0.0); continue
        seg = ac[minlag:maxlag]
        peak = int(np.argmax(seg)) + minlag
        if ac[peak] < STRENGTH * ac[0]:  # weak periodicity -> unvoiced
            times.append(t); f0s.append(0.0); continue
        a0, b0, c0 = ac[peak - 1], ac[peak], ac[peak + 1]
        denom = (a0 - 2 * b0 + c0)
        shift = 0.5 * (a0 - c0) / denom if denom != 0 else 0.0
        lag = peak + shift
        times.append(t); f0s.append(SR / lag)
    return np.array(times), np.array(f0s)


def tokenize(text):
    # Maqaf-split, matching the app: one token per Masoretic word.
    out = []
    for w in text.strip().split():
        parts = w.split(MAQAF)
        for i, p in enumerate(parts):
            if p == "":
                continue
            out.append(p + MAQAF if i < len(parts) - 1 else p)
    return out


# Disjunctive te'amim (mirrors js/hebrew.js) for primary-accent selection.
DISJ = {0x0591, 0x0592, 0x0593, 0x0594, 0x0595, 0x0596, 0x0597, 0x0598, 0x0599,
        0x059A, 0x059B, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0, 0x05A1, 0x05AD, 0x05AE}


def primary_taam(token):
    marks = [ord(c) for c in token if 0x0591 <= ord(c) <= 0x05AE]
    if not marks:
        return None
    for m in marks:
        if m in DISJ:
            return m
    return marks[0]


NSHAPE = 24  # samples per averaged trope shape


def resample(tn, ps, n=NSHAPE):
    tn = np.asarray(tn, dtype=float)
    ps = np.asarray(ps, dtype=float)
    order = np.argsort(tn)
    tn, ps = tn[order], ps[order]
    return np.interp(np.linspace(0.0, 1.0, n), tn, ps)


def make_steps(ts, ps, tol=0.7, min_dur=0.07):
    """Segment (time, semitone) voiced samples into stable note steps."""
    if len(ps) == 0:
        return []
    segs = []
    i = 0
    n = len(ps)
    while i < n:
        j = i
        acc = [ps[i]]
        while j + 1 < n and (ts[j + 1] - ts[j]) < 0.06 and abs(ps[j + 1] - np.median(acc)) < tol:
            j += 1
            acc.append(ps[j])
        segs.append([ts[i], ts[j], float(np.median(acc))])
        i = j + 1
    # merge adjacent segments with near-equal pitch
    merged = [segs[0]]
    for s in segs[1:]:
        last = merged[-1]
        if abs(s[2] - last[2]) < 0.5 and (s[0] - last[1]) < 0.08:
            last[1] = s[1]
            last[2] = (last[2] + s[2]) / 2
        else:
            merged.append(s)
    # drop ultra-short blips
    return [s for s in merged if (s[1] - s[0]) >= min_dur] or merged


def main():
    text = json.load(open(TEXT, encoding="utf-8"))
    audio = json.load(open(AUDIO_JSON, encoding="utf-8"))

    tracks = {}
    durations = {}
    for i in FILES:
        wav = ensure_wav(i)
        sig = read_wav_mono(wav)
        durations[i] = len(sig) / SR
        print(f"analyzing file {i} ({durations[i]:.0f}s)...")
        tracks[i] = f0_track(sig)

    def file_num(path):
        return int(path.split("devarim-")[1].split(".")[0])

    trope_data = {}  # key -> list of {"r": resampled array, "steps": [...]}
    out_verses = {}
    for v in range(1, 47):
        info = audio["verses"][str(v)]
        fn = file_num(info["file"])
        ts, f0 = tracks[fn]
        vstart = info["start"]
        vend = info["end"] if info["end"] is not None else durations[fn]
        # verse tonic = median voiced f0 within the verse span
        mask = (ts >= vstart) & (ts <= vend) & (f0 > 0)
        voiced = f0[mask]
        if len(voiced) < 5:
            continue
        tonic = float(np.median(voiced))

        onsets = info["onsets"]
        tokens = tokenize(text["verses"][v - 1]["text"])
        words = []
        # One entry per Masoretic word (audio onset), matching the app's split.
        for k in range(len(onsets)):
            ti = k
            w_start = onsets[k]
            if k + 1 < len(onsets):
                w_end = onsets[k + 1]
            elif info["end"] is not None:
                w_end = info["end"]
            else:
                w_end = min(w_start + 1.4, vend)

            wmask = (ts >= w_start) & (ts < w_end) & (f0 > 0)
            wts = ts[wmask]
            wf0 = f0[wmask]
            if len(wf0) < 2:
                words.append({"i": ti, "start": round(w_start, 3), "end": round(w_end, 3),
                              "steps": [], "raw": []})
                continue
            semis = 12.0 * np.log2(wf0 / tonic)
            # 3-point median to kill isolated single-frame octave/transient spikes.
            if len(semis) >= 3:
                sm = np.copy(semis)
                sm[1:-1] = np.median(np.vstack([semis[:-2], semis[1:-1], semis[2:]]), axis=0)
                semis = sm
            # Fix octave errors WITHOUT deleting rare-but-real ornamental notes.
            # Octave errors (autocorrelation picking a sub/super-harmonic) sit ~a
            # whole octave (12/24 st) from the word median; real ornamental peaks
            # sit only a few semitones away. So fold frames that are near a
            # nonzero multiple of 12 back toward the median (recovering the true
            # note), then drop only what is still far outside the melodic range
            # (non-octave harmonic garbage / transients). The previous SD clip
            # deleted sustained ornamental notes >3.5 st from the median.
            if len(semis) >= 5:
                med = float(np.median(semis))
                octn = np.round((semis - med) / 12.0)
                near_octave = (octn != 0) & (np.abs(semis - med - 12.0 * octn) < 3.0)
                semis = np.where(near_octave, semis - 12.0 * octn, semis)
                keep = np.abs(semis - med) <= 9.0
                wts, wf0, semis = wts[keep], wf0[keep], semis[keep]
            if len(semis) < 2:
                words.append({"i": ti, "start": round(w_start, 3), "end": round(w_end, 3),
                              "steps": [], "raw": []})
                continue
            steps_abs = make_steps(wts, semis)
            dur = (w_end - w_start) or 1.0
            steps = [{"t0": round((s[0] - w_start) / dur, 3),
                      "t1": round((s[1] - w_start) / dur, 3),
                      "p": round(s[2], 2)} for s in steps_abs]
            # downsampled raw contour (normalized within word)
            step_r = max(1, len(wts) // 40)
            raw = [{"t": round((wts[k] - w_start) / dur, 3), "p": round(float(semis[k]), 2)}
                   for k in range(0, len(wts), step_r)]
            words.append({"i": ti, "start": round(w_start, 3), "end": round(w_end, 3),
                          "steps": steps, "raw": raw})

            # Collect this word's contour + steps by its trope (last word = sof
            # pasuk) to pick a representative shape per accent for the icons.
            if len(semis) >= 5 and steps:
                if k == len(onsets) - 1:
                    key = "sof"
                elif k < len(tokens):
                    pt = primary_taam(tokens[k])
                    key = str(pt) if pt is not None else "none"
                else:
                    key = "none"
                tn = (wts - w_start) / dur
                trope_data.setdefault(key, []).append({"r": resample(tn, semis), "steps": steps})

        out_verses[str(v)] = {
            "tonicHz": round(tonic, 2),
            "start": round(vstart, 3),
            "end": round(vend, 3),
            "file": info["file"],
            "words": words,
        }

    out = {
        "slug": "devarim1",
        "source": "https://pockettorah.com",
        "license": "Derived pitch analysis of PocketTorah recordings (CC-BY-SA).",
        "note": "Per-word note steps extracted from the recording's fundamental; semitones relative to each verse's median (tonic).",
        "verses": out_verses,
    }
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"Wrote pitch data for {len(out_verses)} verses to {OUT}")

    # Representative per-trope shape for the legend icons: the single instance
    # whose contour is closest to the group mean (a real, clean step structure),
    # rather than an average that smears transitions into spurious steps.
    shapes = {}
    xs = np.linspace(0.0, 1.0, NSHAPE)
    for key, insts in trope_data.items():
        R = np.vstack([d["r"] for d in insts])
        mean = R.mean(axis=0)
        dists = np.sqrt(((R - mean) ** 2).sum(axis=1))
        best = int(np.argmin(dists))
        rep = insts[best]
        shapes[key] = {
            "n": len(insts),
            "steps": rep["steps"],
            "contour": [{"t": round(float(xs[i]), 3), "p": round(float(rep["r"][i]), 2)} for i in range(NSHAPE)],
        }
    shapes_out = {
        "slug": "devarim1",
        "note": "Most-representative (medoid-by-mean) pitch shape per trope, with its real note steps.",
        "shapes": shapes,
    }
    shapes_path = os.path.join(HERE, "data", "devarim1_shapes.json")
    json.dump(shapes_out, open(shapes_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    counts = {k: shapes[k]["n"] for k in shapes}
    print(f"Wrote {len(shapes)} representative trope shapes to {shapes_path}: {counts}")


if __name__ == "__main__":
    main()
