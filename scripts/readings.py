#!/usr/bin/env python3
"""Registry of buildable readings for scripts/build_reading.py.

Each entry says where to get the text (Sefaria), the recorded chant + word-onset
labels (PocketTorah), and the verse range. To add a reading: copy the TEMPLATE
below, fill it in (look up the exact PocketTorah file names in the repo — they
are inconsistent about apostrophes/spelling), then run:

    .venv/bin/python scripts/build_reading.py <slug>

Aliyot are NOT hand-typed: both the annual (full kriyah) and triennial (+maftir)
boundaries are fetched from Hebcal by parashah name (see scripts/aliyot_build.py)
and mapped onto the reading's verse indices. The parashah is matched from
`parashah.en`; set an explicit `hebcal` key only if the auto-match fails (e.g.
combined parshiyot). The `annual` tuples below are kept solely as an OFFLINE
FALLBACK for when Hebcal can't be reached.

See README.md ("Adding a reading / parashah") for the full walkthrough.
"""

# Book blocks, repeated across every parashah of that book.
DEVARIM = {"en": "Deuteronomy", "he": "\u05d3\u05d1\u05e8\u05d9\u05dd", "translit": "Devarim"}
BERESHIT = {"en": "Genesis", "he": "\u05d1\u05e8\u05d0\u05e9\u05d9\u05ea", "translit": "Bereshit"}
BAMIDBAR = {"en": "Numbers", "he": "\u05d1\u05de\u05d3\u05d1\u05e8", "translit": "Bamidbar"}

