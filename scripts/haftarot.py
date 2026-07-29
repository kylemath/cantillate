#!/usr/bin/env python3
"""Registry of the weekly haftarah, one per parashah, built for build_reading.py.

    .venv/bin/python scripts/build_reading.py haftarah-eikev
    .venv/bin/python scripts/build_haftarot.py --from-this-week 8

A haftarah is a passage in Nevi'im chanted after the Torah reading, to a melody
that is related to the Torah's but distinctly its own. Everything needed to build
one already exists in the two upstream sources this project uses:

  * WHICH passage — Hebcal's leyning table (data/hebcal/aliyot.json, fetched by
    aliyot_build.py) carries a `haft` key per parashah for the Ashkenazi rite and
    a `seph` key for the Sephardi one. We read `haft` today; `seph` is the same
    shape, so a second tradition is a table lookup, not a rewrite (see TRADITIONS).
  * The RECORDING — PocketTorah recorded the haftarah alongside the seven aliyot
    of every parashah, as `<Name>-H.mp3` with word onsets in `<name>-H.txt`.

So a haftarah build is the ordinary build_reading.py pipeline pointed at a book
of Nevi'im: Sefaria for the text, PocketTorah for the chant and the word onsets,
and the same pitch extraction for the coach line.

PocketTorah's file names are inconsistent in the same ways as the Torah ones
(`-H` vs `-h`, curly apostrophes, spaces kept or dropped), and they are not
derivable from the parashah name, so PT holds the verified name of every one.
The parashah's calendar number comes from Hebcal, which is what orders the
Haftarot menu.

Where a recording does NOT match Hebcal's Ashkenazi range, RANGE_OVERRIDE or
TEXT_ONLY says so explicitly rather than letting the words silently drift out of
step with the audio; the reason is recorded in each case. `python3
scripts/haftarot.py` re-checks every entry against the upstream word counts.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tanakh                                    # noqa: E402
from aliyot_build import _match_key              # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
HEBCAL_ALIYOT = os.path.join(DATA, "hebcal", "aliyot.json")

# Which key of Hebcal's table each rite reads. Both have the identical shape, so
# building the Sephardi haftarah is a matter of passing tradition="sephardi" (its
# melody differs from the Ashkenazi one, so it wants its own recording before the
# app offers it as more than text).
TRADITIONS = {
    "ashkenaz": {"key": "haft", "label": "Ashkenazi"},
    "sephardi": {"key": "seph", "label": "Sephardi"},
}
DEFAULT_TRADITION = "ashkenaz"

GROUP = "Haftarot"

ATTRIBUTION = ("Haftarah boundaries from Hebcal (hebcal-leyning, BSD-2-Clause); "
               "Ashkenazi rite.")

# slug -> (Hebcal parashah key, calendar number, PocketTorah label, PocketTorah mp3)
# Verified against the PocketTorah repo tree; see the module docstring.
PT = {
    "haftarah-bereshit":        ("Bereshit", 1, "Bereshit-H.txt", "Bereshit-H.mp3"),
    "haftarah-noach":           ("Noach", 2, "Noach-H.txt", "Noach-H.mp3"),
    "haftarah-lechlecha":       ("Lech-Lecha", 3, "lech-lecha-h.txt", "Lech-Lecha-H.mp3"),
    "haftarah-vayera":          ("Vayera", 4, "Vayera-h.txt", "Vayera-H.mp3"),
    "haftarah-chayeisara":      ("Chayei Sara", 5, "Chayei Sara-h.txt", "ChayeiSara-H.mp3"),
    "haftarah-toldot":          ("Toldot", 6, "toldot-h.txt", "Toldot-H.mp3"),
    "haftarah-vayetzei":        ("Vayetzei", 7, "Vayetzei-H.txt", "Vayetzei-H.mp3"),
    "haftarah-vayishlach":      ("Vayishlach", 8, "Vayishlach-H.txt", "Vayishlach-H.mp3"),
    "haftarah-vayeshev":        ("Vayeshev", 9, "Vayeshev-H.txt", "Vayeshev-H.mp3"),
    "haftarah-miketz":          ("Miketz", 10, "Miketz-H.txt", "Miketz-H.mp3"),
    "haftarah-vayigash":        ("Vayigash", 11, "Vayigash-H.txt", "Vayigash-H.mp3"),
    "haftarah-vayechi":         ("Vayechi", 12, "Vayechi-H.txt", "Vayechi-H.mp3"),
    "haftarah-shemot":          ("Shemot", 13, "Shemot-H.txt", "Shemot-H.mp3"),
    "haftarah-vaera":           ("Vaera", 14, "Vaera-H.txt", "Vaera-H.mp3"),
    "haftarah-bo":              ("Bo", 15, "Bo-H.txt", "Bo-H.mp3"),
    "haftarah-beshalach":       ("Beshalach", 16, "Beshalach-H.txt", "Beshalach-H.mp3"),
    "haftarah-yitro":           ("Yitro", 17, "yitro-h.txt", "Yitro-H.mp3"),
    "haftarah-mishpatim":       ("Mishpatim", 18, "mishpatim-H.txt", "Mishpatim-H.mp3"),
    "haftarah-terumah":         ("Terumah", 19, "Terumah-H.txt", "Terumah-H.mp3"),
    "haftarah-tetzaveh":        ("Tetzaveh", 20, "tetzaveh-h.txt", "Tetzaveh-H.mp3"),
    "haftarah-kitisa":          ("Ki Tisa", 21, "ki tisa-h.txt", "KiTisa-H.mp3"),
    "haftarah-vayakhel":        ("Vayakhel", 22, "vayakhel-h.txt", "Vayakhel-H.mp3"),
    "haftarah-pekudei":         ("Pekudei", 23, "pekudei-h.txt", "Pekudei-H.mp3"),
    "haftarah-vayikra":         ("Vayikra", 24, "Vayikra-H.txt", "Vayikra-H.mp3"),
    "haftarah-tzav":            ("Tzav", 25, "tzav-h.txt", "Tzav-H.mp3"),
    "haftarah-shmini":          ("Shmini", 26, "shmini-h.txt", "Shmini-H.mp3"),
    "haftarah-tazria":          ("Tazria", 27, "tazria-h.txt", "Tazria-H.mp3"),
    "haftarah-metzora":         ("Metzora", 28, "metzora-h.txt", "Metzora-H.mp3"),
    "haftarah-achreimot":       ("Achrei Mot", 29, "Achrei Mot-h.txt", "AchreiMot-H.mp3"),
    "haftarah-kedoshim":        ("Kedoshim", 30, "Kedoshim-h.txt", "Kedoshim-H.mp3"),
    "haftarah-emor":            ("Emor", 31, "Emor-H.txt", "Emor-H.mp3"),
    "haftarah-behar":           ("Behar", 32, "Behar-H.txt", "Behar-H.mp3"),
    "haftarah-bechukotai":      ("Bechukotai", 33, "Bechukotai-h.txt", "Bechukotai-H.mp3"),
    "haftarah-bamidbar":        ("Bamidbar", 34, "Bamidbar-H.txt", "Bamidbar-H.mp3"),
    "haftarah-nasso":           ("Nasso", 35, "nasso-h.txt", "Nasso-H.mp3"),
    "haftarah-behaalotcha":     ("Beha'alotcha", 36, "Beha\u2019alotcha-H.txt", "Behaalotcha-H.mp3"),
    "haftarah-shlach":          ("Sh'lach", 37, "sh\u2019lach-H.txt", "Shlach-H.mp3"),
    "haftarah-korach":          ("Korach", 38, "Korach-h.txt", "Korach-H.mp3"),
    "haftarah-chukat":          ("Chukat", 39, "Chukat-h.txt", "Chukat-H.mp3"),
    "haftarah-balak":           ("Balak", 40, "Balak-h.txt", "Balak-H.mp3"),
    "haftarah-pinchas":         ("Pinchas", 41, "Pinchas-H.txt", "Pinchas-H.mp3"),
    "haftarah-matot":           ("Matot", 42, "matot-h.txt", "Matot-H.mp3"),
    "haftarah-masei":           ("Masei", 43, "masei-h.txt", "Masei-H.mp3"),
    "haftarah-devarim":         ("Devarim", 44, "devarim-H.txt", "Devarim-H.mp3"),
    "haftarah-vaetchanan":      ("Vaetchanan", 45, "Va\u2019ethanan-h.txt", "Vaethanan-H.mp3"),
    "haftarah-eikev":           ("Eikev", 46, "eikev-H.txt", "Eikev-H.mp3"),
    "haftarah-reeh":            ("Re'eh", 47, "re\u2019eh-h.txt", "Reeh-H.mp3"),
    "haftarah-shoftim":         ("Shoftim", 48, "shoftim-h.txt", "Shoftim-H.mp3"),
    "haftarah-kiteitzei":       ("Ki Teitzei", 49, "Ki Teitzei-h.txt", "KiTeitzei-H.mp3"),
    "haftarah-kitavo":          ("Ki Tavo", 50, "Ki Tavo-H.txt", "KiTavo-H.mp3"),
    "haftarah-nitzavim":        ("Nitzavim", 51, "nitzavim-h.txt", "Nitzavim-H.mp3"),
    "haftarah-vayeilech":       ("Vayeilech", 52, "vayeilech-h.txt", "Vayeilech-H.mp3"),
    "haftarah-haazinu":         ("Ha'azinu", 53, "haazinu-h.txt", "Haazinu-H.mp3"),
    "haftarah-vezothaberakhah": ("Vezot Haberakhah", 54, "Vezot Haberakhah-h.txt",
                                 "VezotHaberakhah-H.mp3"),
}

# Where PocketTorah chanted a different range from the one Hebcal lists for the
# Ashkenazi rite. The recording wins, because the words have to line up with it;
# each entry records what the audio actually contains and how we know.
RANGE_OVERRIDE = {
    # Hebcal lists Amos 9:7-15 for Achrei Mot and Ezekiel 22:1-19 for Kedoshim
    # (the pairing used when the two are read together). PocketTorah follows the
    # commoner chumash division instead, and its two recordings match Ezekiel
    # 22:1-16 (188 words) and Amos 9:7-15 (149 words) to the word.
    "haftarah-achreimot": {
        "book": "Ezekiel", "spans": [((22, 1), (22, 16))],
        "note": "Ashkenazi practice is divided here. This is Ezekiel 22:1\u201316, "
                "the range PocketTorah recorded; Hebcal pairs Achrei Mot with "
                "Amos 9:7\u201315 instead (chanted here as Haftarat Kedoshim).",
    },
    "haftarah-kedoshim": {
        "book": "Amos", "spans": [((9, 7), (9, 15))],
        "note": "Ashkenazi practice is divided here. This is Amos 9:7\u201315, the "
                "range PocketTorah recorded; Hebcal pairs it with Achrei Mot and "
                "gives Kedoshim Ezekiel 22:1\u201319.",
    },
}

# Haftarot whose recording cannot be aligned, so they ship as text only. The app
# still teaches them: with no recording to measure, the coach line falls back to
# the haftarah trope shapes measured across every haftarah that DOES align
# (data/haftarah-shapes.json), which is the same melody from a different cantor.
TEXT_ONLY = {
    "haftarah-vayeilech": (
        "PocketTorah's word onsets for this one cover 191 words, and no standard "
        "haftarah range has that length (the only exact fit in Isaiah 55\u201356 is "
        "55:5\u201356:4), so the recording is left out rather than drifting out of "
        "step with the text. The coach line uses the measured haftarah trope "
        "shapes instead."
    ),
}

# Recordings that align except for a small known drift. The build still uses them
# — a word or two out of several hundred leaves most of the reading usable — but
# the reading carries a note, and build_reading.py prints which verses are off.
AUDIO_DRIFT = {
    "haftarah-vayera": (
        "The recording has one word onset fewer than the text has words (556 vs "
        "557), so the audio may sit a word off in the later verses."
    ),
}

# Passages written as poetry, where the Masoretic text divides the words
# differently from the recording's word labels, so the coach line is only
# approximate — the same caveat the Torah's Ha'azinu carries.
COACH_APPROX = {
    "haftarah-haazinu": (
        "The Song of David is laid out as poetry, and the text divides its words "
        "differently from the recording, so the coach line is approximate through "
        "much of the song."
    ),
}

# Sabbaths whose haftarah is known by its own name. Worth showing: it is how a
# reader is told which one to prepare, and the three of rebuke / seven of
# consolation are a fixed sequence, not seven unrelated passages.
SPECIAL = {
    "haftarah-devarim": "Shabbat Chazon \u2014 the third of the three of rebuke",
    "haftarah-vaetchanan": "Shabbat Nachamu \u2014 the first of the seven of consolation",
    "haftarah-eikev": "The second of the seven of consolation",
    "haftarah-reeh": "The third of the seven of consolation",
    "haftarah-shoftim": "The fourth of the seven of consolation",
    "haftarah-kiteitzei": "The fifth of the seven of consolation",
    "haftarah-kitavo": "The sixth of the seven of consolation",
    "haftarah-nitzavim": "The seventh of the seven of consolation",
    "haftarah-matot": "The first of the three of rebuke",
    "haftarah-masei": "The second of the three of rebuke",
    "haftarah-haazinu": "Chanted as the Song of David (II Samuel 22)",
}

_TABLE = None


def _hebcal_table():
    global _TABLE
    if _TABLE is None:
        with open(HEBCAL_ALIYOT, encoding="utf-8") as f:
            _TABLE = json.load(f)
    return _TABLE


def _haft_entry(parashah, tradition):
    """Hebcal's haftarah record(s) for a parashah, as a list of {k,b,e}."""
    table = _hebcal_table()
    key = _match_key(parashah, table)
    if not key:
        raise KeyError(f"no Hebcal entry for parashah {parashah!r}")
    raw = table[key].get(TRADITIONS[tradition]["key"])
    if not raw:
        return None
    return raw if isinstance(raw, list) else [raw]


