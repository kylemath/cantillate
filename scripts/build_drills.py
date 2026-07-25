#!/usr/bin/env python3
"""Generate data/trope-drills.json — the synthetic te'amim exercise set.

The parashah readings teach a tune by imitation: you hear the cantor and copy
him. That never teaches you to *read* the accents, because the melody always
arrives before the mark does. These drills invert it.

Two long practice pesukim, each built from ONE Hebrew root, so the syllables stay
familiar and the only thing changing from word to word is the trope. The accents
are not listed tier by tier — they run in the orders you actually meet them in,
each pause approached by the connectors that serve it (Qadma→Azla, Mahpach→
Pashta→Munach→Zaqef, Darga→Tevir, Mercha→Tipcha→Munach→Etnachta), and each verse
divides at the Etnachta like a real one. Word lengths are varied so the line has
some rhythm and the ornate accents get the syllables they need to unfold.

  1. The everyday progression — root ש־ל־ם, the accents in almost every verse.
  2. The rare flourishes     — root ד־ב־ר, everything else, down to the two
                               accents that occur once each in the Torah.

Both are long on purpose: use the "Divide" control on the sections stage to take
them in halves or thirds before chanting one end to end.

There is no recording. The coach line is synthesized from the motifs in
js/trope.js (see buildSyntheticCoach in js/app.js), which is exactly what these
lines are meant to teach.

Run:  python3 scripts/build_drills.py
"""
import json
import os
import unicodedata

OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'trope-drills.json')

# --- Cantillation marks (Unicode combining accents) -------------------------
ETNACHTA, SEGOL, SHALSHELET = '\u0591', '\u0592', '\u0593'
ZAQEF_QATAN, ZAQEF_GADOL, TIPCHA = '\u0594', '\u0595', '\u0596'
REVIA, PASHTA, YETIV, TEVIR = '\u0597', '\u0599', '\u059A', '\u059B'
# The Masoretic text encodes the ordinary Zarqa as U+05AE (named "Zinor" in
# Unicode); U+0598 is the rarer Tsinnorit variant. Drill the one that actually
# appears in the readings — see the coverage check in scripts/smoke.html.
ZARQA, TSINNORIT = '\u05AE', '\u0598'
GERESH, GERSHAYIM, QARNEY_PARA = '\u059C', '\u059E', '\u059F'
TELISHA_GEDOLA, PAZER = '\u05A0', '\u05A1'
MUNACH, MAHPACH, MERCHA, MERCHA_KEFULA = '\u05A3', '\u05A4', '\u05A5', '\u05A6'
DARGA, QADMA, TELISHA_QETANA, YERACH = '\u05A7', '\u05A8', '\u05A9', '\u05AA'
SILLUQ = '\u05BD'          # meteg glyph, used for silluq on the last word
SOF_PASUK = '\u05C3'       # ׃

# English names, for the per-line "trope order" gloss.
NAMES = {
    ETNACHTA: 'Etnachta', SEGOL: 'Segol', SHALSHELET: 'Shalshelet',
    ZAQEF_QATAN: 'Zaqef Qatan', ZAQEF_GADOL: 'Zaqef Gadol', TIPCHA: 'Tipcha',
    REVIA: 'Revia', ZARQA: 'Zarqa', PASHTA: 'Pashta', YETIV: 'Yetiv', TEVIR: 'Tevir',
    TSINNORIT: 'Tsinnorit', GERESH: 'Azla (Geresh)', GERSHAYIM: 'Gershayim',
    QARNEY_PARA: 'Qarney Para',
    TELISHA_GEDOLA: 'Telisha Gedola', PAZER: 'Pazer',
    MUNACH: 'Munach', MAHPACH: 'Mahpach', MERCHA: 'Mercha',
    MERCHA_KEFULA: 'Mercha Kefula', DARGA: 'Darga', QADMA: 'Qadma',
    TELISHA_QETANA: 'Telisha Qetana', YERACH: 'Yerach ben Yomo',
    SILLUQ: 'Silluq (Sof Pasuk)',
}

