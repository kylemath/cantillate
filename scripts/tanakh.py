#!/usr/bin/env python3
"""The books of the Tanakh: names, order, and where each one's data comes from.

One table, three consumers:

  * scripts/haftarot.py  — the weekly haftarah is a passage in Nevi'im, so it
    needs the Sefaria name to fetch the text and the PocketTorah name to fetch
    the word counts that align the recording.
  * scripts/build_tanakh.py — builds the browsable text of every book so the app
    can open an arbitrary range (see "Any passage, any book" in the README).
  * the app, via data/tanakh/index.json, for the book picker.

Three different projects spell these books three different ways, so each entry
carries all of them:

    en        Sefaria's name, used in its API path ("I Kings", "Song of Songs")
    wlc       PocketTorah's WLC json file ("Kings_1"); None if it ships none
    he        Hebrew name, for display
    translit  transliterated Hebrew name, for display

`accents` records which of the two Masoretic accent systems a book uses. The 21
"prose" books share the system the Torah and the haftarah are chanted with; the
three poetic books (Psalms, Proverbs, Job) use a different set of te'amim
entirely, with accents (Dehi, Atnah Hafukh, Ole, Iluy, Tsinnorit) that do not
appear in the 21 and no shared melody, so neither the Torah nor the haftarah
motifs describe them. The app still displays them; it just says so.
"""

TORAH, NEVIIM, KETUVIM = "torah", "neviim", "ketuvim"
PROSE, POETIC = "prose", "poetic"

# (en, he, translit, wlc, section, accents)
_BOOKS = [
    ("Genesis", "\u05d1\u05e8\u05d0\u05e9\u05d9\u05ea", "Bereshit", "Genesis", TORAH, PROSE),
    ("Exodus", "\u05e9\u05de\u05d5\u05ea", "Shemot", "Exodus", TORAH, PROSE),
    ("Leviticus", "\u05d5\u05d9\u05e7\u05e8\u05d0", "Vayikra", "Leviticus", TORAH, PROSE),
    ("Numbers", "\u05d1\u05de\u05d3\u05d1\u05e8", "Bamidbar", "Numbers", TORAH, PROSE),
    ("Deuteronomy", "\u05d3\u05d1\u05e8\u05d9\u05dd", "Devarim", "Deuteronomy", TORAH, PROSE),

    ("Joshua", "\u05d9\u05d4\u05d5\u05e9\u05e2", "Yehoshua", "Joshua", NEVIIM, PROSE),
    ("Judges", "\u05e9\u05d5\u05e4\u05d8\u05d9\u05dd", "Shoftim", "Judges", NEVIIM, PROSE),
    ("I Samuel", "\u05e9\u05de\u05d5\u05d0\u05dc \u05d0", "Shmuel A", "Samuel_1", NEVIIM, PROSE),
    ("II Samuel", "\u05e9\u05de\u05d5\u05d0\u05dc \u05d1", "Shmuel B", "Samuel_2", NEVIIM, PROSE),
    ("I Kings", "\u05de\u05dc\u05db\u05d9\u05dd \u05d0", "Melachim A", "Kings_1", NEVIIM, PROSE),
    ("II Kings", "\u05de\u05dc\u05db\u05d9\u05dd \u05d1", "Melachim B", "Kings_2", NEVIIM, PROSE),
    ("Isaiah", "\u05d9\u05e9\u05e2\u05d9\u05d4\u05d5", "Yeshayahu", "Isaiah", NEVIIM, PROSE),
    ("Jeremiah", "\u05d9\u05e8\u05de\u05d9\u05d4\u05d5", "Yirmiyahu", "Jeremiah", NEVIIM, PROSE),
    ("Ezekiel", "\u05d9\u05d7\u05d6\u05e7\u05d0\u05dc", "Yechezkel", "Ezekiel", NEVIIM, PROSE),
    ("Hosea", "\u05d4\u05d5\u05e9\u05e2", "Hoshea", "Hosea", NEVIIM, PROSE),
    ("Joel", "\u05d9\u05d5\u05d0\u05dc", "Yoel", "Joel", NEVIIM, PROSE),
    ("Amos", "\u05e2\u05de\u05d5\u05e1", "Amos", "Amos", NEVIIM, PROSE),
    ("Obadiah", "\u05e2\u05d5\u05d1\u05d3\u05d9\u05d4", "Ovadyah", "Obadiah", NEVIIM, PROSE),
    ("Jonah", "\u05d9\u05d5\u05e0\u05d4", "Yonah", None, NEVIIM, PROSE),
    ("Micah", "\u05de\u05d9\u05db\u05d4", "Michah", "Micah", NEVIIM, PROSE),
    ("Nahum", "\u05e0\u05d7\u05d5\u05dd", "Nachum", None, NEVIIM, PROSE),
    ("Habakkuk", "\u05d7\u05d1\u05e7\u05d5\u05e7", "Chavakuk", None, NEVIIM, PROSE),
    ("Zephaniah", "\u05e6\u05e4\u05e0\u05d9\u05d4", "Tzefanyah", None, NEVIIM, PROSE),
    ("Haggai", "\u05d7\u05d2\u05d9", "Chaggai", None, NEVIIM, PROSE),
    ("Zechariah", "\u05d6\u05db\u05e8\u05d9\u05d4", "Zecharyah", "Zechariah", NEVIIM, PROSE),
    ("Malachi", "\u05de\u05dc\u05d0\u05db\u05d9", "Malachi", "Malachi", NEVIIM, PROSE),

    ("Psalms", "\u05ea\u05d4\u05dc\u05d9\u05dd", "Tehillim", None, KETUVIM, POETIC),
    ("Proverbs", "\u05de\u05e9\u05dc\u05d9", "Mishlei", None, KETUVIM, POETIC),
    ("Job", "\u05d0\u05d9\u05d5\u05d1", "Iyov", None, KETUVIM, POETIC),
    ("Song of Songs", "\u05e9\u05d9\u05e8 \u05d4\u05e9\u05d9\u05e8\u05d9\u05dd", "Shir HaShirim", None, KETUVIM, PROSE),
    ("Ruth", "\u05e8\u05d5\u05ea", "Rut", None, KETUVIM, PROSE),
    ("Lamentations", "\u05d0\u05d9\u05db\u05d4", "Eichah", None, KETUVIM, PROSE),
    ("Ecclesiastes", "\u05e7\u05d4\u05dc\u05ea", "Kohelet", None, KETUVIM, PROSE),
    ("Esther", "\u05d0\u05e1\u05ea\u05e8", "Ester", None, KETUVIM, PROSE),
    ("Daniel", "\u05d3\u05e0\u05d9\u05d0\u05dc", "Daniel", None, KETUVIM, PROSE),
    ("Ezra", "\u05e2\u05d6\u05e8\u05d0", "Ezra", None, KETUVIM, PROSE),
    ("Nehemiah", "\u05e0\u05d7\u05de\u05d9\u05d4", "Nechemyah", None, KETUVIM, PROSE),
    ("I Chronicles", "\u05d3\u05d1\u05e8\u05d9 \u05d4\u05d9\u05de\u05d9\u05dd \u05d0",
     "Divrei HaYamim A", None, KETUVIM, PROSE),
    ("II Chronicles", "\u05d3\u05d1\u05e8\u05d9 \u05d4\u05d9\u05de\u05d9\u05dd \u05d1",
     "Divrei HaYamim B", None, KETUVIM, PROSE),
]

