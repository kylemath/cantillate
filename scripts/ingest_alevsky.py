#!/usr/bin/env python3
"""Add Chayim B. Alevsky (Chabad trop trainer) as a local voice.

The Chabad.org trainer at
https://www.chabad.org/library/howto/trainer_cdo/aid/1771208
ships word-aligned MP3s. They are copyrighted, with no redistribution license,
so they are never bundled: this script copies them onto *this machine* for
private study, converts the trainer's cue points into the app's onset tracks,
and builds the local `alevsky` audio source.

    .venv/bin/python scripts/ingest_alevsky.py bereshit

Cue points in the trainer are one per *display unit*. Maqaf-joined phrases
(עַל־פְּנֵי) are one unit there and two Masoretic words here; we expand them
with `hebtok.tokenize` so the onsets line up 1:1 with PocketTorah's WLC counts.

The trainer JSON snapshot (`data/local_sources/alevsky/<slug>.trainer.json`)
is the words + cues captured from the live widget. Re-export it from the page
if you add another parashah.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_reading as br                            # noqa: E402
import hebtok                                         # noqa: E402
import onsettrack                                     # noqa: E402
import split_pitch                                    # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
AUDIO = os.path.join(HERE, "audio", "alevsky")
LABELS = os.path.join(DATA, "local_sources", "alevsky")
TRAINER_PAGE = (
    "https://www.chabad.org/library/howto/trainer_cdo/aid/1771208/"
    "jewish/Learn-to-Read-Torah-and-Haftarah-With-Trop-Audio.htm"
)
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")


def trainer_path(slug):
    return os.path.join(LABELS, f"{slug}.trainer.json")


def duration_of(path):
    out = subprocess.run(["afinfo", path], capture_output=True, text=True)
    m = re.search(r"estimated duration:\s*([0-9.]+)", out.stdout)
    if not m:
        raise SystemExit(f"afinfo did not report duration for {path}")
    return float(m.group(1))


def expand_onsets(cues, words, end):
    """One Chabad cue per display unit -> one onset per Masoretic word.

    A maqaf-joined unit is stretched evenly across the time until the next cue.
    A final mark is the end of the last word (the recording's duration).
    """
    if len(cues) != len(words):
        raise SystemExit(f"cues {len(cues)} != words {len(words)}")
    onsets = []
    for i, word in enumerate(words):
        n = max(1, len(hebtok.tokenize(word)))
        t0 = float(cues[i])
        t1 = float(cues[i + 1]) if i + 1 < len(cues) else float(end)
        if n == 1 or t1 <= t0:
            onsets.append(t0)
            continue
        dt = (t1 - t0) / n
        for k in range(n):
            onsets.append(t0 + k * dt)
    onsets.append(float(end))
    return [round(t, 3) for t in onsets]


def download(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        print(f"  skip {os.path.basename(dest)}")
        return
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "*/*", "Referer": TRAINER_PAGE,
    })
    print(f"  get  {url}")
    with urllib.request.urlopen(req, timeout=180) as r:
        body = r.read()
    if len(body) < 1000:
        raise SystemExit(f"short download {url}: {len(body)} bytes")
    with open(dest, "wb") as f:
        f.write(body)
    print(f"  wrote {os.path.relpath(dest, HERE)} ({len(body)} bytes)")


def ingest(slug):
    cfg = dict(br.REGISTRY[slug], slug=slug)
    src = next((s for s in br.reading_sources(cfg) if s.get("id") == "alevsky"), None)
    if src is None:
        raise SystemExit(f"{slug} has no alevsky source in scripts/readings.py")

    snap_path = trainer_path(slug)
    if not os.path.exists(snap_path):
        raise SystemExit(
            f"missing trainer snapshot {snap_path}\n"
            "Open the Chabad trainer, load each aliya of this parashah, and "
            "export prayer_trainer.data (words + CuePoints + FilePath) to that file."
        )
    snap = json.load(open(snap_path, encoding="utf-8"))
    aliyot = [a for a in snap["aliyot"] if "Portion" in a["title"]]
    files = list(src["pt_files"])
    if len(aliyot) != len(files):
        raise SystemExit(f"snapshot has {len(aliyot)} aliyot, source expects {len(files)}")

    os.makedirs(AUDIO, exist_ok=True)
    os.makedirs(LABELS, exist_ok=True)
    print(f"== ingest alevsky / {slug} ==")
    print("[1/3] audio")
    for i, aliya in zip(files, aliyot):
        dest = br.mp3_disk(src, i)
        download(aliya["filePath"].replace("://media.chabad.org//", "://media.chabad.org/"), dest)

    print("[2/3] onset tracks")
    text = json.load(open(os.path.join(DATA, f"{slug}.json"), encoding="utf-8"))
    verses = text["verses"]
    expected = [len(hebtok.tokenize(v["text"])) for v in verses]
    annual = text["aliyot"]["annual"]
    cursor = 0
    for i, aliya in zip(files, aliyot):
        dest = br.mp3_disk(src, i)
        end = duration_of(dest)
        onsets = expand_onsets(aliya["cues"], aliya["words"], end)
        n_words = len(onsets) - 1
        a_start, a_end = annual[files.index(i)]["start"], annual[files.index(i)]["end"]
        want = sum(expected[n - 1] for n in range(a_start, a_end + 1))
        if n_words != want:
            raise SystemExit(
                f"aliya {i}: expanded {n_words} words, reading wants {want} "
                f"({a_start}–{a_end})"
            )
        cursor += n_words
        track = onsettrack.dump(onsets)
        bad = onsettrack.check(*onsettrack.parse(track))
        if bad:
            raise SystemExit(f"aliya {i}: {bad}")
        out = os.path.join(LABELS, br.pt_name(src, "pt_label", i))
        with open(out, "w") as f:
            f.write(track)
        print(f"  aliya {i}: {n_words} words, {end:.1f}s -> {os.path.relpath(out, HERE)}")
    if cursor != sum(expected):
        raise SystemExit(f"total {cursor} != reading {sum(expected)}")

    print("[3/3] build alevsky source")
    bounds, cum = [], 0
    for n in expected:
        bounds.append((cum, cum + n))
        cum += n
    audio_verses = br.build_audio(cfg, src, verses, bounds)
    br.extract_pitch(cfg, src, verses, audio_verses)
    split_pitch.process_slug(br.out_name(cfg, src, "pitch.json")[:-len("_pitch.json")])

    ready = []
    for s in br.reading_sources(cfg):
        if s.get("kind") == "local" and not br.local_source_ready(s):
            print(f"  skip missing local source '{s.get('id')}'")
            continue
        ready.append(s)
    br.register(cfg, ready)
    print(f"done: {slug} now offers {', '.join(s['id'] for s in ready)}. "
          "Reload the app and pick Voice → Chayim B. Alevsky.")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in br.REGISTRY:
        print("usage: ingest_alevsky.py <slug>\nknown: " + ", ".join(br.REGISTRY),
              file=sys.stderr)
        sys.exit(1)
    ingest(sys.argv[1])


if __name__ == "__main__":
    main()
