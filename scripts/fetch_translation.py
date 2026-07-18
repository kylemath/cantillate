#!/usr/bin/env python3
"""Fetch an English translation for a chapter and merge it into an existing
Cantillate data file as a per-verse `en` field (the Hebrew `text` is untouched).

Prefers translations that keep Hebrew proper names (e.g. Kaplan's "The Living
Torah": Moshe, Yisrael...), in the spirit of the Koren Jerusalem edition; falls
back to Sefaria's default English if those aren't available.

Usage (inside the venv):
    .venv/bin/python scripts/fetch_translation.py Deuteronomy 1 --file data/devarim1.json
"""
import argparse
import html
import json
import re
import sys
import urllib.parse
import urllib.request

BASE = "https://www.sefaria.org/api/texts/{book}.{chapter}?context=0&commentary=0"
# Versions that render Hebrew personal/place names, most-preferred first.
PREFERRED = [
    "The Koren Jerusalem Bible",
    "Metsudah Chumash, Metsudah Publications, 2009",
    "The Living Torah",
]

TAG_RE = re.compile(r"<[^>]+>")
FOOTNOTE_RE = re.compile(r"<i[^>]*class=\"footnote\"[^>]*>.*?</i>", re.S)


def clean(s):
    if not s:
        return ""
    s = FOOTNOTE_RE.sub("", s)
    s = TAG_RE.sub("", s)
    return html.unescape(s).strip()


def fetch(book, chapter, ven=None):
    url = BASE.format(book=book, chapter=chapter)
    if ven:
        url += "&ven=" + urllib.parse.quote(ven.replace(" ", "_"))
    req = urllib.request.Request(url, headers={"User-Agent": "cantillate-mvp/0.1"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def get_english(book, chapter):
    for ven in PREFERRED:
        try:
            data = fetch(book, chapter, ven)
            txt = data.get("text")
            if txt and any(t for t in txt):
                return txt, data.get("versionTitle") or ven
        except Exception as e:  # noqa: BLE001
            print(f"  ({ven} unavailable: {e})", file=sys.stderr)
    # Fallback: default English version.
    data = fetch(book, chapter)
    return data.get("text") or [], data.get("versionTitle") or "English"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("book")
    ap.add_argument("chapter", type=int)
    ap.add_argument("--file", required=True)
    args = ap.parse_args()

    with open(args.file, encoding="utf-8") as f:
        doc = json.load(f)

    en, ver = get_english(args.book, args.chapter)
    if not en:
        print("No English text returned", file=sys.stderr)
        sys.exit(1)

    n = 0
    for i, v in enumerate(doc["verses"]):
        v["en"] = clean(en[i]) if i < len(en) else ""
        if v["en"]:
            n += 1
    doc["enVersionTitle"] = ver

    with open(args.file, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    print(f"Merged English for {n} verses from '{ver}' into {args.file}")


if __name__ == "__main__":
    main()