BOOKS = {}
for _i, (_en, _he, _tr, _wlc, _sec, _acc) in enumerate(_BOOKS):
    BOOKS[_en] = {"en": _en, "he": _he, "translit": _tr, "wlc": _wlc,
                  "section": _sec, "accents": _acc, "order": _i}

ORDER = [b[0] for b in _BOOKS]
SECTION_LABELS = {TORAH: "Torah", NEVIIM: "Nevi'im \u00b7 Prophets",
                  KETUVIM: "Ketuvim \u00b7 Writings"}

# Hebcal's leyning table names a couple of books differently from Sefaria.
_HEBCAL_ALIASES = {
    "I Kings": "I Kings", "II Kings": "II Kings",
    "I Samuel": "I Samuel", "II Samuel": "II Samuel",
    "Ezekiel": "Ezekiel", "Isaiah": "Isaiah",
}


def book(name):
    """Look up a book by Sefaria name, tolerating Hebcal's spellings."""
    if name in BOOKS:
        return BOOKS[name]
    alias = _HEBCAL_ALIASES.get(name)
    if alias:
        return BOOKS[alias]
    low = {k.lower(): k for k in BOOKS}
    key = low.get((name or "").lower())
    if key:
        return BOOKS[key]
    raise KeyError(f"unknown Tanakh book: {name!r}")


def slug_of(name):
    """URL/file-safe id for a book ("I Kings" -> "i-kings")."""
    return book(name)["en"].lower().replace(" ", "-")