def _spans_from_hebcal(records):
    """[{k,b,e}] -> (book, [((c0,v0),(c1,v1))]).

    A haftarah is occasionally two passages from the same book (Shemot reads
    Isaiah 27:6-28:13 and then 29:22-23), and Mishpatim's second passage comes
    BEFORE its first, so the order given is preserved rather than sorted.
    """
    book = records[0]["k"]
    spans = []
    for r in records:
        if r["k"] != book:
            raise ValueError(f"haftarah spans two books ({book} and {r['k']}); "
                             "needs an explicit RANGE_OVERRIDE")
        c0, v0 = (int(x) for x in r["b"].split(":"))
        c1, v1 = (int(x) for x in r["e"].split(":"))
        spans.append(((c0, v0), (c1, v1)))
    return book, spans


def slugs(tradition=DEFAULT_TRADITION):
    """Every haftarah slug, in calendar order."""
    return [s for s, _ in sorted(PT.items(), key=lambda kv: kv[1][1])]


def parashah_of(slug):
    return PT[slug][0]


def cfg(slug, tradition=DEFAULT_TRADITION):
    """A build_reading.py config for one haftarah."""
    if slug not in PT:
        raise KeyError(f"unknown haftarah slug {slug!r}")
    parashah, num, pt_label, pt_audio = PT[slug]

    override = RANGE_OVERRIDE.get(slug)
    if override:
        book_name, spans = override["book"], override["spans"]
    else:
        records = _haft_entry(parashah, tradition)
        if not records:
            raise KeyError(f"Hebcal has no {tradition} haftarah for {parashah!r}")
        book_name, spans = _spans_from_hebcal(records)

    b = tanakh.book(book_name)
    notes = []
    if SPECIAL.get(slug):
        notes.append(SPECIAL[slug])
    if override and override.get("note"):
        notes.append(override["note"])
    if AUDIO_DRIFT.get(slug):
        notes.append(AUDIO_DRIFT[slug])
    if COACH_APPROX.get(slug):
        notes.append(COACH_APPROX[slug])
    text_only = slug in TEXT_ONLY
    if text_only:
        notes.append(TEXT_ONLY[slug])

    out = {
        "kind": "haftarah",
        "group": GROUP,
        "tropeStyle": "haftarah",
        "tradition": tradition,
        "calendarNumber": num,
        # Chapters are known; verse counts are not until the text is fetched, so
        # build_reading.py expands `spans` into its `range` once it has them.
        "spans": spans,
        "sefaria_book": b["en"],
        "wlc_book": b["wlc"],
        "book": {"en": b["en"], "he": b["he"], "translit": b["translit"]},
        "multiChapter": True,
        "haftarah": {"parashah": parashah, "tradition": tradition,
                     "traditionLabel": TRADITIONS[tradition]["label"],
                     "calendarNumber": num},
        # Kept distinct from the Torah parashah of the same name so progress and
        # leaderboard entries for the haftarah never merge with the Torah reading's.
        "parashah": {"en": f"Haftarat {parashah}", "translit": f"Haftarat {parashah}",
                     "he": "\u05d4\u05e4\u05d8\u05e8\u05ea " + _he_parashah(parashah)},
        "aliyotAttribution": ATTRIBUTION,
    }
    if notes:
        out["note"] = " ".join(notes)
    if not text_only:
        out.update({
            "pt_files": ["H"],
            "pt_label": pt_label,
            "pt_audio": pt_audio,
            "audio_slug": slug,
        })
    return out


