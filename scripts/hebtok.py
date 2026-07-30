#!/usr/bin/env python3
"""The app's word tokenizer (js/hebrew.js), in Python.

Word onsets are 1:1 with these tokens, so anything that builds or checks an
onset track has to split exactly the way the browser does. Keeping the two
copies in one place is the only way that stays true.
"""
import re

MAQAF = "\u05be"
PASEQ = "\u05c0"

MARKUP = re.compile(r"<[^>]*>|&[#a-zA-Z0-9]+;")
SECTION = re.compile(r"\{[^}]*\}")                       # {ס} {פ} section markers
KETIV_NOTE = re.compile(r"<span[^>]*\bmam-kq-k\b[^>]*>[\s\S]*?</span>", re.I)
FOOTNOTE = re.compile(r"<i[^>]*\bfootnote\b[^>]*>[\s\S]*?</i>", re.I)
SPLIT_RE = re.compile(f"([{MAQAF}{PASEQ}])")

# Cantillation, meteg and the sof-pasuk colon: written, never their own sound.
CANTILLATION = re.compile(r"[\u0591-\u05AF\u05BD\u05C3\u05C6]")


def tokenize(verse_text):
    cleaned = SECTION.sub(" ", MARKUP.sub("", FOOTNOTE.sub("", KETIV_NOTE.sub("", verse_text))))
    out = []
    for w in cleaned.split():
        cur = ""
        for s in SPLIT_RE.split(w):
            if s == "":
                continue
            if s in (MAQAF, PASEQ):
                if cur:
                    out.append(cur + s)
                    cur = ""
            else:
                if cur:
                    out.append(cur)
                cur = s
        if cur:
            out.append(cur)
    return out


def speakable(token):
    """A token as a text-to-speech engine should read it: consonants and nikud,
    with the cantillation and the joiners taken off."""
    return CANTILLATION.sub("", token).replace(MAQAF, "").replace(PASEQ, "").strip()
