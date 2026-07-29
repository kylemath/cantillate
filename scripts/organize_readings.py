#!/usr/bin/env python3
"""Group data/readings.json by sefer and order it like a chumash.

The Reading menu started as one flat list, which was fine for three parashiyot
and unusable once the whole of Deuteronomy plus a few readings from Genesis and
Numbers were in it. This puts each parashah under its own sefer, in the order the
book runs, and leaves the non-scripture groups (trope drills, prayer excerpts)
after them in the order they were written.

The haftarot get one group of their own rather than being filed under the book of
Nevi'im they come from: a reader looks for the haftarah by the week it is chanted,
not by whether it happens to be in Isaiah or in Judges. So they are ordered by
their parashah's place in the year, which is the order they will be needed in.

Each reading's sefer and starting verse are read from its own data file rather
than the build registry, so a reading built by any route still lands in the right
place. Run automatically at the end of build_reading.py, or by hand:

    python3 scripts/organize_readings.py
"""
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
MANIFEST = os.path.join(DATA, "readings.json")

BOOK_ORDER = ["Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy"]
# Fallback transliterations, for a data file that doesn't carry one.
TRANSLIT = {"Genesis": "Bereshit", "Exodus": "Shemot", "Leviticus": "Vayikra",
            "Numbers": "Bamidbar", "Deuteronomy": "Devarim"}

HAFTARAH_GROUP = "Haftarot"


def reading_place(entry):
    """(book english, first chapter, first verse) for a parashah entry."""
    path = os.path.join(HERE, entry["file"])
    try:
        doc = json.load(open(path, encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return ("", 0, 0, None)
    book = (doc.get("book") or {})
    verses = doc.get("verses") or []
    first = verses[0] if verses else {}
    # A single-chapter reading has no per-verse chapter, so fall back to its own
    # `chapter` field and finally to 0.
    ch = first.get("c") if first.get("c") is not None else (doc.get("chapter") or 0)
    # A single-chapter reading carries no per-verse numbering; it starts at v1.
    vs = first.get("v") if first.get("v") is not None else 1
    return (book.get("en", ""), ch or 0, vs, book)


def reading_length(entry):
    try:
        doc = json.load(open(os.path.join(HERE, entry["file"]), encoding="utf-8"))
        return len(doc.get("verses") or [])
    except (FileNotFoundError, ValueError):
        return 0


def group_label(book_en, book):
    translit = (book or {}).get("translit") or TRANSLIT.get(book_en) or book_en
    return f"{translit} \u00b7 {book_en}" if book_en and translit != book_en else (book_en or "Readings")


def haftarah_order(entry):
    """Where in the year a haftarah falls, for ordering the Haftarot group."""
    n = entry.get("calendarNumber")
    if n is None:
        n = ((entry.get("haftarah") or {}).get("calendarNumber"))
    return (n if n is not None else 999, entry["slug"])


def organize(quiet=False):
    manifest = json.load(open(MANIFEST, encoding="utf-8"))

    def kind_of(m):
        return m.get("kind", "parashah")

    parashiyot = [m for m in manifest if kind_of(m) == "parashah"]
    haftarot = [m for m in manifest if kind_of(m) == "haftarah"]
    others = [m for m in manifest if kind_of(m) not in ("parashah", "haftarah")]

    placed = []
    for m in parashiyot:
        book_en, ch, vs, book = reading_place(m)
        m["group"] = group_label(book_en, book)
        order = BOOK_ORDER.index(book_en) if book_en in BOOK_ORDER else len(BOOK_ORDER)
        # Where two readings start at the same verse (a full parashah and a
        # chapter-sized excerpt of it), the longer one comes first.
        placed.append((order, ch, vs, -reading_length(m), m["slug"], m))
    placed.sort(key=lambda x: x[:5])

    for m in haftarot:
        m["group"] = HAFTARAH_GROUP
    haftarot.sort(key=haftarah_order)

    ordered = [p[5] for p in placed] + haftarot + others
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(ordered, f, ensure_ascii=False, indent=2)

    if not quiet:
        seen = []
        for m in ordered:
            g = m.get("group", "?")
            if not seen or seen[-1][0] != g:
                seen.append((g, []))
            seen[-1][1].append(m["slug"])
        for g, slugs in seen:
            print(f"  {g}: {', '.join(slugs)}")
    return ordered


if __name__ == "__main__":
    organize()
