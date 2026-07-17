#!/usr/bin/env python3
"""Fetch open-licensed recorded Torah chanting (PocketTorah) for Devarim ch.1
and build per-verse time ranges so the app can play a real cantor's chant of any
selected verse.

Audio + timing metadata: PocketTorah (https://pockettorah.com), released
CC-BY-SA. Word onset times come from PocketTorah's Audacity label tracks; word
counts / verse boundaries come from the Westminster Leningrad Codex JSON that
PocketTorah ships. The parashah is split across 7 audio files by word count;
Deuteronomy chapter 1 (verses 1-46) falls in files 1-4.

Usage:
    python3 scripts/fetch_audio.py
"""
import json
import os
import urllib.request

RAW = "https://raw.githubusercontent.com/rneiss/PocketTorah/master"
LABELS = RAW + "/data/torah/labels/devarim-{i}.txt"
AUDIO = RAW + "/data/audio/Devarim-{i}.mp3"
DEUT_JSON = RAW + "/data/torah/json/Deuteronomy.json"

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(HERE, "audio")
OUT = os.path.join(HERE, "data", "devarim1_audio.json")

FILES = [1, 2, 3, 4]  # cover Deut 1:1 .. 2:1 (all of chapter 1)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cantillate-mvp/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main():
    os.makedirs(AUDIO_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    # WLC word counts per verse (maqaf-joined words counted separately, matching
    # the label tracks).
    de = json.loads(get(DEUT_JSON).decode("utf-8-sig"))
    chapters = de["Tanach"]["tanach"]["book"]["c"]
    ch1 = chapters[0]["v"]
    wc = [len(v["w"]) for v in ch1]  # words per verse, 46 entries

    # Global word index range per verse across the whole parashah start (1:1).
    bounds = []
    cum = 0
    for n in wc:
        bounds.append((cum, cum + n))  # [start, end)
        cum += n

    # Download label tracks + audio, and learn each file's global word offset.
    labels = {}
    file_word_offset = {}
    offset = 0
    for i in FILES:
        raw = get(LABELS.format(i=i)).decode("utf-8-sig").strip()
        onsets = [float(x) for x in raw.split(",") if x.strip()]
        labels[i] = onsets
        file_word_offset[i] = offset
        offset += len(onsets)

        dest = os.path.join(AUDIO_DIR, f"devarim-{i}.mp3")
        if not os.path.exists(dest):
            print(f"downloading Devarim-{i}.mp3 ...")
            data = get(AUDIO.format(i=i))
            with open(dest, "wb") as f:
                f.write(data)
            print(f"  saved {len(data)//1024} KB")
        else:
            print(f"Devarim-{i}.mp3 already present")

    # File ranges in global word indices.
    file_range = {}
    acc = 0
    for i in FILES:
        n = len(labels[i])
        file_range[i] = (acc, acc + n)
        acc += n

    def file_for_word(gw):
        for i in FILES:
            s, e = file_range[i]
            if s <= gw < e:
                return i
        return None

    verses = {}
    for vi in range(1, 47):  # verses 1..46
        gs, ge = bounds[vi - 1]
        fi = file_for_word(gs)
        if fi is None:
            continue
        foff = file_word_offset[fi]
        local_s = gs - foff
        onsets = labels[fi]
        # verse word onsets (absolute seconds within the file)
        vend_local = ge - foff
        word_onsets = onsets[local_s:vend_local]
        start = onsets[local_s]
        # verse end = onset of first word of next verse if in the same file
        end = onsets[vend_local] if vend_local < len(onsets) else None
        verses[str(vi)] = {
            "file": f"audio/devarim-{fi}.mp3",
            "start": round(start, 3),
            "end": round(end, 3) if end is not None else None,
            "onsets": [round(x, 3) for x in word_onsets],
        }

    out = {
        "slug": "devarim1",
        "source": "https://pockettorah.com",
        "license": "PocketTorah audio & timing metadata, CC-BY-SA. Text alignment via Westminster Leningrad Codex.",
        "attribution": "Recorded chanting courtesy of PocketTorah (Neiss & Schwartz), CC-BY-SA.",
        "verses": verses,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Wrote {len(verses)} verse audio ranges to {OUT}")


if __name__ == "__main__":
    main()