def sefaria_path(name):
    """The book component of a Sefaria API path (spaces become %20 upstream)."""
    return book(name)["en"]


# The 54 parashiyot in Hebrew, keyed by Hebcal's English name. Used for the
# "הפטרת ..." line (scripts/haftarot.py) and for the parashah picker's Hebrew
# labels in the Torah books (scripts/build_tanakh.py).
HE_PARASHAH = {
    "Bereshit": "\u05d1\u05e8\u05d0\u05e9\u05d9\u05ea",
    "Noach": "\u05e0\u05d7",
    "Lech-Lecha": "\u05dc\u05da \u05dc\u05da",
    "Vayera": "\u05d5\u05d9\u05e8\u05d0",
    "Chayei Sara": "\u05d7\u05d9\u05d9 \u05e9\u05e8\u05d4",
    "Toldot": "\u05ea\u05d5\u05dc\u05d3\u05d5\u05ea",
    "Vayetzei": "\u05d5\u05d9\u05e6\u05d0",
    "Vayishlach": "\u05d5\u05d9\u05e9\u05dc\u05d7",
    "Vayeshev": "\u05d5\u05d9\u05e9\u05d1",
    "Miketz": "\u05de\u05e7\u05e5",
    "Vayigash": "\u05d5\u05d9\u05d2\u05e9",
    "Vayechi": "\u05d5\u05d9\u05d7\u05d9",
    "Shemot": "\u05e9\u05de\u05d5\u05ea",
    "Vaera": "\u05d5\u05d0\u05e8\u05d0",
    "Bo": "\u05d1\u05d0",
    "Beshalach": "\u05d1\u05e9\u05dc\u05d7",
    "Yitro": "\u05d9\u05ea\u05e8\u05d5",
    "Mishpatim": "\u05de\u05e9\u05e4\u05d8\u05d9\u05dd",
    "Terumah": "\u05ea\u05e8\u05d5\u05de\u05d4",
    "Tetzaveh": "\u05ea\u05e6\u05d5\u05d4",
    "Ki Tisa": "\u05db\u05d9 \u05ea\u05e9\u05d0",
    "Vayakhel": "\u05d5\u05d9\u05e7\u05d4\u05dc",
    "Pekudei": "\u05e4\u05e7\u05d5\u05d3\u05d9",
    "Vayikra": "\u05d5\u05d9\u05e7\u05e8\u05d0",
    "Tzav": "\u05e6\u05d5",
    "Shmini": "\u05e9\u05de\u05d9\u05e0\u05d9",
    "Tazria": "\u05ea\u05d6\u05e8\u05d9\u05e2",
    "Metzora": "\u05de\u05e6\u05e8\u05e2",
    "Achrei Mot": "\u05d0\u05d7\u05e8\u05d9 \u05de\u05d5\u05ea",
    "Kedoshim": "\u05e7\u05d3\u05d5\u05e9\u05d9\u05dd",
    "Emor": "\u05d0\u05de\u05d5\u05e8",
    "Behar": "\u05d1\u05d4\u05e8",
    "Bechukotai": "\u05d1\u05d7\u05e7\u05ea\u05d9",
    "Bamidbar": "\u05d1\u05de\u05d3\u05d1\u05e8",
    "Nasso": "\u05e0\u05e9\u05d0",
    "Beha'alotcha": "\u05d1\u05d4\u05e2\u05dc\u05ea\u05da",
    "Sh'lach": "\u05e9\u05dc\u05d7",
    "Korach": "\u05e7\u05e8\u05d7",
    "Chukat": "\u05d7\u05e7\u05ea",
    "Balak": "\u05d1\u05dc\u05e7",
    "Pinchas": "\u05e4\u05d9\u05e0\u05d7\u05e1",
    "Matot": "\u05de\u05d8\u05d5\u05ea",
    "Masei": "\u05de\u05e1\u05e2\u05d9",
    "Devarim": "\u05d3\u05d1\u05e8\u05d9\u05dd",
    "Vaetchanan": "\u05d5\u05d0\u05ea\u05d7\u05e0\u05df",
    "Eikev": "\u05e2\u05e7\u05d1",
    "Re'eh": "\u05e8\u05d0\u05d4",
    "Shoftim": "\u05e9\u05d5\u05e4\u05d8\u05d9\u05dd",
    "Ki Teitzei": "\u05db\u05d9 \u05ea\u05e6\u05d0",
    "Ki Tavo": "\u05db\u05d9 \u05ea\u05d1\u05d5\u05d0",
    "Nitzavim": "\u05e0\u05e6\u05d1\u05d9\u05dd",
    "Vayeilech": "\u05d5\u05d9\u05dc\u05da",
    "Ha'azinu": "\u05d4\u05d0\u05d6\u05d9\u05e0\u05d5",
    "Vezot Haberakhah": "\u05d5\u05d6\u05d0\u05ea \u05d4\u05d1\u05e8\u05db\u05d4",
}


