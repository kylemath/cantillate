#!/usr/bin/env python3
"""Write data/trope-index.json — every recorded verse as a sequence of accents.

The trope drills have no recording of their own: nobody has ever chanted "shalom"
with a pazer on it. But the *tune* belongs to the accent, not the word, and the
bundled readings contain thousands of recorded, word-aligned instances of those
same accents. This index lets the app search that corpus for the drill's accent
sequence and splice a real recitation of it out of the cantor's voice.

Per verse it stores only what a splice needs: the mp3, the word onsets, and the
accent on each word. The app (findRecitation in js/app.js) then greedily matches
the longest runs it can, so the seams fall between phrases rather than every word.

Run automatically at the end of build_reading.py, or by hand:

    python3 scripts/build_trope_index.py
"""
import json
import os
import re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(DATA, "trope-index.json")

MAQAF, PASEQ = "\u05be", "\u05c0"
# The accents that define a word's melody, in the order primaryTaam prefers them
# (js/hebrew.js): a disjunctive if the word carries one, else its first mark.
DISJUNCTIVE = {0x0591, 0x0592, 0x0593, 0x0594, 0x0595, 0x0596, 0x0597, 0x0598,
               0x0599, 0x059A, 0x059B, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0,
               0x05A1, 0x05AD, 0x05AE}

SOF = 0      # the verse's last word, whatever it carries (matches buildLineMelody)
NONE = -1    # no cantillation mark at all


def tokenize(text):
    """Replica of tokenize() in js/hebrew.js, so word indices line up with the app."""
    text = re.sub(r"<[^>]*>|&[#a-zA-Z0-9]+;", "", text)
    text = re.sub(r"\{[^}]*\}", " ", text)
    out = []
    for w in text.split():
        cur = ""
        for s in re.split(r"([\u05be\u05c0])", w):
            if s == "":
                continue
            if s in (MAQAF, PASEQ):
                if cur:
                    out.append(cur + s)
                    cur = ""
            else:
                if cur:
                    out.append(cur)
                cur = s
        if cur:
            out.append(cur)
    return out


def primary_taam(token):
    marks = [ord(c) for c in token if 0x0591 <= ord(c) <= 0x05AE]
    if not marks:
        return NONE
    for cp in marks:
        if cp in DISJUNCTIVE:
            return cp
    return marks[0]


def build():
    manifest = json.load(open(os.path.join(DATA, "readings.json"), encoding="utf-8"))
    readings, total_verses, total_words = [], 0, 0
    for entry in manifest:
        if entry.get("kind", "parashah") != "parashah":
            continue
        slug = entry["slug"]
        try:
            text = json.load(open(os.path.join(DATA, f"{slug}.json"), encoding="utf-8"))
            audio = json.load(open(os.path.join(DATA, f"{slug}_audio.json"), encoding="utf-8"))
        except FileNotFoundError:
            print(f"  skip {slug}: no text/audio on disk")
            continue
        verses = []
        for v in text["verses"]:
            av = audio.get("verses", {}).get(str(v["n"]))
            if not av or not av.get("onsets") or not av.get("file"):
                continue
            toks = tokenize(v["text"])
            onsets = av["onsets"]
            # Only index verses whose tokens line up 1:1 with the onsets — a
            # mis-split verse would splice the wrong slice of audio.
            if len(toks) != len(onsets):
                continue
            accents = [primary_taam(t) for t in toks]
            accents[-1] = SOF
            verses.append({
                "n": v["n"], "ref": v.get("ref") or str(v["n"]),
                "file": av["file"],
                "end": av.get("end"),
                "onsets": onsets,
                "a": accents,
                # The words themselves, so a spliced recitation can show what is
                # actually being sung instead of leaving the drill's words on
                # screen while a different verse plays.
                "w": toks,
            })
            total_words += len(accents)
        total_verses += len(verses)
        readings.append({"slug": slug, "label": entry.get("label", slug),
                         "book": (text.get("book") or {}).get("en", ""),
                         "verses": verses})

    doc = {
        "note": "Recorded verses as accent sequences, for splicing a real recitation "
                "of an arbitrary trope sequence. Built by scripts/build_trope_index.py.",
        "sof": SOF, "none": NONE,
        "readings": readings,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(OUT) / 1024
    print(f"  wrote data/trope-index.json: {len(readings)} readings, "
          f"{total_verses} verses, {total_words} recorded words ({size:.0f} KB)")


if __name__ == "__main__":
    build()
