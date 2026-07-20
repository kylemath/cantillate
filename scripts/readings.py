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
