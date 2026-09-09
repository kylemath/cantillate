#!/usr/bin/env python3
"""High Holiday readings chanted by Cantor Teplitz (MJC).

Public m4a files live at https://www.mjcnj.com/hhrecordings (ShulCloud
`images.shulcloud.com/1220/uploads/`). They are not Creative Commons. This
module declares them as `kind: "local"` source id `teplitz`, the same drop-in
shape as a teacher's recording in `local_readings.py`.

Split aliyot (RH1 2/3/5, RH1 maftir, YK 1/2/3, YK Mincha 3) are `pt_files`
parts, one file per recorded segment, in leyning order. `scripts/ingest_teplitz.py`
downloads the originals, symlinks them to `audio/teplitz/<audio_slug>-<i>.m4a`,
aligns onsets, and builds.

    .venv/bin/python scripts/ingest_teplitz.py all
    .venv/bin/python scripts/build_reading.py rh1-torah
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tanakh                                        # noqa: E402

TEPLITZ_URL = "https://www.mjcnj.com/hhrecordings"
TEPLITZ_LICENSE = (
    "Cantor Teplitz / MJC High Holiday recording. Not Creative Commons. "
    "Included as a local study source; redistribution rights remain with the "
    "cantor and congregation."
)
TEPLITZ_ATTR = (
    "Chanted by Cantor Teplitz (MJC). Local source from "
    "mjcnj.com/hhrecordings; not CC-licensed."
)


def teplitz_source(audio_slug, pt_files):
    return {
        "id": "teplitz",
        "label": "Cantor Teplitz (MJC · High Holiday)",
        "default": True,
        "kind": "local",
        "pt_files": list(pt_files),
        "pt_label": audio_slug + "-{i}.txt",
        "audio_slug": audio_slug,
        "ext": "m4a",
        "source_url": TEPLITZ_URL,
        "license": TEPLITZ_LICENSE,
        "attribution": TEPLITZ_ATTR,
    }


def holiday(book_en, spans, label, *, holiday_part, occasion,
            parashah_en, parashah_he, annual=None, sources=None, note=None,
            trope_style=None, ref=None):
    """A High Holiday leyning: Torah (5/6/3 aliyot), maftir, or haftarah."""
    b = tanakh.book(book_en)
    cfg = {
        "kind": "holiday",
        "holidayPart": holiday_part,
        "occasion": occasion,
        "label": label,
        "spans": spans,
        "sefaria_book": b["en"],
        "wlc_book": b["wlc"],
        "book": {"en": b["en"], "he": b["he"], "translit": b["translit"]},
        "multiChapter": True,
        "parashah": {
            "en": parashah_en,
            "he": parashah_he,
            "translit": parashah_en,
            "ref": ref or label,
        },
        "aliyotAttribution": (
            "Holiday aliyah boundaries from the MJC public leyning page "
            "(mjcnj.com/hhrecordings) and its PDFs."
        ),
    }
    if annual:
        cfg["annual"] = annual
    if sources is not None:
        cfg["sources"] = sources
    if note:
        cfg["note"] = note
    if trope_style:
        cfg["tropeStyle"] = trope_style
    if ref:
        cfg["ref"] = ref
    return cfg


# Original ShulCloud filename + verse range for each pipeline part.
# ingest_teplitz.py downloads `file` and symlinks <audio_slug>-<i>.m4a.
AUDIO_PARTS = {
    "rh1-torah": [
        {"i": 1, "file": "RH1-121_1-4.m4a", "book": "genesis", "range": "21:1-21:4"},
        {"i": 2, "file": "RH1-221_5-8.m4a", "book": "genesis", "range": "21:5-21:8"},
        {"i": 3, "file": "RH1-221_9-12.m4a", "book": "genesis", "range": "21:9-21:12"},
        {"i": 4, "file": "RH1-321_13-17.m4a", "book": "genesis", "range": "21:13-21:17"},
        {"i": 5, "file": "RH1-321_18-21.m4a", "book": "genesis", "range": "21:18-21:21"},
        {"i": 6, "file": "RH1-421_22-27.m4a", "book": "genesis", "range": "21:22-21:27"},
        {"i": 7, "file": "RH1-521_28-30.m4a", "book": "genesis", "range": "21:28-21:30"},
        {"i": 8, "file": "RH1-521_31-34.m4a", "book": "genesis", "range": "21:31-21:34"},
    ],
    "rh1-maftir": [
        {"i": 1, "file": "RHM-1.m4a", "book": "numbers", "range": "29:1-29:3"},
        {"i": 2, "file": "RHM-2.m4a", "book": "numbers", "range": "29:4-29:6"},
    ],
    "rh2-torah": [
        {"i": 1, "file": "RH2-122_1-3.m4a", "book": "genesis", "range": "22:1-22:3"},
        {"i": 2, "file": "RH2-222_4-8.m4a", "book": "genesis", "range": "22:4-22:8"},
        {"i": 3, "file": "RH2-322_9-14.m4a", "book": "genesis", "range": "22:9-22:14"},
        {"i": 4, "file": "RH2-422_15-19.m4a", "book": "genesis", "range": "22:15-22:19"},
        {"i": 5, "file": "RH2-522_20-24.m4a", "book": "genesis", "range": "22:20-22:24"},
    ],
    "rh2-maftir": [
        {"i": 1, "file": "RH2-M29_1-6.m4a", "book": "numbers", "range": "29:1-29:6"},
    ],
    "rh2-haftarah": [
        {"i": "H", "file": "RH2H.m4a", "book": "jeremiah", "range": "31:1-31:19"},
    ],
    "yk-torah": [
        {"i": 1, "file": "YK-116_1-3.m4a", "book": "leviticus", "range": "16:1-16:3"},
        {"i": 2, "file": "YK-116_4-6.m4a", "book": "leviticus", "range": "16:4-16:6"},
        {"i": 3, "file": "YK-216_7-9.m4a", "book": "leviticus", "range": "16:7-16:9"},
        {"i": 4, "file": "YK-216_10-11.m4a", "book": "leviticus", "range": "16:10-16:11"},
        {"i": 5, "file": "Yk3.m4a", "book": "leviticus", "range": "16:12-16:15"},
        {"i": 6, "file": "YK-316_16-17.m4a", "book": "leviticus", "range": "16:16-16:17"},
        {"i": 7, "file": "YK-416_18-24.m4a", "book": "leviticus", "range": "16:18-16:24"},
        {"i": 8, "file": "YK-516_25-30.m4a", "book": "leviticus", "range": "16:25-16:30"},
        {"i": 9, "file": "YK-616_31-34.m4a", "book": "leviticus", "range": "16:31-16:34"},
    ],
    "yk-maftir": [
        {"i": 1, "file": "YK-M29_7-11.m4a", "book": "numbers", "range": "29:7-29:11"},
    ],
    "yk-haftarah": [
        {"i": "H", "file": "YomKippurHaftarah.m4a", "book": "isaiah", "range": "57:14-58:14"},
    ],
    "yk-mincha-torah": [
        {"i": 1, "file": "TP1.m4a", "book": "leviticus", "range": "18:1-18:5"},
        {"i": 2, "file": "Mincha2.m4a", "book": "leviticus", "range": "18:6-18:21"},
        {"i": 3, "file": "Mincha3.1.m4a", "book": "leviticus", "range": "18:22-18:26"},
        {"i": 4, "file": "Mincha3.2.m4a", "book": "leviticus", "range": "18:27-18:30"},
    ],
}

# Downloaded and mapped; no Tanakh range, so not in REGISTRY / not built.
BLESSINGS = [
    {"file": "Haftorah-before-blessing.m4a", "label": "Haftarah blessing · before"},
    {"file": "After-H-blessing-1.m4a", "label": "Haftarah blessing · after 1"},
    {"file": "After-H-blessing-2-2.m4a", "label": "Haftarah blessing · after 2"},
    {"file": "After-H-blessing-3.m4a", "label": "Haftarah blessing · after 3"},
    {"file": "After-H-blessing-4.m4a", "label": "Haftarah blessing · after 4"},
    {"file": "RH5.m4a", "label": "Haftarah blessing · after 5 (RH)"},
    {"file": "YK5.m4a", "label": "Haftarah blessing · after 5 (YK)"},
    {"file": "RH6.m4a", "label": "Haftarah blessing · after 6 (RH)"},
    {"file": "YK6.m4a", "label": "Haftarah blessing · after 6 (YK)"},
]

RH1 = "Rosh Hashanah Day 1"
RH2 = "Rosh Hashanah Day 2"
YK = "Yom Kippur"
YK_MINCHA = "Yom Kippur Mincha"
HE_RH1 = "\u05e8\u05d0\u05e9 \u05d4\u05e9\u05e0\u05d4 \u05d9\u05d5\u05dd \u05d0\u05f3"
HE_RH2 = "\u05e8\u05d0\u05e9 \u05d4\u05e9\u05e0\u05d4 \u05d9\u05d5\u05dd \u05d1\u05f3"
HE_YK = "\u05d9\u05d5\u05dd \u05db\u05d9\u05e4\u05d5\u05e8"
HE_YKM = "\u05d9\u05d5\u05dd \u05db\u05d9\u05e4\u05d5\u05e8 \u05de\u05e0\u05d7\u05d4"

REGISTRY = {
    "rh1-torah": holiday(
        "Genesis", [((21, 1), (21, 34))],
        "Rosh Hashanah Day 1 \u00b7 Torah (Genesis 21:1\u201334)",
        holiday_part="torah", occasion="rh1",
        parashah_en=RH1, parashah_he=HE_RH1, ref="Genesis 21:1-21:34",
        annual=[((21, 1), (21, 4)), ((21, 5), (21, 12)), ((21, 13), (21, 21)),
                ((21, 22), (21, 27)), ((21, 28), (21, 34))],
        sources=[teplitz_source("rh1-torah", [1, 2, 3, 4, 5, 6, 7, 8])],
        note="Five aliyot; aliyot 2, 3 and 5 are split across two recordings.",
    ),
    "rh1-maftir": holiday(
        "Numbers", [((29, 1), (29, 6))],
        "Rosh Hashanah Day 1 \u00b7 Maftir (Numbers 29:1\u20136)",
        holiday_part="maftir", occasion="rh1",
        parashah_en=RH1, parashah_he=HE_RH1, ref="Numbers 29:1-29:6",
        sources=[teplitz_source("rh1-maftir", [1, 2])],
        note="Maftir split as RHM-1 (29:1\u20133) + RHM-2 (29:4\u20136).",
    ),
    "rh1-haftarah": holiday(
        "I Samuel", [((1, 1), (2, 10))],
        "Rosh Hashanah Day 1 \u00b7 Haftarah (I Samuel 1:1\u20132:10)",
        holiday_part="haftarah", occasion="rh1",
        parashah_en=RH1, parashah_he=HE_RH1, ref="I Samuel 1:1-2:10",
        sources=[],
        trope_style="haftarah",
        note="MJC published HforRH1.pdf but no dedicated m4a. Text-only until audio exists.",
    ),
    "rh2-torah": holiday(
        "Genesis", [((22, 1), (22, 24))],
        "Rosh Hashanah Day 2 \u00b7 Torah (Genesis 22:1\u201324)",
        holiday_part="torah", occasion="rh2",
        parashah_en=RH2, parashah_he=HE_RH2, ref="Genesis 22:1-22:24",
        annual=[((22, 1), (22, 3)), ((22, 4), (22, 8)), ((22, 9), (22, 14)),
                ((22, 15), (22, 19)), ((22, 20), (22, 24))],
        sources=[teplitz_source("rh2-torah", [1, 2, 3, 4, 5])],
    ),
    "rh2-maftir": holiday(
        "Numbers", [((29, 1), (29, 6))],
        "Rosh Hashanah Day 2 \u00b7 Maftir (Numbers 29:1\u20136)",
        holiday_part="maftir", occasion="rh2",
        parashah_en=RH2, parashah_he=HE_RH2, ref="Numbers 29:1-29:6",
        sources=[teplitz_source("rh2-maftir", [1])],
    ),
    "rh2-haftarah": holiday(
        "Jeremiah", [((31, 1), (31, 19))],
        "Rosh Hashanah Day 2 \u00b7 Haftarah (Jeremiah 31:1\u201319)",
        holiday_part="haftarah", occasion="rh2",
        parashah_en=RH2, parashah_he=HE_RH2, ref="Jeremiah 31:1-31:19",
        sources=[teplitz_source("rh2-haftarah", ["H"])],
        trope_style="haftarah",
        note="Public MJC page/PDF: Jeremiah 31:1\u201319 (standard Conservative often 31:2\u201320).",
    ),
    "yk-torah": holiday(
        "Leviticus", [((16, 1), (16, 34))],
        "Yom Kippur \u00b7 Torah (Leviticus 16:1\u201334)",
        holiday_part="torah", occasion="yk",
        parashah_en=YK, parashah_he=HE_YK, ref="Leviticus 16:1-16:34",
        annual=[((16, 1), (16, 6)), ((16, 7), (16, 11)), ((16, 12), (16, 17)),
                ((16, 18), (16, 24)), ((16, 25), (16, 30)), ((16, 31), (16, 34))],
        sources=[teplitz_source("yk-torah", [1, 2, 3, 4, 5, 6, 7, 8, 9])],
        note="Six aliyot; aliyot 1\u20133 are split across two recordings each.",
    ),
    "yk-maftir": holiday(
        "Numbers", [((29, 7), (29, 11))],
        "Yom Kippur \u00b7 Maftir (Numbers 29:7\u201311)",
        holiday_part="maftir", occasion="yk",
        parashah_en=YK, parashah_he=HE_YK, ref="Numbers 29:7-29:11",
        sources=[teplitz_source("yk-maftir", [1])],
    ),
    "yk-haftarah": holiday(
        "Isaiah", [((57, 14), (58, 14))],
        "Yom Kippur \u00b7 Haftarah (Isaiah 57:14\u201358:14)",
        holiday_part="haftarah", occasion="yk",
        parashah_en=YK, parashah_he=HE_YK, ref="Isaiah 57:14-58:14",
        sources=[teplitz_source("yk-haftarah", ["H"])],
        trope_style="haftarah",
    ),
    "yk-mincha-torah": holiday(
        "Leviticus", [((18, 1), (18, 30))],
        "Yom Kippur Mincha \u00b7 Torah (Leviticus 18:1\u201330)",
        holiday_part="torah", occasion="yk-mincha",
        parashah_en=YK_MINCHA, parashah_he=HE_YKM, ref="Leviticus 18:1-18:30",
        annual=[((18, 1), (18, 5)), ((18, 6), (18, 21)), ((18, 22), (18, 30))],
        sources=[teplitz_source("yk-mincha-torah", [1, 2, 3, 4])],
        note="Three aliyot; aliyah 3 is split (18:22\u201326 + 18:27\u201330).",
    ),
    "yk-mincha-haftarah": holiday(
        "Jonah", [((1, 1), (4, 11))],
        "Yom Kippur Mincha \u00b7 Haftarah (Jonah)",
        holiday_part="haftarah", occasion="yk-mincha",
        parashah_en=YK_MINCHA, parashah_he=HE_YKM, ref="Jonah 1:1-4:11",
        sources=[],
        trope_style="haftarah",
        note="No m4a in the MJC catalog. Text-only. Many communities append Micah 7:18\u201320; that is not in this reading (single-book build).",
    ),
}