def he_parashah(name):
    """Hebrew name of a parashah, falling back to the Latin one."""
    return HE_PARASHAH.get(name, name)


# ---- Hebrew numerals, for the Hebrew reference line ------------------------
# Standard gematria with the two conventional exceptions: 15 and 16 are written
# tet-vav / tet-zayin rather than spelling a divine name.
_ONES = ["", "\u05d0", "\u05d1", "\u05d2", "\u05d3", "\u05d4", "\u05d5", "\u05d6", "\u05d7", "\u05d8"]
_TENS = ["", "\u05d9", "\u05db", "\u05dc", "\u05de", "\u05e0", "\u05e1", "\u05e2", "\u05e4", "\u05e6"]
_HUNDREDS = ["", "\u05e7", "\u05e8", "\u05e9", "\u05ea"]
GERESH, GERSHAYIM = "\u05f3", "\u05f4"


def he_num(n, marks=True):
    """Hebrew numeral for n (1..499), with geresh/gershayim when `marks`."""
    if n <= 0:
        return str(n)
    letters = ""
    h, rest = divmod(n, 100)
    while h > 4:  # 500+ is written as repeated tav
        letters += _HUNDREDS[4]
        h -= 4
    letters += _HUNDREDS[h]
    if rest in (15, 16):
        letters += "\u05d8" + _ONES[rest - 9]
    else:
        t, o = divmod(rest, 10)
        letters += _TENS[t] + _ONES[o]
    if not marks:
        return letters
    if len(letters) == 1:
        return letters + GERESH
    return letters[:-1] + GERSHAYIM + letters[-1]


def he_verse(n):
    """Hebrew numeral for a verse number.

    A chapter is cited with its geresh (מ׳), but a single-letter verse is written
    bare (מ׳:א, not מ׳:א׳) — the mark is what distinguishes the two halves of the
    reference. Multi-letter numbers still take their gershayim (כ״ו).
    """
    letters = he_num(n, marks=False)
    if len(letters) == 1:
        return letters
    return letters[:-1] + GERSHAYIM + letters[-1]


def he_ref(book_name, segments):
    """Hebrew reference line, e.g. "ישעיהו מ׳:א-כ״ו"."""
    b = book(book_name)
    parts = []
    for (c, v0, v1) in segments:
        head = f"{he_num(c)}:{he_verse(v0)}"
        parts.append(head if v1 is None or v1 == v0 else f"{head}-{he_verse(v1)}")
    return f"{b['he']} " + ", ".join(parts)


def en_ref(book_name, segments, chapter_lengths=None):
    """English reference line, e.g. "Isaiah 40:1-26" or "Isaiah 27:6-28:13, 29:22-23".

    Consecutive chapters that run end-to-end are collapsed into one span, which
    is how a haftarah is normally cited.
    """
    b = book(book_name)
    spans = collapse_segments(segments, chapter_lengths)
    parts = []
    for (c0, v0, c1, v1) in spans:
        if c0 == c1:
            parts.append(f"{c0}:{v0}-{v1}" if v0 != v1 else f"{c0}:{v0}")
        else:
            parts.append(f"{c0}:{v0}-{c1}:{v1}")
    return f"{b['en']} " + ", ".join(parts)


def collapse_segments(segments, chapter_lengths=None):
    """[(c, v0, v1|None)] -> [(c0, v0, c1, v1)] merging chapter-spanning runs.

    `chapter_lengths` maps chapter number -> verse count and is required to
    resolve a `None` end verse.
    """
    def last_of(c, v1):
        if v1 is not None:
            return v1
        if not chapter_lengths or c not in chapter_lengths:
            raise ValueError(f"need the length of chapter {c} to resolve an open range")
        return chapter_lengths[c]

    spans = []
    for (c, v0, v1) in segments:
        end = last_of(c, v1)
        if spans:
            pc0, pv0, pc1, pv1 = spans[-1]
            runs_on = (c == pc1 + 1 and v0 == 1
                       and chapter_lengths and pv1 == chapter_lengths.get(pc1))
            if runs_on:
                spans[-1] = (pc0, pv0, c, end)
                continue
        spans.append((c, v0, c, end))
    return spans