# Accents whose position is fixed by their name rather than by the stress:
# postpositive marks sit on the word's LAST letter, prepositive on its FIRST.
POSTPOSITIVE = {SEGOL, ZARQA, TSINNORIT, PASHTA, TELISHA_QETANA}
PREPOSITIVE = {YETIV, TELISHA_GEDOLA}

# --- Word families ----------------------------------------------------------
# Two roots, inflected every way that keeps the sound recognisable. `stress` is
# the ORDINAL of the Hebrew letter that opens the stressed syllable (1-based),
# which is where the accent goes; `syl` is only used to sanity-check the rhythm.
WORDS = {
    # ש־ל־ם — peace, wholeness, requital
    'shalom':   ('\u05E9\u05C1\u05B8\u05DC\u05D5\u05B9\u05DD', 2, 'sha-LOM', 'peace', 2),
    'shalem':   ('\u05E9\u05C1\u05B8\u05DC\u05B5\u05DD', 2, 'sha-LEM', 'whole', 2),
    'shilem':   ('\u05E9\u05C1\u05B4\u05DC\u05BC\u05B5\u05DD', 2, 'shil-LEM', 'he repaid', 2),
    'shlomo':   ('\u05E9\u05C1\u05B0\u05DC\u05B9\u05DE\u05B9\u05D4', 3, 'shlo-MO', 'Solomon', 2),
    'shlomoh':  ('\u05E9\u05C1\u05B0\u05DC\u05D5\u05B9\u05DE\u05D5\u05B9', 4, 'shlo-MO', 'his peace', 2),
    'shlomam':  ('\u05E9\u05C1\u05B0\u05DC\u05D5\u05B9\u05DE\u05B8\u05DD', 4, 'shlo-MAM', 'their peace', 2),
    'meshulam': ('\u05DE\u05B0\u05E9\u05C1\u05BB\u05DC\u05BC\u05B8\u05DD', 3, 'me-shul-LAM', 'requited', 3),
    'shilumim': ('\u05E9\u05C1\u05B4\u05DC\u05BC\u05D5\u05BC\u05DE\u05B4\u05D9\u05DD', 4, 'shil-lu-MIM', 'recompense', 3),
    'hashalom': ('\u05D4\u05B7\u05E9\u05BC\u05C1\u05B8\u05DC\u05D5\u05B9\u05DD', 3, 'ha-sha-LOM', 'the peace', 3),

    # ד־ב־ר — word, speaking, wilderness, plague
    'davar':     ('\u05D3\u05BC\u05B8\u05D1\u05B8\u05E8', 2, 'da-VAR', 'a word, a thing', 2),
    'diber':     ('\u05D3\u05BC\u05B4\u05D1\u05BC\u05B5\u05E8', 2, 'dib-BER', 'he spoke', 2),
    'dever':     ('\u05D3\u05BC\u05B6\u05D1\u05B6\u05E8', 1, 'DE-ver', 'plague', 2),
    'devarim':   ('\u05D3\u05BC\u05B0\u05D1\u05B8\u05E8\u05B4\u05D9\u05DD', 3, 'dva-RIM', 'words', 2),
    'midbar':    ('\u05DE\u05B4\u05D3\u05B0\u05D1\u05BC\u05B8\u05E8', 3, 'mid-BAR', 'wilderness', 2),
    'hadevarim': ('\u05D4\u05B7\u05D3\u05BC\u05B0\u05D1\u05B8\u05E8\u05B4\u05D9\u05DD', 4, 'ha-dva-RIM', 'the words', 3),
    'vaydaber':  ('\u05D5\u05B7\u05D9\u05B0\u05D3\u05B7\u05D1\u05BC\u05B5\u05E8', 4, 'vay-dab-BER', 'and he spoke', 3),
    'divreihem': ('\u05D3\u05BC\u05B4\u05D1\u05B0\u05E8\u05B5\u05D9\u05D4\u05B6\u05DD', 5, 'div-rei-HEM', 'their words', 3),
    'medabrim':  ('\u05DE\u05B0\u05D3\u05B7\u05D1\u05BC\u05B0\u05E8\u05B4\u05D9\u05DD', 4, 'me-dab-RIM', 'speaking', 3),
    'uvamidbar': ('\u05D5\u05BC\u05D1\u05B7\u05DE\u05BC\u05B4\u05D3\u05B0\u05D1\u05BC\u05B8\u05E8', 5, 'u-va-mid-BAR', 'and in the wilderness', 4),
    'kidvarkha': ('\u05DB\u05BC\u05B4\u05D3\u05B0\u05D1\u05B8\u05E8\u05B0\u05DA\u05B8', 4, 'kid-var-KHA', 'as your word', 3),
}


