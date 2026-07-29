#!/usr/bin/env python3
"""Build the browsable text of the Tanakh, so the app can open ANY passage.

The shipped readings (data/<slug>.json) are the ones with a recording: a
parashah, a haftarah, a named excerpt. This builds the other half of the promise
— "any pesukim of any book" — as one small file per book that the app fetches
only when the reader picks that book:

    data/tanakh/index.json      every book: names, chapter lengths, parashiyot
    data/tanakh/<slug>.json     the Hebrew (MAM, with te'amim), by chapter
    data/tanakh/<slug>.en.json  the English (Koren), by chapter

Verse numbers are not stored: a chapter is a plain array, so verse v of chapter
c is chapters[c-1][v-1] and the index's per-chapter counts are enough to build
any reference. That keeps a book to a few hundred KB instead of a few MB.

A custom range has no recording, so the app teaches it from the measured
haftarah shapes (data/haftarah-shapes.json) — which is also why the three poetic
books are flagged: their te'amim are a different system with no shared melody.

Usage (inside the venv):
    .venv/bin/python scripts/build_tanakh.py --all
    .venv/bin/python scripts/build_tanakh.py Isaiah Jonah
    .venv/bin/python scripts/build_tanakh.py --section neviim
    .venv/bin/python scripts/build_tanakh.py --missing        # only unbuilt books
    .venv/bin/python scripts/build_tanakh.py --index-only     # re-stitch the index

Already-built books are skipped unless --force. The index is rebuilt from
whatever is on disk every run, so an interrupted build leaves a consistent app.

Sources: Sefaria API (Miqra according to the Masorah + The Koren Jerusalem
Bible) and Hebcal's leyning table for the parashah boundaries.
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_translation as ftr           # noqa: E402  (clean)
import tanakh                             # noqa: E402
from aliyot_build import _load_table, ANNUAL_URL, HEBCAL_ATTRIBUTION  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(HERE, "data", "tanakh")
INDEX = os.path.join(OUT_DIR, "index.json")

SEFARIA = "https://www.sefaria.org/api/texts/{book}.{ch}?context=0&commentary=0"
SEFARIA_INDEX = "https://www.sefaria.org/api/index/{book}"
# Both texts come back in one request, so a book costs one call per chapter.
EN_VERSION = "The Koren Jerusalem Bible"
HE_LICENSE = ("Leningrad Codex text is public domain; MAM digital edition "
              "CC-BY (Sefaria).")
SOURCE_URL = "https://www.sefaria.org"
PAUSE = 0.15  # be a good citizen with ~930 chapters to fetch


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cantillate-mvp/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def chapter_count(name):
    """How many chapters a book has, per Sefaria's index."""
    doc = get(SEFARIA_INDEX.format(book=urllib.parse.quote(name)))
    lengths = (doc.get("schema") or {}).get("lengths") or doc.get("lengths") or []
    if not lengths:
        raise SystemExit(f"{name}: Sefaria index has no chapter count")
    return lengths[0]


def fetch_chapter(name, ch):
    """(hebrew verses, english verses, he version, en version) for one chapter."""
    url = SEFARIA.format(book=urllib.parse.quote(name), ch=ch)
    doc = get(url + "&ven=" + urllib.parse.quote(EN_VERSION.replace(" ", "_")))
    he = doc.get("he") or []
    en = doc.get("text") or []
    en_ver = doc.get("versionTitle") or EN_VERSION
    if not any(en):
        # Not every book has the preferred translation; take Sefaria's default
        # rather than shipping a book with an empty English column.
        alt = get(url)
        en = alt.get("text") or []
        en_ver = alt.get("versionTitle") or "English"
        he = he or alt.get("he") or []
    return he, [ftr.clean(t) for t in en], doc.get("heVersionTitle") or "Miqra according to the Masorah", en_ver


# ---- parashiyot (Torah books only) ----------------------------------------
# The picker offers "book, then parashah, then pesukim" for the Torah, because
# that is how a Torah passage is cited. Hebcal's full-kriyah table gives the
# boundaries: a parashah runs from the start of aliyah 1 to the end of aliyah 7.

def _parse_ref(s):
    c, v = s.split(":")
    return int(c), int(v)


def parashiyot_by_book():
    """{book number 1..5: [ {en, he, num, start:[c,v], end:[c,v]} ]}"""
    table = _load_table(ANNUAL_URL, "aliyot.json") or {}
    out = {}
    for name, entry in table.items():
        fk = entry.get("fullkriyah") or {}
        bk = entry.get("book")
        # Hebcal also lists the combined readings (Vayakhel-Pekudei), which are a
        # calendar accident rather than a separate passage; the table of 54 in
        # tanakh.py is exactly the list the picker should offer.
        if not fk or not isinstance(bk, int) or name not in tanakh.HE_PARASHAH:
            continue
        keys = [k for k in ("1", "2", "3", "4", "5", "6", "7") if fk.get(k)]
        if not keys:
            continue
        start = _parse_ref(fk[keys[0]][0])
        end = _parse_ref(fk[keys[-1]][1])
        out.setdefault(bk, []).append({
            "en": name, "he": tanakh.he_parashah(name), "num": entry.get("num"),
            "start": list(start), "end": list(end),
        })
    for bk in out:
        out[bk].sort(key=lambda p: (p["num"] is None, p["num"], p["start"]))
    return out


# ---- per-book build --------------------------------------------------------