# Hebrew parashah names, for the "הפטרת ..." line. The table lives in tanakh.py,
# which the book picker shares (see build_tanakh.py); anything missing from it
# falls back to the Latin name.
_HE_PARASHAH = tanakh.HE_PARASHAH


def _he_parashah(name):
    return tanakh.he_parashah(name)


REGISTRY = {}


def _populate():
    for slug in PT:
        try:
            REGISTRY[slug] = cfg(slug)
        except KeyError:
            continue  # no haftarah in this rite; skipped rather than half-built


_populate()


# ---- self-check ------------------------------------------------------------
# Verifies every entry against the two upstream sources: that PocketTorah really
# ships the named files, and that the number of word onsets in the recording
# equals the number of words in the range we are about to pair it with. A
# mismatch means the text would drift out of step with the audio, which is the
# one failure that is invisible in the app until you try to chant along.
def _check():
    import urllib.parse
    import urllib.request

    RAW = "https://raw.githubusercontent.com/rneiss/PocketTorah/master"

    def get(url):
        req = urllib.request.Request(url, headers={"User-Agent": "cantillate-haftarot/0.1"})
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.read()

    wlc_cache = {}

    def chapters(wlc_book):
        if wlc_book not in wlc_cache:
            doc = json.loads(get(f"{RAW}/data/torah/json/{wlc_book}.json").decode("utf-8-sig"))
            # The WLC files end with a trailing null chapter; drop it so the list
            # index really is chapter-1 all the way to the end of the book.
            raw = doc["Tanach"]["tanach"]["book"]["c"]
            wlc_cache[wlc_book] = [c for c in raw if c]
        return wlc_cache[wlc_book]

    ok = bad = skipped = 0
    for slug in slugs():
        c = REGISTRY.get(slug)
        if not c:
            print(f"  --   {slug}: no entry")
            continue
        if slug in TEXT_ONLY:
            print(f"  text {slug}: text only by design")
            skipped += 1
            continue
        ch = chapters(c["wlc_book"])
        lengths = {i + 1: len(ch[i]["v"]) for i in range(len(ch))}
        words = 0
        for ((c0, v0), (c1, v1)) in c["spans"]:
            for cc in range(c0, c1 + 1):
                first = v0 if cc == c0 else 1
                last = v1 if cc == c1 else lengths[cc]
                for v in range(first, last + 1):
                    words += len(ch[cc - 1]["v"][v - 1]["w"])
        try:
            raw = get(f"{RAW}/data/torah/labels/"
                      f"{urllib.parse.quote(c['pt_label'])}").decode("utf-8-sig")
            onsets = len([x for x in raw.strip().split(",") if x.strip()])
        except Exception as e:  # noqa: BLE001 - reported, not raised
            print(f"  FAIL {slug}: label {c['pt_label']!r} unreachable ({e})")
            bad += 1
            continue
        ref = tanakh.en_ref(c["sefaria_book"],
                            _flatten(c["spans"], lengths), lengths)
        if onsets == words:
            print(f"  ok   {slug:28s} {ref:28s} {words} words")
            ok += 1
        elif slug in AUDIO_DRIFT:
            print(f"  drift {slug:27s} {ref:28s} words={words} onsets={onsets} (known)")
            skipped += 1
        else:
            print(f"  FAIL {slug:28s} {ref:28s} words={words} onsets={onsets}")
            bad += 1
    print(f"\n{ok} aligned, {bad} unexpected mismatch, {skipped} known caveat, "
          f"{len(PT)} total")
    return bad


def _flatten(spans, lengths):
    """[((c0,v0),(c1,v1))] -> [(c, v0, v1)] using known chapter lengths."""
    out = []
    for ((c0, v0), (c1, v1)) in spans:
        for cc in range(c0, c1 + 1):
            out.append((cc, v0 if cc == c0 else 1, v1 if cc == c1 else lengths[cc]))
    return out


if __name__ == "__main__":
    sys.exit(1 if _check() else 0)