REGISTRY = {
    "vaetchanan": {
        "label": "Va'etchanan (Deuteronomy 3:23\u20137:11)",
        "sefaria_book": "Deuteronomy",           # Sefaria + PocketTorah WLC json name
        "book": {"en": "Deuteronomy", "he": "\u05d3\u05d1\u05e8\u05d9\u05dd", "translit": "Devarim"},
        "parashah": {"en": "Va'etchanan",
                     "he": "\u05d5\u05b8\u05d0\u05b6\u05ea\u05b0\u05d7\u05b7\u05e0\u05b7\u05bc\u05df",
                     "translit": "Va'etchanan",
                     "ref": "Deuteronomy 3:23\u20137:11"},
        "multiChapter": True,
        "ref": "Deuteronomy 3:23-7:11",
        "heRef": "\u05d3\u05d1\u05e8\u05d9\u05dd \u05d2\u05f3:\u05db\u05f4\u05d2-\u05d6\u05f3:\u05d9\u05f4\u05d0",
        # reading range as (chapter, first_verse, last_verse|None=to chapter end)
        "range": [(3, 23, None), (4, 1, None), (5, 1, None), (6, 1, None), (7, 1, 11)],
        # PocketTorah: files, label filename (URL-encoded on fetch), audio filename,
        # and the local audio prefix (audio/<audio_slug>-<i>.mp3).
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        "pt_label": "Va\u2019ethanan-{i}.txt",   # NOTE the curly apostrophe U+2019
        "pt_audio": "Vaethanan-{i}.mp3",         # NOTE: no apostrophe, capital V
        "audio_slug": "vaethanan",
        # Offline fallback only; live annual+triennial aliyot come from Hebcal
        # (parashah "Vaetchanan"). ((chapter,verse) start, (chapter,verse) end).
        "annual": [((3, 23), (4, 4)), ((4, 5), (4, 40)), ((4, 41), (4, 49)),
                   ((5, 1), (5, 18)), ((5, 19), (6, 3)), ((6, 4), (6, 25)), ((7, 1), (7, 11))],
    },

    "eikev": {
        "label": "Eikev (Deuteronomy 7:12\u201311:25)",
        "sefaria_book": "Deuteronomy",
        "book": {"en": "Deuteronomy", "he": "\u05d3\u05d1\u05e8\u05d9\u05dd", "translit": "Devarim"},
        "parashah": {"en": "Eikev", "he": "\u05e2\u05b5\u05e7\u05b6\u05d1", "translit": "Eikev",
                     "ref": "Deuteronomy 7:12\u201311:25"},
        "multiChapter": True,
        "ref": "Deuteronomy 7:12-11:25",
        "heRef": "\u05d3\u05d1\u05e8\u05d9\u05dd \u05d6\u05f3:\u05d9\u05f4\u05d1-\u05d9\u05f4\u05d0:\u05db\u05f4\u05d4",
        "range": [(7, 12, None), (8, 1, None), (9, 1, None), (10, 1, None), (11, 1, 25)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        # PocketTorah names for Eikev (verified in the repo): lowercase labels,
        # capitalized audio.
        "pt_label": "eikev-{i}.txt",
        "pt_audio": "Eikev-{i}.mp3",
        "audio_slug": "eikev",
        # Offline fallback only; live aliyot come from Hebcal (parashah "Eikev").
        "annual": [((7, 12), (8, 10)), ((8, 11), (9, 3)), ((9, 4), (9, 29)),
                   ((10, 1), (10, 11)), ((10, 12), (11, 9)), ((11, 10), (11, 21)),
                   ((11, 22), (11, 25))],
    },

    # ---- The rest of Devarim --------------------------------------------------
    # Deuteronomy end to end, so a reader can work through the book rather than
    # the three parashiyot the app started with.

    "devarim": {
        "label": "Devarim (Deuteronomy 1:1\u20133:22)",
        "sefaria_book": "Deuteronomy",
        "book": DEVARIM,
        "parashah": {"en": "Devarim", "he": "\u05d3\u05b0\u05bc\u05d1\u05b8\u05e8\u05b4\u05d9\u05dd",
                     "translit": "Devarim", "ref": "Deuteronomy 1:1\u20133:22"},
        "multiChapter": True,
        "ref": "Deuteronomy 1:1-3:22",
        "heRef": "\u05d3\u05d1\u05e8\u05d9\u05dd \u05d0\u05f3:\u05d0-\u05d2\u05f3:\u05db\u05f4\u05d1",
        "range": [(1, 1, None), (2, 1, None), (3, 1, 22)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        "pt_label": "devarim-{i}.txt",
        "pt_audio": "Devarim-{i}.mp3",
        "audio_slug": "devarim",
        "annual": [((1, 1), (1, 10)), ((1, 11), (1, 21)), ((1, 22), (1, 38)),
                   ((1, 39), (2, 1)), ((2, 2), (2, 30)), ((2, 31), (3, 14)),
                   ((3, 15), (3, 22))],
    },

    "reeh": {
        "label": "Re'eh (Deuteronomy 11:26\u201316:17)",
        "sefaria_book": "Deuteronomy",
        "book": DEVARIM,
        "parashah": {"en": "Re'eh", "he": "\u05e8\u05b0\u05d0\u05b5\u05d4", "translit": "Re'eh",
                     "ref": "Deuteronomy 11:26\u201316:17"},
        "multiChapter": True,
        "ref": "Deuteronomy 11:26-16:17",
        "heRef": "\u05d3\u05d1\u05e8\u05d9\u05dd \u05d9\u05f4\u05d0:\u05db\u05f4\u05d5-\u05d8\u05f4\u05d6:\u05d9\u05f4\u05d6",
        "range": [(11, 26, None), (12, 1, None), (13, 1, None), (14, 1, None),
                  (15, 1, None), (16, 1, 17)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        "pt_label": "re\u2019eh-{i}.txt",   # NOTE the curly apostrophe U+2019
        "pt_audio": "Reeh-{i}.mp3",
        "audio_slug": "reeh",
        "annual": [((11, 26), (12, 10)), ((12, 11), (12, 28)), ((12, 29), (13, 19)),
                   ((14, 1), (14, 21)), ((14, 22), (14, 29)), ((15, 1), (15, 18)),
                   ((15, 19), (16, 17))],
    },

    "shoftim": {
        "label": "Shoftim (Deuteronomy 16:18\u201321:9)",
        "sefaria_book": "Deuteronomy",
        "book": DEVARIM,
        "parashah": {"en": "Shoftim", "he": "\u05e9\u05c1\u05b9\u05e4\u05b0\u05d8\u05b4\u05d9\u05dd",
                     "translit": "Shoftim", "ref": "Deuteronomy 16:18\u201321:9"},
        "multiChapter": True,
        "ref": "Deuteronomy 16:18-21:9",
        "heRef": "\u05d3\u05d1\u05e8\u05d9\u05dd \u05d8\u05f4\u05d6:\u05d9\u05f4\u05d7-\u05db\u05f4\u05d0:\u05d8",
        "range": [(16, 18, None), (17, 1, None), (18, 1, None), (19, 1, None),
                  (20, 1, None), (21, 1, 9)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        "pt_label": "shoftim-{i}.txt",
        "pt_audio": "Shoftim-{i}.mp3",
        "audio_slug": "shoftim",
        "annual": [((16, 18), (17, 13)), ((17, 14), (17, 20)), ((18, 1), (18, 5)),
                   ((18, 6), (18, 13)), ((18, 14), (19, 13)), ((19, 14), (20, 9)),
                   ((20, 10), (21, 9))],
    },

    "kiteitzei": {
        "label": "Ki Teitzei (Deuteronomy 21:10\u201325:19)",
        "sefaria_book": "Deuteronomy",
        "book": DEVARIM,
        "parashah": {"en": "Ki Teitzei", "he": "\u05db\u05b4\u05bc\u05d9 \u05ea\u05b5\u05e6\u05b5\u05d0",
                     "translit": "Ki Teitzei", "ref": "Deuteronomy 21:10\u201325:19"},
        "multiChapter": True,
        "ref": "Deuteronomy 21:10-25:19",
        "heRef": "\u05d3\u05d1\u05e8\u05d9\u05dd \u05db\u05f4\u05d0:\u05d9-\u05db\u05f4\u05d4:\u05d9\u05f4\u05d8",
        "range": [(21, 10, None), (22, 1, None), (23, 1, None), (24, 1, None), (25, 1, 19)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        "pt_label": "Ki Teitzei-{i}.txt",
        "pt_audio": "KiTeitzei-{i}.mp3",
        "audio_slug": "kiteitzei",
        "annual": [((21, 10), (21, 21)), ((22, 1), (22, 7)), ((22, 8), (23, 7)),
                   ((23, 8), (23, 24)), ((23, 25), (24, 4)), ((24, 5), (24, 13)),
                   ((24, 14), (25, 19))],
    },

    "kitavo": {
        "label": "Ki Tavo (Deuteronomy 26:1\u201329:8)",
        "sefaria_book": "Deuteronomy",
        "book": DEVARIM,
        "parashah": {"en": "Ki Tavo", "he": "\u05db\u05b4\u05bc\u05d9 \u05ea\u05b8\u05d1\u05d5\u05b9\u05d0",
                     "translit": "Ki Tavo", "ref": "Deuteronomy 26:1\u201329:8"},
        "multiChapter": True,
        "ref": "Deuteronomy 26:1-29:8",
        "heRef": "\u05d3\u05d1\u05e8\u05d9\u05dd \u05db\u05f4\u05d5:\u05d0-\u05db\u05f4\u05d8:\u05d7",
        "range": [(26, 1, None), (27, 1, None), (28, 1, None), (29, 1, 8)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        "pt_label": "Ki Tavo-{i}.txt",
        "pt_audio": "KiTavo-{i}.mp3",
        "audio_slug": "kitavo",
        "annual": [((26, 1), (26, 11)), ((26, 12), (26, 15)), ((26, 16), (26, 19)),
                   ((27, 1), (27, 10)), ((27, 11), (28, 6)), ((28, 7), (28, 69)),
                   ((29, 1), (29, 8))],
    },

    "nitzavim": {
        "label": "Nitzavim (Deuteronomy 29:9\u201330:20)",
        "sefaria_book": "Deuteronomy",
        "book": DEVARIM,
        "parashah": {"en": "Nitzavim", "he": "\u05e0\u05b4\u05e6\u05b8\u05bc\u05d1\u05b4\u05d9\u05dd",
                     "translit": "Nitzavim", "ref": "Deuteronomy 29:9\u201330:20"},
        "multiChapter": True,
        "ref": "Deuteronomy 29:9-30:20",
        "heRef": "\u05d3\u05d1\u05e8\u05d9\u05dd \u05db\u05f4\u05d8:\u05d8-\u05dc\u05f3:\u05db",
        "range": [(29, 9, None), (30, 1, 20)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        # PocketTorah capitalises 1-6 but not 7 (see pt_name in build_reading.py).
        "pt_label": {"*": "Nitzavim-{i}.txt", 7: "nitzavim-{i}.txt"},
        "pt_audio": "Nitzavim-{i}.mp3",
        "audio_slug": "nitzavim",
        "annual": [((29, 9), (29, 11)), ((29, 12), (29, 14)), ((29, 15), (29, 28)),
                   ((30, 1), (30, 6)), ((30, 7), (30, 10)), ((30, 11), (30, 14)),
                   ((30, 15), (30, 20))],
    },

    "vayeilech": {
        "label": "Vayeilech (Deuteronomy 31:1\u201330)",
        "sefaria_book": "Deuteronomy",
        "book": DEVARIM,
        "parashah": {"en": "Vayeilech", "he": "\u05d5\u05b7\u05d9\u05b5\u05bc\u05dc\u05b6\u05da\u05b0",
                     "translit": "Vayeilech", "ref": "Deuteronomy 31:1\u201330"},
        "multiChapter": True,
        "ref": "Deuteronomy 31:1-30",
        "heRef": "\u05d3\u05d1\u05e8\u05d9\u05dd \u05dc\u05f4\u05d0:\u05d0-\u05dc",
        "range": [(31, 1, 30)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        "pt_label": "vayeilech-{i}.txt",
        "pt_audio": "Vayeilech-{i}.mp3",
        "audio_slug": "vayeilech",
        "annual": [((31, 1), (31, 3)), ((31, 4), (31, 6)), ((31, 7), (31, 9)),
                   ((31, 10), (31, 13)), ((31, 14), (31, 19)), ((31, 20), (31, 24)),
                   ((31, 25), (31, 30))],
    },

    "haazinu": {
        "label": "Ha'azinu (Deuteronomy 32:1\u201352)",
        "sefaria_book": "Deuteronomy",
        "book": DEVARIM,
        "parashah": {"en": "Ha'azinu", "he": "\u05d4\u05b7\u05d0\u05b2\u05d6\u05b4\u05d9\u05e0\u05d5\u05bc",
                     "translit": "Ha'azinu", "ref": "Deuteronomy 32:1\u201352"},
        "multiChapter": True,
        "ref": "Deuteronomy 32:1-52",
        "heRef": "\u05d3\u05d1\u05e8\u05d9\u05dd \u05dc\u05f4\u05d1:\u05d0-\u05e0\u05f4\u05d1",
        "range": [(32, 1, 52)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        "pt_label": "haazinu-{i}.txt",
        "pt_audio": "Haazinu-{i}.mp3",
        "audio_slug": "haazinu",
        # The Song of Moses is laid out in two columns, and the Masoretic text
        # splits its lines differently from the recording's word labels, so the
        # coach line is unreliable for most of chapter 32. (The splice index in
        # build_trope_index.py drops the verses that don't line up, so this can't
        # leak into the trope drills.)
        "note": "Ha'azinu is written as poetry in two columns, and the text splits "
                "its words differently from the recording, so the coach line is "
                "approximate through most of the song.",
        "annual": [((32, 1), (32, 6)), ((32, 7), (32, 12)), ((32, 13), (32, 18)),
                   ((32, 19), (32, 28)), ((32, 29), (32, 39)), ((32, 40), (32, 43)),
                   ((32, 44), (32, 52))],
    },

    "vezothaberakhah": {
        "label": "V'zot HaBerakhah (Deuteronomy 33:1\u201334:12)",
        "sefaria_book": "Deuteronomy",
        "book": DEVARIM,
        "parashah": {"en": "V'zot HaBerakhah",
                     "he": "\u05d5\u05b0\u05d6\u05b9\u05d0\u05ea \u05d4\u05b7\u05d1\u05b0\u05bc\u05e8\u05b8\u05db\u05b8\u05d4",
                     "translit": "V'zot HaBerakhah", "ref": "Deuteronomy 33:1\u201334:12"},
        "multiChapter": True,
        "ref": "Deuteronomy 33:1-34:12",
        "heRef": "\u05d3\u05d1\u05e8\u05d9\u05dd \u05dc\u05f4\u05d2:\u05d0-\u05dc\u05f4\u05d3:\u05d9\u05f4\u05d1",
        "range": [(33, 1, None), (34, 1, 12)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        "pt_label": "Vezot Haberakhah-{i}.txt",
        "pt_audio": "VezotHaberakhah-{i}.mp3",
        "audio_slug": "vezothaberakhah",
        "hebcal": "Vezot Haberakhah",
        "annual": [((33, 1), (33, 7)), ((33, 8), (33, 12)), ((33, 13), (33, 17)),
                   ((33, 18), (33, 21)), ((33, 22), (33, 26)), ((33, 27), (33, 29)),
                   ((34, 1), (34, 12))],
    },

    # ---- Outside Devarim: the homes of the four rarest accents ----------------
    # Shalshelet, Mercha Kefula, Yerach ben Yomo and Qarney Para occur nowhere in
    # Deuteronomy, so the trope drills had no recording to point at. These three
    # readings supply one: Shalshelet at Genesis 19:16, Mercha Kefula at Numbers
    # 32:42, and Yerach ben Yomo with Qarney Para at Numbers 35:5 — the only place
    # in the whole Torah either of the last two appears.

    "vayera": {
        "label": "Vayera (Genesis 18:1\u201322:24)",
        "sefaria_book": "Genesis",
        "book": BERESHIT,
        "parashah": {"en": "Vayera", "he": "\u05d5\u05b7\u05d9\u05b5\u05bc\u05e8\u05b8\u05d0",
                     "translit": "Vayera", "ref": "Genesis 18:1\u201322:24"},
        "multiChapter": True,
        "ref": "Genesis 18:1-22:24",
        "heRef": "\u05d1\u05e8\u05d0\u05e9\u05d9\u05ea \u05d9\u05f4\u05d7:\u05d0-\u05db\u05f4\u05d1:\u05db\u05f4\u05d3",
        "range": [(18, 1, None), (19, 1, None), (20, 1, None), (21, 1, None), (22, 1, 24)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        # PocketTorah lowercases only the first file here.
        "pt_label": {"*": "Vayera-{i}.txt", 1: "vayera-{i}.txt"},
        "pt_audio": "Vayera-{i}.mp3",
        "audio_slug": "vayera",
        "annual": [((18, 1), (18, 14)), ((18, 15), (18, 33)), ((19, 1), (19, 20)),
                   ((19, 21), (21, 4)), ((21, 5), (21, 21)), ((21, 22), (21, 34)),
                   ((22, 1), (22, 24))],
    },

    "matot": {
        "label": "Matot (Numbers 30:2\u201332:42)",
        "sefaria_book": "Numbers",
        "book": BAMIDBAR,
        "parashah": {"en": "Matot", "he": "\u05de\u05b7\u05d8\u05bc\u05d5\u05b9\u05ea",
                     "translit": "Matot", "ref": "Numbers 30:2\u201332:42"},
        "multiChapter": True,
        "ref": "Numbers 30:2-32:42",
        "heRef": "\u05d1\u05de\u05d3\u05d1\u05e8 \u05dc\u05f3:\u05d1-\u05dc\u05f4\u05d1:\u05de\u05f4\u05d1",
        "range": [(30, 2, None), (31, 1, None), (32, 1, 42)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        "pt_label": "matot-{i}.txt",
        "pt_audio": "Matot-{i}.mp3",
        "audio_slug": "matot",
        "annual": [((30, 2), (30, 17)), ((31, 1), (31, 12)), ((31, 13), (31, 24)),
                   ((31, 25), (31, 41)), ((31, 42), (31, 54)), ((32, 1), (32, 19)),
                   ((32, 20), (32, 42))],
    },

    "masei": {
        "label": "Masei (Numbers 33:1\u201336:13)",
        "sefaria_book": "Numbers",
        "book": BAMIDBAR,
        "parashah": {"en": "Masei", "he": "\u05de\u05b7\u05e1\u05b0\u05e2\u05b5\u05d9",
                     "translit": "Masei", "ref": "Numbers 33:1\u201336:13"},
        "multiChapter": True,
        "ref": "Numbers 33:1-36:13",
        "heRef": "\u05d1\u05de\u05d3\u05d1\u05e8 \u05dc\u05f4\u05d2:\u05d0-\u05dc\u05f4\u05d5:\u05d9\u05f4\u05d2",
        "range": [(33, 1, None), (34, 1, None), (35, 1, None), (36, 1, 13)],
        "pt_files": [1, 2, 3, 4, 5, 6, 7],
        "pt_label": "masei-{i}.txt",
        "pt_audio": "Masei-{i}.mp3",
        "audio_slug": "masei",
        "annual": [((33, 1), (33, 10)), ((33, 11), (33, 49)), ((33, 50), (34, 15)),
                   ((34, 16), (34, 29)), ((35, 1), (35, 8)), ((35, 9), (35, 34)),
                   ((36, 1), (36, 13))],
    },

    # ---- TEMPLATE: copy, fill in, run `build_reading.py <slug>` ---------------
    # "slug": {
    #     "label": "Name (Book c:v\u2013c:v)",
    #     "sefaria_book": "Deuteronomy",
    #     "book": {"en": "Deuteronomy", "he": "\u05d3\u05d1\u05e8\u05d9\u05dd", "translit": "Devarim"},
    #     "parashah": {"en": "Name", "he": "...", "translit": "Name", "ref": "Book c:v\u2013c:v"},
    #     "multiChapter": True,
    #     "ref": "Book c:v-c:v",
    #     "heRef": "...",
    #     "range": [(c, v0, None), (c+1, 1, vN)],
    #     "pt_files": [1, 2, 3, 4, 5, 6, 7],
    #     "pt_label": "name-{i}.txt",   # <-- verify exact name in the PocketTorah repo
    #     "pt_audio": "Name-{i}.mp3",   # <-- verify exact name
    #     "audio_slug": "name",
    #     # Aliyot (annual + triennial + maftir) are fetched from Hebcal by
    #     # parashah name; no need to type them. "annual" is an OFFLINE FALLBACK
    #     # only. Add "hebcal": "ExactHebcalName" if the parashah.en auto-match
    #     # fails (e.g. a combined parashah).
    #     "annual": [((c, v0), (c, vE)), ...],
    # },
    #
    # ---- MULTIPLE VOICES (audio sources) --------------------------------------
    # To offer more than one recorded voice for a reading, replace the top-level
    # pt_* fields above with a `sources` list. The FIRST source (or the one with
    # "default": True) uses the original unsuffixed data files; others use
    # `_<id>`-suffixed files and audio under audio/<id>/. Each source aligns its
    # own word onsets and gets its own extracted pitch/shapes (so the coach line,
    # spectrogram and scoring match that voice). Two source kinds:
    #
    #   "kind": "pockettorah"  -> fetches labels + MP3s from the PocketTorah repo
    #                             (fields: pt_files, pt_label, pt_audio, audio_slug)
    #   "kind": "local"        -> drop-in for audio you host yourself (e.g. a
    #                             licensed recording once you have permission).
    #                             Provide MP3s at audio/<id>/<audio_slug>-<i>.mp3
    #                             and comma-separated word-onset tracks at
    #                             data/local_sources/<id>/<pt_label>. No download.
    #
    # "slug": {
    #     ... text fields (label, sefaria_book, range, annual, ...) ...
    #     "sources": [
    #         {"id": "pockettorah", "label": "PocketTorah (Neiss & Schwartz)",
    #          "default": True, "kind": "pockettorah",
    #          "pt_files": [1, 2, 3, 4, 5, 6, 7], "pt_label": "name-{i}.txt",
    #          "pt_audio": "Name-{i}.mp3", "audio_slug": "name",
    #          "source_url": "https://pockettorah.com",
    #          "license": "PocketTorah audio & timing metadata, CC-BY-SA.",
    #          "attribution": "Recorded chanting courtesy of PocketTorah (Neiss & Schwartz), CC-BY-SA."},
    #         {"id": "reader2", "label": "Reader 2", "kind": "local",
    #          "pt_files": [1, 2, 3, 4, 5, 6, 7], "pt_label": "name-{i}.txt",
    #          "audio_slug": "name",
    #          "source_url": "https://example.org",
    #          "license": "Used with permission.",
    #          "attribution": "Recorded chanting courtesy of Reader 2."},
    #     ],
    # },
}
