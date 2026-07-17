#!/usr/bin/env python3
"""Fetch open-source Hebrew Tanakh text (with vowels + cantillation) and store
it locally as JSON for the Cantillate app.

Source: Sefaria API, version "Miqra according to the Masorah" (MAM), a digital
edition of the Masoretic (Leningrad Codex) text. The underlying consonantal +
vocalized + accented text is in the public domain (Leningrad Codex);
the MAM digital edition is distributed by Sefaria under CC-BY.

Usage:
    python3 scripts/fetch_text.py Deuteronomy 1 --out data/devarim1.json --slug devarim1
"""
import argparse
import json
import os
import sys
import urllib.request

API = "https://www.sefaria.org/api/texts/{book}.{chapter}?context=0&commentary=0"

# English book name -> nice display metadata
BOOK_META = {
    "Deuteronomy": {"en": "Deuteronomy", "he": "\u05d3\u05d1\u05e8\u05d9\u05dd", "translit": "Devarim"},
    "Genesis": {"en": "Genesis", "he": "\u05d1\u05e8\u05d0\u05e9\u05d9\u05ea", "translit": "Bereshit"},
    "Exodus": {"en": "Exodus", "he": "\u05e9\u05de\u05d5\u05ea", "translit": "Shemot"},
    "Leviticus": {"en": "Leviticus", "he": "\u05d5\u05d9\u05e7\u05e8\u05d0", "translit": "Vayikra"},
    "Numbers": {"en": "Numbers", "he": "\u05d1\u05de\u05d3\u05d1\u05e8", "translit": "Bamidbar"},
}


def fetch(book, chapter):
    url = API.format(book=book, chapter=chapter)
    req = urllib.request.Request(url, headers={"User-Agent": "cantillate-mvp/0.1"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("book")
    ap.add_argument("chapter", type=int)
    ap.add_argument("--out", required=True)
    ap.add_argument("--slug", required=True)
    args = ap.parse_args()

    data = fetch(args.book, args.chapter)
    he = data.get("he")
    if not he:
        print("No Hebrew text returned", file=sys.stderr)
        sys.exit(1)

    meta = BOOK_META.get(args.book, {"en": args.book, "he": data.get("heTitle", ""), "translit": args.book})

    verses = []
    for i, v in enumerate(he, start=1):
        verses.append({"n": i, "text": v})

    out = {
        "slug": args.slug,
        "book": meta,
        "chapter": args.chapter,
        "ref": data.get("ref"),
        "heRef": data.get("heRef"),
        "versionTitle": data.get("versionTitle"),
        "heVersionTitle": data.get("heVersionTitle"),
        "license": "Leningrad Codex text is public domain; MAM digital edition CC-BY (Sefaria).",
        "source": "https://www.sefaria.org",
        "verses": verses,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Wrote {len(verses)} verses to {args.out}")


if __name__ == "__main__":
    main()
