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


def reading_covers(entry):
    """Which pesukim a reading actually contains: {book, from, to}.

    Stamped into the manifest so the app can answer "is there a recording of these
    words?" without fetching thirty data files. That question is what stands between
    a reader who picks an arbitrary passage and the cantor: a range that falls inside
    a recorded reading can be chanted along with a human voice, and one that doesn't
    has to be taught from the measured trope shapes — and the app should say which
    before the reader commits to it, not after.

    An excerpt covers its `range` within the base file rather than the whole of it,
    which is the difference between the Shema and all of Va'etchanan.
    """
    path = os.path.join(HERE, entry.get("file", ""))
    try:
        doc = json.load(open(path, encoding="utf-8"))
    except (FileNotFoundError, ValueError, TypeError):
        return None
    verses = doc.get("verses") or []
    if not verses:
        return None
    rng = entry.get("range")
    if isinstance(rng, list) and len(rng) == 2:
        lo, hi = max(1, rng[0]), min(len(verses), rng[1])
        if lo > hi:
            return None
        verses = verses[lo - 1:hi]
    book = (doc.get("book") or {}).get("en")
    chapter = doc.get("chapter")

    def ref_of(v):
        c = v.get("c") if v.get("c") is not None else chapter
        # A single-chapter reading numbers its pesukim only by position in the
        # reading, which in that one case IS the verse number.
        n = v.get("v")
        if n is None and chapter is not None:
            n = v.get("n")
        if c is None or n is None:
            return None
        return [c, n]

    first, last = ref_of(verses[0]), ref_of(verses[-1])
    if not book or not first or not last:
        return None
    return {"book": book, "from": first, "to": last}


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

    # Every entry says which pesukim it covers, drills included where they have any
    # (a drill's invented words have none, and keep the key off).
    for m in manifest:
        covers = reading_covers(m)
        if covers:
            m["covers"] = covers
        else:
            m.pop("covers", None)

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