def is_letter(ch):
    return '\u05D0' <= ch <= '\u05EA'


def after_letter(word, ordinal):
    """Index just past the n-th (1-based) Hebrew letter and the points on it.

    Placing an accent here puts it on the stressed syllable, after that
    syllable's vowel — the position the Masoretic text uses.
    """
    seen = 0
    for i, ch in enumerate(word):
        if not is_letter(ch):
            continue
        seen += 1
        if seen == ordinal:
            j = i + 1
            while j < len(word) and not is_letter(word[j]):
                j += 1
            return j
    return len(word)


def mark(key, accent, final=False):
    """Place `accent` on a word, honouring pre/postpositive placement."""
    text, stress = WORDS[key][0], WORDS[key][1]
    if accent in POSTPOSITIVE:
        out = text + accent
    elif accent in PREPOSITIVE:
        out = text[:after_letter(text, 1)] + accent + text[after_letter(text, 1):]
    else:
        i = after_letter(text, stress)
        out = text[:i] + accent + text[i:]
    if final:
        out += SOF_PASUK
    # Canonical ordering puts each vowel before the accent that follows it, which
    # is how the marks are stored in the Masoretic text the app renders.
    return unicodedata.normalize('NFC', out)


# --- The two practice pesukim ----------------------------------------------
# (accent, word). The last entry closes the verse, so it takes the Silluq and the
# Sof Pasuk — buildLineMelody in js/trope.js treats a verse's final word that way
# regardless, and these line up with it.

EVERYDAY = [
    # First half — subdivided from the weakest pause up to the Etnachta.
    (QADMA, 'shalem'), (GERESH, 'meshulam'),
    (MUNACH, 'shilem'), (REVIA, 'shilumim'),
    (MAHPACH, 'shalom'), (PASHTA, 'shalem'), (MUNACH, 'shilem'), (ZAQEF_QATAN, 'hashalom'),
    (MERCHA, 'shlomo'), (TIPCHA, 'shlomoh'), (MUNACH, 'shalem'), (ETNACHTA, 'meshulam'),
    # Second half — the same shape again, closing on the Silluq.
    (MUNACH, 'shilem'), (ZAQEF_QATAN, 'shlomam'),
    (DARGA, 'shalom'), (TEVIR, 'shalem'),
    (MERCHA, 'shlomo'), (TIPCHA, 'shlomoh'), (MERCHA, 'shalom'), (SILLUQ, 'hashalom'),
]

RARE = [
    # Shalshelet only ever opens a verse, in place of a Segol.
    (SHALSHELET, 'hadevarim'),
    # Tsinnorit next to Zarqa on purpose: the two marks look alike and Unicode
    # keeps them apart, so the drill puts them where you can compare the glyphs.
    (MUNACH, 'davar'), (TSINNORIT, 'devarim'), (ZARQA, 'divreihem'),
    (MUNACH, 'diber'), (SEGOL, 'uvamidbar'),
    (TELISHA_GEDOLA, 'medabrim'), (MUNACH, 'davar'), (PAZER, 'hadevarim'),
    (TELISHA_QETANA, 'devarim'), (GERSHAYIM, 'divreihem'),
    (MUNACH, 'dever'), (REVIA, 'vaydaber'),
    (YETIV, 'midbar'), (ZAQEF_GADOL, 'kidvarkha'),
    (MERCHA_KEFULA, 'devarim'), (TEVIR, 'diber'),
    (MERCHA, 'davar'), (TIPCHA, 'midbar'), (MUNACH, 'diber'), (ETNACHTA, 'hadevarim'),
    # Yerach ben Yomo and Qarney Para occur once each in the whole Torah
    # (Numbers 35:5), always in that order.
    (YERACH, 'medabrim'), (QARNEY_PARA, 'uvamidbar'),
    (MERCHA, 'davar'), (TIPCHA, 'midbar'), (MERCHA, 'diber'), (SILLUQ, 'hadevarim'),
]