def book_paths(name):
    slug = tanakh.slug_of(name)
    return (slug,
            os.path.join(OUT_DIR, f"{slug}.json"),
            os.path.join(OUT_DIR, f"{slug}.en.json"))


def build_book(name, force=False, parashiyot=None):
    """Fetch and write one book. Returns its index entry."""
    b = tanakh.book(name)
    slug, he_path, en_path = book_paths(name)
    if os.path.exists(he_path) and not force:
        print(f"{name}: already built, skipping (use --force to refetch)")
        return index_entry(name)

    n_ch = chapter_count(b["en"])
    he_chapters, en_chapters = [], []
    he_ver = en_ver = None
    for ch in range(1, n_ch + 1):
        he, en, hv, ev = fetch_chapter(b["en"], ch)
        he_chapters.append(he)
        en_chapters.append(en)
        he_ver, en_ver = hv, ev
        print(f"  {b['en']} {ch}/{n_ch}: {len(he)} pesukim", end="\r", flush=True)
        time.sleep(PAUSE)
    verses = sum(len(c) for c in he_chapters)
    print(f"  {b['en']}: {n_ch} chapters, {verses} pesukim" + " " * 20)

    doc = {
        "slug": slug,
        "book": {"en": b["en"], "he": b["he"], "translit": b["translit"]},
        "section": b["section"],
        "sectionLabel": tanakh.SECTION_LABELS[b["section"]],
        "accents": b["accents"],
        "versionTitle": he_ver,
        "heVersionTitle": he_ver,
        "enVersionTitle": en_ver,
        "license": HE_LICENSE,
        "source": SOURCE_URL,
        "chapters": he_chapters,
    }
    if parashiyot:
        doc["parashiyot"] = parashiyot
    os.makedirs(OUT_DIR, exist_ok=True)
    write(he_path, doc)
    write(en_path, {"slug": slug, "enVersionTitle": en_ver,
                    "source": SOURCE_URL, "chapters": en_chapters})
    return index_entry(name)


def write(path, doc):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  wrote {os.path.relpath(path, HERE)} ({os.path.getsize(path) / 1024:.0f} KB)")


def index_entry(name):
    """The index row for an already-built book, or None if it isn't built."""
    slug, he_path, en_path = book_paths(name)
    if not os.path.exists(he_path):
        return None
    with open(he_path, encoding="utf-8") as f:
        doc = json.load(f)
    b = tanakh.book(name)
    entry = {
        "slug": slug,
        "en": b["en"],
        "he": b["he"],
        "translit": b["translit"],
        "section": b["section"],
        "sectionLabel": tanakh.SECTION_LABELS[b["section"]],
        "accents": b["accents"],
        "order": b["order"],
        "file": f"data/tanakh/{slug}.json",
        "chapters": [len(c) for c in doc["chapters"]],
        "verses": sum(len(c) for c in doc["chapters"]),
    }
    if os.path.exists(en_path):
        entry["enFile"] = f"data/tanakh/{slug}.en.json"
    if doc.get("parashiyot"):
        entry["parashiyot"] = doc["parashiyot"]
    return entry


def build_index():
    """Re-stitch data/tanakh/index.json from whatever books are on disk."""
    books = [e for e in (index_entry(n) for n in tanakh.ORDER) if e]
    doc = {
        "note": ("Every book of the Tanakh the app can open a custom passage from. "
                 "`chapters` gives each chapter's verse count, so a reference can be "
                 "built without loading the book. Text: Sefaria (MAM + Koren). "
                 "Parashah boundaries: Hebcal."),
        "attribution": HEBCAL_ATTRIBUTION,
        "license": HE_LICENSE,
        "source": SOURCE_URL,
        "sections": [{"id": s, "label": tanakh.SECTION_LABELS[s]}
                     for s in (tanakh.TORAH, tanakh.NEVIIM, tanakh.KETUVIM)],
        "books": books,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    write(INDEX, doc)
    have = sum(1 for b in books)
    verses = sum(b["verses"] for b in books)
    print(f"index: {have}/{len(tanakh.ORDER)} books, {verses} pesukim browsable")
    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("books", nargs="*", help="Sefaria book names (default: --missing)")
    ap.add_argument("--all", action="store_true", help="every book of the Tanakh")
    ap.add_argument("--section", choices=[tanakh.TORAH, tanakh.NEVIIM, tanakh.KETUVIM],
                    help="every book of one section")
    ap.add_argument("--missing", action="store_true", help="only books not yet built")
    ap.add_argument("--index-only", action="store_true", help="just rebuild the index")
    ap.add_argument("--force", action="store_true", help="refetch books already built")
    args = ap.parse_args()

    if args.index_only:
        build_index()
        return

    names = [tanakh.book(n)["en"] for n in args.books]
    if args.all:
        names = list(tanakh.ORDER)
    elif args.section:
        names = [n for n in tanakh.ORDER if tanakh.BOOKS[n]["section"] == args.section]
    if not names or args.missing:
        pool = names or list(tanakh.ORDER)
        names = [n for n in pool if not os.path.exists(book_paths(n)[1])]
    if not names:
        print("nothing to build; every requested book is already on disk")
        build_index()
        return

    par = parashiyot_by_book()
    torah_num = {n: i + 1 for i, n in enumerate(tanakh.ORDER[:5])}
    print(f"building {len(names)} book(s): {', '.join(names)}")
    for name in names:
        print(f"{name}:")
        build_book(name, force=args.force, parashiyot=par.get(torah_num.get(name)))
    build_index()


if __name__ == "__main__":
    main()
