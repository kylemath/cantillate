#!/usr/bin/env python3
"""Derive per-word onsets for a recording of a known passage.

    .venv/bin/python scripts/align_recording.py \
        --audio audio/teacher/i-samuel-28-H.m4a \
        --book i-samuel --range 28:8-28:19 \
        --id teacher --out i-samuel-28.txt

A `local` audio source needs the same thing PocketTorah ships with its mp3s: a
comma-separated list of word onsets, one per Masoretic word, in order. Nobody
publishes those for a recording made in a teacher's living room, and tapping out
several hundred of them by hand is a bad evening. So we make them.

How it works — the aeneas trick, with no dependencies beyond what macOS already
has. We know exactly what is being chanted, so this is alignment, not
recognition:

  1. speak the passage word by word with `say -v Carmit`, giving a REFERENCE
     signal whose word boundaries are known to the sample;
  2. reduce both signals to MFCCs, which describe which sounds are being made
     while ignoring pitch — the one thing that separates chanting from speech;
  3. dynamic-time-warp the reference onto the recording, which is exactly the
     problem DTW solves: same sounds in the same order at wildly different
     speeds (this recording runs ~2.7x slower than the synthetic voice);
  4. read each word's onset off the warping path.

Two details earn their keep. Both ends of the path are anchored, because a free
endpoint makes skipping audio the cheapest option and the text collapses into a
corner. Material with no counterpart in the text — a spoken introduction, an
outro — is absorbed instead by a GARBAGE row at each end that matches anything
at a flat price, and real words pay a penalty for dwelling so they can't quietly
swallow the introduction themselves.

The result is close but not exact, so the script also writes a review file for
scripts/label.html, where the onsets can be heard and corrected.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_pitch as ep                # noqa: E402  (read_wav_mono, SR)
import hebtok                             # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(HERE, "data")
LOCAL_LABELS_DIR = os.path.join(DATA_DIR, "local_sources")
TANAKH_DIR = os.path.join(DATA_DIR, "tanakh")
WORK_DIR = "/tmp/cw"
TTS_DIR = os.path.join(WORK_DIR, "tts")

SR = ep.SR
HOP_MS = 20
# The garbage rows should cost about what a wrong match costs, so they take the
# introduction and leave the chanting alone: below the median they start eating
# real words at the edges, well above it they hand the introduction back.
GAMMA_PCT = 50      # garbage-row price, as a percentile of the cost distribution
DWELL = 0.5         # per-frame surcharge for a real word holding still


# ---------------------------------------------------------------- reference
def synth(words, voice="Carmit"):
    """Speak each word; return the concatenated signal and per-word bounds.

    Cached by text, so re-running after a range change re-synthesizes only the
    words that actually changed.
    """
    os.makedirs(TTS_DIR, exist_ok=True)
    parts, bounds, pos = [], [], 0
    for w in words:
        say = hebtok.speakable(w)
        key = hashlib.sha1(f"{voice}:{say}".encode()).hexdigest()[:16]
        wav = os.path.join(TTS_DIR, f"{key}.wav")
        if not os.path.exists(wav):
            txt = os.path.join(TTS_DIR, f"{key}.txt")
            with open(txt, "w") as f:
                f.write(say)
            subprocess.run(["say", "-v", voice, "-f", txt,
                            f"--data-format=LEI16@{SR}", "--file-format=WAVE",
                            "-o", wav], check=True)
        sig = trim_silence(ep.read_wav_mono(wav))
        parts.append(sig)
        bounds.append((pos, pos + len(sig)))
        pos += len(sig)
    return np.concatenate(parts), bounds


def trim_silence(sig, below_peak_db=-45):
    hop = 160
    n = len(sig) // hop * hop
    if n == 0:
        return sig
    fr = sig[:n].reshape(-1, hop)
    db = 20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-9)
    loud = np.where(db > db.max() + below_peak_db)[0]
    return sig if len(loud) == 0 else sig[loud[0] * hop:(loud[-1] + 1) * hop]


def have_voice(voice):
    out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    return any(line.split()[0] == voice for line in out.splitlines() if line.strip())


# --------------------------------------------------------------------- MFCC
def mel_filterbank(n_filt=26, nfft=512, fmin=50, fmax=7000):
    def hz2mel(f):
        return 2595 * np.log10(1 + f / 700)

    def mel2hz(m):
        return 700 * (10 ** (m / 2595) - 1)

    pts = mel2hz(np.linspace(hz2mel(fmin), hz2mel(fmax), n_filt + 2))
    bins = np.floor((nfft + 1) * pts / SR).astype(int)
    fb = np.zeros((n_filt, nfft // 2 + 1))
    for m in range(1, n_filt + 1):
        lo, mid, hi = bins[m - 1], max(bins[m], bins[m - 1] + 1), 0
        hi = max(bins[m + 1], mid + 1)
        fb[m - 1, lo:mid] = (np.arange(lo, mid) - lo) / (mid - lo)
        fb[m - 1, mid:hi] = (hi - np.arange(mid, hi)) / (hi - mid)
    return fb


FB = mel_filterbank()
DCT = np.cos(np.pi * np.outer(np.arange(13), np.arange(26) + 0.5) / 26)


def mfcc(sig, hop_ms=HOP_MS, win_ms=25):
    """Unit-length MFCCs, c1..c12. c0 (loudness) is dropped and each dimension
    is normalized over the utterance, so a living-room recording and a synthetic
    voice are compared on the sounds themselves rather than level or timbre."""
    hop, win = int(SR * hop_ms / 1000), int(SR * win_ms / 1000)
    sig = np.append(sig[0], sig[1:] - 0.97 * sig[:-1])          # pre-emphasis
    n = 1 + max(0, (len(sig) - win) // hop)
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    frames = sig[idx] * np.hamming(win)
    with np.errstate(all="ignore"):                              # Accelerate BLAS
        spec = np.abs(np.fft.rfft(frames, 512)) ** 2 / 512
        mel = np.log(FB @ spec.T + 1e-10).T
        c = (mel @ DCT.T)[:, 1:]
        c = (c - c.mean(0)) / (c.std(0) + 1e-8)
        return (c / (np.linalg.norm(c, axis=1, keepdims=True) + 1e-8)).astype(np.float32)


# ---------------------------------------------------------------------- DTW
def warp_path(ref, rec, gamma, dwell=DWELL):
    """Align every reference frame to the recording, both ends anchored, with a
    garbage row prepended and appended. Returns [(ref_row, rec_frame)] where
    ref_row 0 is the leading garbage row.

    Horizontal runs are unbounded — a held note or a breath can park on one
    reference frame for seconds — so the usual sequential inner loop is replaced
    by a prefix scan: a left-chain from k to j costs base[k] + C[j] - C[k] with
    C the row's cumulative cost, making the best chain a running minimum.
    """
    R, T = len(ref) + 2, len(rec)
    ptr = np.zeros((R, T), dtype=np.int8)                        # 1 diag 2 up 3 left
    cols = np.arange(T)

    def row_cost(i):
        if i == 0 or i == R - 1:
            return np.full(T, gamma, dtype=np.float32)
        with np.errstate(all="ignore"):
            return (1.0 - ref[i - 1] @ rec.T).astype(np.float32)

    prev = np.cumsum(row_cost(0), dtype=np.float64).astype(np.float32)
    ptr[0, 1:] = 3
    for i in range(1, R):
        cost = row_cost(i)
        diag = np.empty(T, dtype=np.float32)
        diag[0], diag[1:] = np.inf, prev[:-1]
        take_diag = diag <= prev
        base = np.where(take_diag, diag, prev) + cost
        choice = np.where(take_diag, 1, 2).astype(np.int8)
        garbage = i == 0 or i == R - 1
        C = np.cumsum(cost if garbage else cost + dwell, dtype=np.float64)
        vals = base - C
        run = np.minimum.accumulate(vals)
        left = (run + C).astype(np.float32)
        use = left < base
        src = np.maximum.accumulate(np.where(vals <= run, cols, 0))
        ptr[i] = np.where(use & (src < cols), 3, choice)
        prev = np.where(use, left, base)

    i, j, path = R - 1, T - 1, []
    while i > 0 or j > 0:
        path.append((i, j))
        c = ptr[i, j]
        if c == 1:
            i, j = i - 1, j - 1
        elif c == 2:
            i -= 1
        else:
            j -= 1
        if i == 0 and j == 0:
            break
    path.append((0, 0))
    return path[::-1]


# --------------------------------------------------------------------- text
def load_passage(book_slug, c0, v0, c1, v1):
    path = os.path.join(TANAKH_DIR, f"{book_slug}.json")
    if not os.path.exists(path):
        raise SystemExit(f"no corpus for book {book_slug!r} ({path}); run scripts/build_tanakh.py")
    doc = json.load(open(path))
    chapters = doc["chapters"]
    words, refs = [], []
    for c in range(c0, c1 + 1):
        if c > len(chapters):
            raise SystemExit(f"{book_slug} has no chapter {c}")
        verses = chapters[c - 1]
        lo = v0 if c == c0 else 1
        hi = v1 if c == c1 else len(verses)
        for v in range(lo, hi + 1):
            if v > len(verses):
                raise SystemExit(f"{book_slug} {c} has no verse {v}")
            for w in hebtok.tokenize(verses[v - 1]):
                words.append(w)
                refs.append((c, v))
    return doc, words, refs


def parse_ref(s):
    a, b = s.split("-", 1)
    c0, v0 = (int(x) for x in a.split(":"))
    c1, v1 = (int(x) for x in b.split(":")) if ":" in b else (c0, int(b))
    return c0, v0, c1, v1


# --------------------------------------------------------------------- main
def decode(path):
    """Any CoreAudio-readable file (m4a, mp3, wav, aiff) -> 16 kHz mono."""
    os.makedirs(WORK_DIR, exist_ok=True)
    key = hashlib.sha1(os.path.abspath(path).encode()).hexdigest()[:12]
    dst = os.path.join(WORK_DIR, f"align-{key}.wav")
    stamp = dst + ".stamp"
    mtime = str(os.path.getmtime(path))
    if not os.path.exists(dst) or not os.path.exists(stamp) or open(stamp).read() != mtime:
        # CoreAudio trusts the extension, and this file may be misnamed, so hand
        # afconvert a correctly-suffixed copy of whatever it actually is.
        head = open(path, "rb").read(12)
        ext = ".m4a" if head[4:8] == b"ftyp" else os.path.splitext(path)[1] or ".mp3"
        tmp = os.path.join(WORK_DIR, f"align-{key}-src{ext}")
        with open(tmp, "wb") as f:
            f.write(open(path, "rb").read())
        subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{SR}", tmp, dst], check=True)
        open(stamp, "w").write(mtime)
    return dst


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audio", required=True, help="the recording (m4a, mp3, wav, aiff)")
    ap.add_argument("--book", required=True, help="corpus slug, e.g. i-samuel")
    ap.add_argument("--range", required=True, dest="ref", help="e.g. 28:8-28:19")
    ap.add_argument("--id", required=True, help="local source id (data/local_sources/<id>/)")
    ap.add_argument("--out", required=True, help="onset file name within that directory")
    ap.add_argument("--voice", default="Carmit", help="macOS Hebrew voice for the reference")
    ap.add_argument("--dwell", type=float, default=DWELL)
    ap.add_argument("--gamma-pct", type=float, default=GAMMA_PCT)
    args = ap.parse_args()

    if not have_voice(args.voice):
        raise SystemExit(f"macOS voice {args.voice!r} is not installed "
                         "(System Settings > Accessibility > Spoken Content > System Voice > Manage)")

    c0, v0, c1, v1 = parse_ref(args.ref)
    doc, words, refs = load_passage(args.book, c0, v0, c1, v1)
    book_en = doc["book"]["en"] if isinstance(doc.get("book"), dict) else args.book
    print(f"{book_en} {c0}:{v0}-{c1}:{v1} — {len(words)} words")

    rec = ep.read_wav_mono(decode(args.audio))
    print(f"  recording {len(rec) / SR:.1f}s")
    ref_sig, bounds = synth(words, args.voice)
    print(f"  reference {len(ref_sig) / SR:.1f}s ({args.voice})")

    A, B = mfcc(ref_sig), mfcc(rec)
    with np.errstate(all="ignore"):
        sample = 1.0 - A[::37] @ B[::37].T
    gamma = float(np.percentile(sample, args.gamma_pct))
    print(f"  warping {A.shape[0]}x{B.shape[0]} frames (gamma {gamma:.3f}, dwell {args.dwell})")
    path = warp_path(A, B, gamma, args.dwell)

    fps = 1000 / HOP_MS
    first, cells = {}, {}
    for i, j in path:
        if 1 <= i <= A.shape[0]:
            first.setdefault(i - 1, j)
            cells.setdefault(i - 1, []).append(j)
    last_ref = A.shape[0] - 1

    def frame_of(sample_idx):
        return min(int(sample_idx / SR * fps), last_ref)

    onsets, costs = [], []
    for (s, e) in bounds:
        f = frame_of(s)
        onsets.append(round(first.get(f, 0) / fps, 3))
        fs, fe = frame_of(s), max(frame_of(s) + 1, frame_of(e))
        with np.errstate(all="ignore"):
            c = [1.0 - float(A[f2] @ B[j]) for f2 in range(fs, min(fe, last_ref + 1))
                 for j in cells.get(f2, [])]
        costs.append(round(float(np.mean(c)), 3) if c else None)
    # One extra marker: where the last word stops. build_reading.py reads it as
    # the final verse's end, so an outro after the chanting is not played.
    tail = [j for i, j in path if i == A.shape[0]]
    onsets.append(round((tail[0] if tail else B.shape[0]) / fps, 3))

    out_dir = os.path.join(LOCAL_LABELS_DIR, args.id)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, args.out)
    with open(out_path, "w") as f:
        f.write(",".join(f"{t:.3f}" for t in onsets) + "\n")

    review = {
        "audio": os.path.relpath(os.path.abspath(args.audio), HERE),
        "book": args.book,
        "range": args.ref,
        "label": f"{book_en} {c0}:{v0}\u2013{c1}:{v1}" if c0 != c1 else f"{book_en} {c0}:{v0}\u2013{v1}",
        "labels": os.path.relpath(out_path, HERE),
        "words": [{"w": w, "ref": f"{c}:{v}", "t": t, "cost": q}
                  for w, (c, v), t, q in zip(words, refs, onsets, costs)],
        "end": onsets[-1],
    }
    review_path = out_path + ".review.json"
    json.dump(review, open(review_path, "w"), ensure_ascii=False, indent=1)

    # Report. Per-verse mean cost is the honest confidence signal: on this
    # corpus a verse that is really there lands near 0.5, and one that is not
    # (text the recording never chants) sits far above it.
    print(f"\n  chanting starts {onsets[0]:.2f}s, ends {onsets[-1]:.2f}s")
    gaps = np.diff(onsets[:-1])
    print(f"  word pace: median {np.median(gaps):.2f}s  p10 {np.percentile(gaps, 10):.2f}  "
          f"p90 {np.percentile(gaps, 90):.2f}  max {gaps.max():.2f}")
    print("\n  ref    words        span          pace   confidence")
    by_verse = {}
    for k, (c, v) in enumerate(refs):
        by_verse.setdefault((c, v), []).append(k)
    flagged = []
    for (c, v), ix in by_verse.items():
        end = onsets[ix[-1] + 1]
        mean_cost = float(np.mean([costs[k] for k in ix if costs[k] is not None]))
        pace = (end - onsets[ix[0]]) / len(ix)
        mark = "  <-- check" if mean_cost > 0.7 else ""
        if mark:
            flagged.append(f"{c}:{v}")
        print(f"  {c}:{v:<3} {len(ix):3d}   {onsets[ix[0]]:7.2f}-{end:7.2f}  "
              f"{pace:5.2f}s/w   {mean_cost:.3f}{mark}")
    print(f"\nwrote {os.path.relpath(out_path, HERE)} ({len(onsets)} marks)")
    print(f"      {os.path.relpath(review_path, HERE)}")
    if flagged:
        print(f"\nlow confidence: {', '.join(flagged)} — listen to those in scripts/label.html")


if __name__ == "__main__":
    main()