LESSONS = [
    {
        'title': 'The everyday progression',
        'root': '\u05E9\u05BE\u05DC\u05BE\u05DD',
        'ref': 'shalom',
        'seq': EVERYDAY,
        'note': 'One root, ש־ל־ם, in every form: shalom (peace), shalem (whole), '
                'shilem (he repaid), Shlomo, meshulam (requited), shilumim (recompense). '
                'The accents run in the order you actually meet them: each pause arrives '
                'with the connectors that serve it, and the verse divides at the Etnachta '
                'like a real one. Long on purpose \u2014 use Divide on the sections stage to '
                'take it in halves first.',
    },
    {
        'title': 'The rare flourishes',
        'root': '\u05D3\u05BE\u05D1\u05BE\u05E8',
        'ref': 'davar',
        'seq': RARE,
        'note': 'The same idea on ד־ב־ר: davar (a word), diber (he spoke), dever (plague), '
                'midbar (wilderness). This one carries everything the first verse leaves out '
                '\u2014 Shalshelet opening the verse, the Zarqa\u2013Segol pair, both Telishot, '
                'Pazer, Gershayim, Yetiv, Zaqef Gadol, Mercha Kefula, and the Yerach ben Yomo '
                'with Qarney Para that appear once each in the entire Torah. Note the Zarqa: '
                'Unicode splits it across two marks, and this is the one the Torah text uses.',
    },
]


def build():
    verses, groups = [], []
    for i, lesson in enumerate(LESSONS, start=1):
        seq = lesson['seq']
        words = [mark(key, accent, final=(j == len(seq) - 1))
                 for j, (accent, key) in enumerate(seq)]
        order = ' \u00b7 '.join(NAMES[accent] for accent, _ in seq)
        verses.append({
            'n': i,
            'label': lesson['root'],
            'ref': lesson['ref'],
            'text': ' '.join(words),
            'en': f'Trope order \u2014 {order}',
        })
        groups.append({'title': f'{i} \u00b7 {lesson["title"]}', 'note': lesson['note'],
                       'start': i, 'end': i})

    data = {
        'slug': 'trope-drills',
        'book': {'en': 'Trope drills', 'he': '\u05EA\u05B7\u05E8\u05B0\u05D2\u05B4\u05D9\u05DC', 'translit': 'Targil'},
        'multiChapter': False,
        'chapter': None,
        'synthetic': True,
        'ref': 'Cantillation drills',
        'heRef': '\u05EA\u05B7\u05E8\u05B0\u05D2\u05B4\u05D9\u05DC\u05B5\u05D9 \u05D8\u05B0\u05E2\u05B8\u05DE\u05B4\u05D9\u05DD',
        'versionTitle': 'Cantillate practice drills',
        'heVersionTitle': 'Synthesized practice drills (no recording)',
        'license': 'CC0',
        'parashah': {
            'en': 'Trope drills',
            'he': '\u05EA\u05B7\u05E8\u05B0\u05D2\u05B4\u05D9\u05DC\u05B5\u05D9 \u05D8\u05B0\u05E2\u05B8\u05DE\u05B4\u05D9\u05DD',
            'translit': "Targilei Te'amim",
            'ref': 'One root, every accent',
        },
        'groups': groups,
        'verses': verses,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    covered = {a for lesson in LESSONS for a, _ in lesson['seq']}
    missing = sorted(NAMES[a] for a in set(NAMES) - covered)
    print(f'wrote {OUT}: {len(verses)} practice pesukim, '
          f'{sum(len(l["seq"]) for l in LESSONS)} words, {len(covered)} distinct accents')
    if missing:
        print('  not covered:', ', '.join(missing))


if __name__ == '__main__':
    build()
