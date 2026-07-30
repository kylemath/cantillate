#!/usr/bin/env python3
"""Readings taught by a recording someone made themselves.

The shipped corpus can only cover what somebody published: the 54 parashiyot and
the 54 haftarot, all chanted by PocketTorah. A reader whose passage is neither —
and a bar mitzvah passage often is neither — gets the text and a coach line
synthesized from the measured trope shapes, which teaches the accents but is not
a human being chanting. When a teacher records the actual pesukim, that gap
closes, and this is where such a reading is declared.

The recording needs word onsets, which no one ships with a phone recording:

    .venv/bin/python scripts/align_recording.py \\
        --audio audio/<id>/<audio_slug>-H.m4a \\
        --book <corpus slug> --range <c:v-c:v> --id <id> --out <pt_label>
    ./serve.sh 8123    # then check them by ear in scripts/label.html
    .venv/bin/python scripts/build_reading.py <slug>

Everything else — text, English, the coach line, the spectrogram, per-word
playback, the trope drills — is then built from the recording exactly as it is
for a published one.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tanakh                                        # noqa: E402


def nevi_im_passage(book_en, spans, label, sources, note=None):
    """A passage from Nevi'im chanted straight through in haftarah trope.

    Filed as `kind: "haftarah"` because that is how it is read and how the app
    should teach it: one chunk, no aliyot, haftarah melody. It carries no
    parashah, so the menu lists it after the weekly haftarot.
    """
    b = tanakh.book(book_en)
    cfg = {
        "kind": "haftarah",
        "tropeStyle": "haftarah",
        "label": label,
        "spans": spans,
        "sefaria_book": b["en"],
        "wlc_book": b["wlc"],
        "book": {"en": b["en"], "he": b["he"], "translit": b["translit"]},
        "multiChapter": True,
        "sources": sources,
    }
    if note:
        cfg["note"] = note
    return cfg


REGISTRY = {
    # The woman of Ein Dor: Saul, disguised, has a medium call Samuel up from the
    # dead the night before he dies at Gilboa. Not the haftarah of any week, so
    # nobody has recorded it — until his teacher did.
    "i-samuel-28": nevi_im_passage(
        "I Samuel",
        [((28, 8), (28, 19))],
        "I Samuel 28:8\u201319 \u00b7 the woman of Ein Dor",
        [{
            "id": "teacher",
            "label": "Teacher's recording",
            "default": True,
            "kind": "local",
            "pt_files": ["H"],
            "pt_label": "i-samuel-28.txt",
            "audio_slug": "i-samuel-28",
            "ext": "m4a",
            "license": "Recorded for this reader's own study and included with the "
                       "teacher's permission.",
            "attribution": "Chanted by his teacher.",
        }],
    ),
}
