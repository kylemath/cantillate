#!/usr/bin/env python3
"""Generate data/trope-drills.json — the synthetic te'amim exercise set.

The parashah readings teach a tune by imitation: you hear the cantor and copy
him. That never teaches you to *read* the accents, because the melody always
arrives before the mark does. These drills invert it.

Two levels, each built from pairs of long pesukim carrying EVERY accent that
occurs in the Torah readings:

  1. ש־ל־ם / ס־ל־ם and ד־ב־ר, in two presentations. First as sentences, with the
     rare accents dealt through both: the pair hangs
     together as a playful poem: Solomon, wearing a salmah, repeats ideas spoken
     by dvorim in the midbar and climbs a sulam; then Dvorah answers the dvorim
     with dvash rather than dever. True inflections (shalem, vayishalem,
     venishlam, hishlimah) rub against near-homonyms (Shlomo/salmah/sulam and
     devarim/dvorim/Dvorah/dvash/dever). The pauses land where the sense pauses,
     and a Shalshelet or a Qarney Para turns up inside an ordinary phrase rather
     than being announced. Then as sorted word lists: one root per pasuk, the
     everyday accents in the first and the rare ones in the second.
  2. ה־ל־ך and ק־צ־ר, for harder consonants. Lalekhet, halakh, melekh, derekh,
     mahalakh, and halikhah keep final and medial khaf moving; qatsar (reaped),
     qatsar (short), qotser (reaper), qotser (shortness), qitser (shortened),
     and qetser (short circuit) make qof–tsadi–resh depend on the vowels. Chet
     joins the contrast in ruach. The result is a second poem about a king,
     walkers, reapers, a short road, and a long procession.

The accents are not listed tier by tier — they run in the orders you actually
meet them, each pause approached by the connectors that serve it (Qadma→Azla,
Mahpach→Pashta→Munach→Zaqef, Darga→Tevir, Mercha→Tipcha→Munach→Etnachta), and
each pasuk divides at the Etnachta like a real one. Every lesson reaches the two
accents that occur once each in the whole Torah.

They are all long on purpose: use the "Divide" control on the sections stage to
take one in halves or thirds before chanting it end to end.

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

# --- The vocabulary ---------------------------------------------------------
# `stress` is the ORDINAL of the Hebrew letter that opens the stressed syllable
# (1-based), which is where the accent goes.

# Inflections of the two roots. All appear somewhere in the exercise set —
# build() fails loudly if one does not, so a rewrite cannot quietly thin out the
# family it is meant to drill.
ROOT_WORDS = {
    # ש־ל־ם — peace, wholeness, completion, requital
    'shalom':   ('\u05E9\u05C1\u05B8\u05DC\u05D5\u05B9\u05DD', 2, 'sha-LOM', 'peace'),
    'shalem':   ('\u05E9\u05C1\u05B8\u05DC\u05B5\u05DD', 2, 'sha-LEM', 'whole'),
    'shilem':   ('\u05E9\u05C1\u05B4\u05DC\u05BC\u05B5\u05DD', 2, 'shil-LEM', 'he repaid'),
    'shlomo':   ('\u05E9\u05C1\u05B0\u05DC\u05B9\u05DE\u05B9\u05D4', 3, 'shlo-MO', 'Solomon'),
    'shlomoh':  ('\u05E9\u05C1\u05B0\u05DC\u05D5\u05B9\u05DE\u05D5\u05B9', 4, 'shlo-MO', 'his peace'),
    'shlomam':  ('\u05E9\u05C1\u05B0\u05DC\u05D5\u05B9\u05DE\u05B8\u05DD', 4, 'shlo-MAM', 'their peace'),
    'meshulam': ('\u05DE\u05B0\u05E9\u05C1\u05BB\u05DC\u05BC\u05B8\u05DD', 3, 'me-shul-LAM', 'requited'),
    'shilumim': ('\u05E9\u05C1\u05B4\u05DC\u05BC\u05D5\u05BC\u05DE\u05B4\u05D9\u05DD', 4, 'shil-lu-MIM', 'recompense'),
    'hashalom': ('\u05D4\u05B7\u05E9\u05BC\u05C1\u05B8\u05DC\u05D5\u05B9\u05DD', 3, 'ha-sha-LOM', 'the peace'),
    'bishlemut': ('\u05D1\u05BC\u05B4\u05E9\u05C1\u05B0\u05DC\u05B5\u05DE\u05D5\u05BC\u05EA', 4, 'bish-le-MUT', 'in wholeness'),
    'vayishalem': ('\u05D5\u05B7\u05D9\u05B0\u05E9\u05C1\u05B7\u05DC\u05BC\u05B5\u05DD', 4, 'vay-sha-LEM', 'and he paid'),
    'tashlum':  ('\u05EA\u05BC\u05B7\u05E9\u05C1\u05B0\u05DC\u05D5\u05BC\u05DD', 3, 'tash-LUM', 'a payment'),
    'lishlomam': ('\u05DC\u05B4\u05E9\u05C1\u05B0\u05DC\u05D5\u05B9\u05DE\u05B8\u05DD', 5, 'lish-lo-MAM', 'for their welfare'),
    'venishlam': ('\u05D5\u05B0\u05E0\u05B4\u05E9\u05C1\u05B0\u05DC\u05B7\u05DD', 4, 've-nish-LAM', 'and was fulfilled'),
    'mushlam':  ('\u05DE\u05BB\u05E9\u05C1\u05B0\u05DC\u05B8\u05DD', 3, 'mush-LAM', 'perfect'),
    'hishlima': ('\u05D4\u05B4\u05E9\u05C1\u05B0\u05DC\u05B4\u05D9\u05DE\u05B8\u05D4', 5, 'hish-li-MA', 'she completed'),
    'shlemut':  ('\u05E9\u05C1\u05B0\u05DC\u05B5\u05DE\u05D5\u05BC\u05EA', 3, 'shle-MUT', 'wholeness'),
    'hishlimu': ('\u05D4\u05B4\u05E9\u05C1\u05B0\u05DC\u05B4\u05D9\u05DE\u05D5\u05BC', 3, 'hish-LI-mu', 'they completed'),

    # ד־ב־ר — word/idea/thing, speaking, wilderness, plague
    'davar':     ('\u05D3\u05BC\u05B8\u05D1\u05B8\u05E8', 2, 'da-VAR', 'a word, a thing'),
    'diber':     ('\u05D3\u05BC\u05B4\u05D1\u05BC\u05B5\u05E8', 2, 'dib-BER', 'he spoke'),
    'dibru':     ('\u05D3\u05BC\u05B4\u05D1\u05BC\u05B0\u05E8\u05D5\u05BC', 3, 'dib-RU', 'they spoke'),
    'dever':     ('\u05D3\u05BC\u05B6\u05D1\u05B6\u05E8', 1, 'DE-ver', 'plague'),
    'devarim':   ('\u05D3\u05BC\u05B0\u05D1\u05B8\u05E8\u05B4\u05D9\u05DD', 3, 'dva-RIM', 'words, ideas, things'),
    'divrei':    ('\u05D3\u05BC\u05B4\u05D1\u05B0\u05E8\u05B5\u05D9', 3, 'div-REI', 'words of'),
    'midbar':    ('\u05DE\u05B4\u05D3\u05B0\u05D1\u05BC\u05B8\u05E8', 3, 'mid-BAR', 'wilderness'),
    'bamidbar':  ('\u05D1\u05BC\u05B7\u05DE\u05BC\u05B4\u05D3\u05B0\u05D1\u05BC\u05B8\u05E8', 4, 'ba-mid-BAR', 'in the wilderness'),
    'hadevarim': ('\u05D4\u05B7\u05D3\u05BC\u05B0\u05D1\u05B8\u05E8\u05B4\u05D9\u05DD', 4, 'ha-dva-RIM', 'the words'),
    'vaydaber':  ('\u05D5\u05B7\u05D9\u05B0\u05D3\u05B7\u05D1\u05BC\u05B5\u05E8', 4, 'vay-dab-BER', 'and he spoke'),
    'divreihem': ('\u05D3\u05BC\u05B4\u05D1\u05B0\u05E8\u05B5\u05D9\u05D4\u05B6\u05DD', 5, 'div-rei-HEM', 'their words'),
    'medabrim':  ('\u05DE\u05B0\u05D3\u05B7\u05D1\u05BC\u05B0\u05E8\u05B4\u05D9\u05DD', 4, 'me-dab-RIM', 'speaking'),
    'uvamidbar': ('\u05D5\u05BC\u05D1\u05B7\u05DE\u05BC\u05B4\u05D3\u05B0\u05D1\u05BC\u05B8\u05E8', 5, 'u-va-mid-BAR', 'and in the wilderness'),
    'kidvarkha': ('\u05DB\u05BC\u05B4\u05D3\u05B0\u05D1\u05B8\u05E8\u05B0\u05DA\u05B8', 5, 'kid-var-KHA', 'as your word'),
    'dvaro':     ('\u05D3\u05BC\u05B0\u05D1\u05B8\u05E8\u05D5\u05B9', 3, 'dva-RO', 'his word'),
    'dibra':     ('\u05D3\u05BC\u05B4\u05D1\u05BC\u05B0\u05E8\u05B8\u05D4', 3, 'dib-RA', 'she spoke'),
    'kidvarah':  ('\u05DB\u05BC\u05B4\u05D3\u05B0\u05D1\u05B8\u05E8\u05B8\u05D4\u05BC', 4, 'kid-va-RA', 'as she said'),
}

# Near-homonyms and spelling echoes. These are deliberately NOT described as
# forms of the roots: the point is to make the eye distinguish shin from sin
# from samekh, and qamatz from holam, while the ear hears a tight family of
# sounds. The poem supplies enough sense to make the puns memorable.
WORDPLAY_WORDS = {
    'besalmah': ('\u05D1\u05BC\u05B0\u05E9\u05C2\u05B7\u05DC\u05B0\u05DE\u05B8\u05D4', 4, 'be-sal-MA', 'in a robe'),
    'basulam':  ('\u05D1\u05BC\u05B7\u05E1\u05BC\u05BB\u05DC\u05BC\u05B8\u05DD', 3, 'ba-su-LAM', 'on the ladder'),
    'sulam':    ('\u05E1\u05BB\u05DC\u05BC\u05B8\u05DD', 2, 'su-LAM', 'a ladder'),
    'uvasulam': ('\u05D5\u05BC\u05D1\u05B7\u05E1\u05BC\u05BB\u05DC\u05BC\u05B8\u05DD', 4, 'u-va-su-LAM', 'and on the ladder'),
    'dvorim':   ('\u05D3\u05BC\u05B0\u05D1\u05D5\u05B9\u05E8\u05B4\u05D9\u05DD', 4, 'dvo-RIM', 'bees'),
    'dvorah':   ('\u05D3\u05BC\u05B0\u05D1\u05D5\u05B9\u05E8\u05B8\u05D4', 4, 'dvo-RA', 'Deborah'),
    'dvash':    ('\u05D3\u05BC\u05B0\u05D1\u05B7\u05E9\u05C1', 2, 'd-VASH', 'honey'),
}

# Level 2: hard kh/chet, qof, tzadi, and resh. The ק־צ־ר entries deliberately
# include both root relatives and exact-consonant homographs: the vowels alone
# distinguish reaping, shortness, shortening, and a short circuit.
HARD_WORDS = {
    # ה־ל־ך and its noun forms
    'lalekhet': ('\u05DC\u05B8\u05DC\u05B6\u05DB\u05B6\u05EA', 2, 'la-LE-khet', 'to walk'),
    'halakh':   ('\u05D4\u05B8\u05DC\u05B7\u05DA\u05B0', 2, 'ha-LAKH', 'he walked'),
    'belekhtho': ('\u05D1\u05BC\u05B0\u05DC\u05B6\u05DB\u05B0\u05EA\u05BC\u05D5\u05B9', 4, 'be-lekh-TO', 'as he walked'),
    'mahalakh': ('\u05DE\u05B7\u05D4\u05B2\u05DC\u05B8\u05DA\u05B0', 3, 'ma-ha-LAKH', 'a course'),
    'holikh':   ('\u05D4\u05D5\u05B9\u05DC\u05B4\u05D9\u05DA\u05B0', 2, 'ho-LIKH', 'he led'),
    'hahalikhot': ('\u05D4\u05B7\u05D4\u05B2\u05DC\u05B4\u05D9\u05DB\u05D5\u05B9\u05EA', 5, 'ha-ha-li-KHOT', 'the walks'),
    'halkhu':   ('\u05D4\u05B8\u05DC\u05B0\u05DB\u05D5\u05BC', 3, 'hal-KHU', 'they walked'),
    'haholkhim': ('\u05D4\u05B7\u05D4\u05D5\u05B9\u05DC\u05B0\u05DB\u05B4\u05D9\u05DD', 5, 'ha-hol-KHIM', 'the walkers'),
    'halkhah':  ('\u05D4\u05B8\u05DC\u05B0\u05DB\u05B8\u05D4', 3, 'hal-KHA', 'she went'),
    'tahalukhah': ('\u05EA\u05BC\u05B7\u05D4\u05B2\u05DC\u05D5\u05BC\u05DB\u05B8\u05D4', 5, 'ta-ha-lu-KHA', 'a procession'),
    'bemahalakh': ('\u05D1\u05BC\u05B0\u05DE\u05B7\u05D4\u05B2\u05DC\u05B8\u05DA\u05B0', 4, 'be-ma-ha-LAKH', 'along a course'),
    'yelekh':   ('\u05D9\u05B5\u05DC\u05B5\u05DA\u05B0', 2, 'ye-LEKH', 'he will walk'),

    # ק־צ־ר: reap / short / shorten, all carried by the vowels
    'lakatzir': ('\u05DC\u05B7\u05E7\u05BC\u05B8\u05E6\u05B4\u05D9\u05E8', 3, 'la-ka-TSIR', 'to the harvest'),
    'vekatzar': ('\u05D5\u05B0\u05E7\u05B8\u05E6\u05B7\u05E8', 3, 've-ka-TSAR', 'and he reaped'),
    'kotzer':   ('\u05E7\u05D5\u05B9\u05E6\u05B5\u05E8', 3, 'ko-TSER', 'a reaper'),
    'katzir':   ('\u05E7\u05B8\u05E6\u05B4\u05D9\u05E8', 2, 'ka-TSIR', 'a harvest'),
    'katzar':   ('\u05E7\u05B8\u05E6\u05B7\u05E8', 2, 'ka-TSAR', 'he reaped'),
    'katzar_adj': ('\u05E7\u05B8\u05E6\u05B8\u05E8', 2, 'ka-TSAR', 'short'),
    'ketzarah': ('\u05E7\u05B0\u05E6\u05B8\u05E8\u05B8\u05D4', 3, 'ktsa-RA', 'short'),
    'kitzer':   ('\u05E7\u05B4\u05E6\u05BC\u05B5\u05E8', 2, 'ki-TSER', 'he shortened'),
    'kotzrim':  ('\u05E7\u05D5\u05B9\u05E6\u05B0\u05E8\u05B4\u05D9\u05DD', 4, 'kots-RIM', 'reapers'),
    'veniktzerah': ('\u05D5\u05B0\u05E0\u05B4\u05E7\u05B0\u05E6\u05B0\u05E8\u05B8\u05D4', 5, 've-nik-ts-RA', 'and grew short'),
    'bekotzer': ('\u05D1\u05BC\u05B0\u05E7\u05B9\u05E6\u05B6\u05E8', 2, 'be-KO-tser', 'in impatience'),
    'veketzer': ('\u05D5\u05B0\u05E7\u05B6\u05E6\u05B6\u05E8', 2, 've-KE-tser', 'and a short circuit'),
    'yiktzor':  ('\u05D9\u05B4\u05E7\u05B0\u05E6\u05B9\u05E8', 3, 'yik-TSOR', 'he will reap'),

    # Near-rhymes keep the same difficult consonants moving.
    'melekh':   ('\u05DE\u05B6\u05DC\u05B6\u05DA\u05B0', 1, 'ME-lekh', 'a king'),
    'hamelekh': ('\u05D4\u05B7\u05DE\u05BC\u05B6\u05DC\u05B6\u05DA\u05B0', 2, 'ha-ME-lekh', 'the king'),
    'bederekh': ('\u05D1\u05BC\u05B0\u05D3\u05B6\u05E8\u05B6\u05DA\u05B0', 2, 'be-DE-rekh', 'on a road'),
    'baderekh': ('\u05D1\u05BC\u05B7\u05D3\u05BC\u05B6\u05E8\u05B6\u05DA\u05B0', 2, 'ba-DE-rekh', 'on the road'),
    'darko':    ('\u05D3\u05BC\u05B7\u05E8\u05B0\u05DB\u05BC\u05D5\u05B9', 3, 'dar-KO', 'his road'),
    'beorekh':  ('\u05D1\u05BC\u05B0\u05D0\u05B9\u05E8\u05B6\u05DA\u05B0', 2, 'be-O-rekh', 'at length'),
    'arokh':    ('\u05D0\u05B8\u05E8\u05B9\u05DA\u05B0', 2, 'a-ROKH', 'long'),
    'ruach':    ('\u05E8\u05D5\u05BC\u05D7\u05B7', 1, 'RU-akh', 'spirit'),
    'atzar':    ('\u05E2\u05B8\u05E6\u05B7\u05E8', 2, 'a-TSAR', 'brought things to a stop'),
    'akh':      ('\u05D0\u05B7\u05DA\u05B0', 1, 'AKH', 'but'),
    'kaasher':  ('\u05DB\u05BC\u05B7\u05D0\u05B2\u05E9\u05C1\u05B6\u05E8', 3, 'ka-a-SHER', 'when'),
}

# The handful of ordinary words that turn the forms above into sentences. Kept
# short and common on purpose: they are the mortar, not the lesson, and every
# one of them is a word a reader meets in the first aliyah of anything.
JOIN_WORDS = {
    'el':       ('\u05D0\u05B6\u05DC', 1, 'EL', 'to'),
    'al':       ('\u05E2\u05B7\u05DC', 1, 'AL', 'concerning'),
    'ki':       ('\u05DB\u05BC\u05B4\u05D9', 1, 'KI', 'for'),
    'asher':    ('\u05D0\u05B2\u05E9\u05C1\u05B6\u05E8', 2, 'a-SHER', 'which'),
    'haam':     ('\u05D4\u05B8\u05E2\u05B8\u05DD', 2, 'ha-AM', 'the people'),
    'aleihem':  ('\u05D0\u05B2\u05DC\u05B5\u05D9\u05D4\u05B6\u05DD', 4, 'a-lei-HEM', 'to them'),
    'lahem':    ('\u05DC\u05B8\u05D4\u05B6\u05DD', 2, 'la-HEM', 'to them'),
    'haya':     ('\u05D4\u05B8\u05D9\u05B8\u05D4', 2, 'ha-YA', 'was'),
    'veelleh':  ('\u05D5\u05B0\u05D0\u05B5\u05DC\u05BC\u05B6\u05D4', 2, 've-EL-le', 'and these'),
    'haanashim': ('\u05D4\u05B8\u05D0\u05B2\u05E0\u05B8\u05E9\u05C1\u05B4\u05D9\u05DD', 4, 'ha-a-na-SHIM', 'the men'),
    'velo':     ('\u05D5\u05B0\u05DC\u05B9\u05D0', 2, 've-LO', 'and not'),
    'yihyeh':   ('\u05D9\u05B4\u05D4\u05B0\u05D9\u05B6\u05D4', 3, 'yih-YE', 'shall be'),
    'beeretz':  ('\u05D1\u05BC\u05B0\u05D0\u05B6\u05E8\u05B6\u05E5', 2, 'be-E-retz', 'in a land of'),
    'laam':     ('\u05DC\u05B8\u05E2\u05B8\u05DD', 2, 'la-AM', 'to the people'),
    'alah':     ('\u05E2\u05B8\u05DC\u05B8\u05D4', 2, 'a-LA', 'he climbed'),
    'bekhol':   ('\u05D1\u05BC\u05B0\u05DB\u05B8\u05DC', 2, 'be-KHOL', 'in every'),
    'et':       ('\u05D0\u05B6\u05EA', 1, 'ET', 'the direct-object marker'),
}

WORDS = {**ROOT_WORDS, **WORDPLAY_WORDS, **HARD_WORDS, **JOIN_WORDS}


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


# --- The pair of practice pesukim -------------------------------------------
# (accent, word). The last entry closes the verse, so it takes the Silluq and the
# Sof Pasuk — buildLineMelody in js/trope.js treats a verse's final word that way
# regardless, and these line up with it.
#
# Every pause falls where the sense pauses: the phrase a disjunctive closes is a
# phrase, not a slice through the middle of one. That is what lets a reader hear
# the accent doing its job rather than merely reciting it.

# The rare accents are spread across BOTH sentences rather than quarantined in
# one, because that is where a reader actually meets them: a Segolta clause opens
# an ordinary long verse, a Gershayim turns up mid-phrase between two Munachs,
# and the reader has to take it in stride rather than brace for a "hard" pasuk.
# Each verse is built the way a real one is — the strong pauses divide it first
# and the ornaments sit inside the domains they serve.

SENTENCE_ONE = [
    # "Solomon, in a salmah, spoke ideas to the people." Shlomo and salmah differ
    # only by shin/sin and vowels; Tsinnorit sits beside Zarqa so their equally
    # easy-to-confuse glyphs are compared at the same moment.
    (MUNACH, 'vaydaber'), (TSINNORIT, 'shlomo'), (ZARQA, 'besalmah'),
    (MUNACH, 'devarim'), (SEGOL, 'laam'),
    # "which bees spoke in the wilderness" — devarim turns into dvorim, while a
    # Telisha Qetana and Gershayim arrive inside an everyday Revia clause.
    (TELISHA_QETANA, 'asher'), (GERSHAYIM, 'dibru'),
    (MUNACH, 'dvorim'), (REVIA, 'bamidbar'),
    # "a word of peace, whole in wholeness" — one root, three grammatical shapes,
    # in the plain Mahpach→Pashta→Zaqef run.
    (MAHPACH, 'davar'), (PASHTA, 'shalom'),
    (MUNACH, 'shalem'), (ZAQEF_QATAN, 'bishlemut'),
    # "and Solomon paid a payment for their welfare."
    (MERCHA, 'vayishalem'), (TIPCHA, 'shlomo'),
    (MUNACH, 'tashlum'), (ETNACHTA, 'lishlomam'),
    # "He climbed the ladder, and his word was fulfilled: perfect peace."
    # Samekh-lamed-mem now has to be distinguished from the root at sight.
    (MERCHA_KEFULA, 'basulam'), (TEVIR, 'alah'),
    (MERCHA, 'venishlam'), (TIPCHA, 'dvaro'),
    (MERCHA, 'shalom'), (SILLUQ, 'mushlam'),
]

SENTENCE_TWO = [
    # "And these" — Shalshelet only ever opens a verse, and it opens this one on
    # the word that turns the first pasuk into a story being retold.
    (SHALSHELET, 'veelleh'),
    # "are Deborah's words, which she spoke to bees in the wilderness" — dibra
    # and dvorim sit in a Qadma→Azla clause inside the Revia they serve.
    (TELISHA_GEDOLA, 'divrei'), (MUNACH, 'dvorah'), (PAZER, 'asher'),
    (QADMA, 'dibra'), (GERESH, 'el'),
    (MUNACH, 'dvorim'), (REVIA, 'bamidbar'),
    # "their words are honey in every matter, and not plague." Devar/divreihem,
    # dvash and dever make the vowels carry the meaning.
    (MAHPACH, 'divreihem'), (PASHTA, 'dvash'),
    (MUNACH, 'bekhol'), (ZAQEF_QATAN, 'davar'),
    (YETIV, 'velo'), (ZAQEF_GADOL, 'dever'),
    # "As she said, she completed a whole ladder toward wholeness."
    (DARGA, 'kidvarah'), (TEVIR, 'hishlima'),
    (MERCHA, 'sulam'), (TIPCHA, 'shalem'),
    (MUNACH, 'el'), (ETNACHTA, 'shlemut'),
    # "On the ladder bees made peace; their words — perfect peace."
    # Yerach ben Yomo and Qarney Para occur once each in the whole Torah
    # (Numbers 35:5), always in that order.
    (YERACH, 'uvasulam'), (QARNEY_PARA, 'hishlimu'),
    (MERCHA, 'dvorim'), (TIPCHA, 'divreihem'),
    (MERCHA, 'shalom'), (SILLUQ, 'mushlam'),
]

# --- Level 2: hard consonants -----------------------------------------------
# These keep the same natural, mixed accent grammar as the first poem, but put
# the work on khaf/chet, qof, tzadi, and resh. The first verse moves one king and
# one reaper down a shortening road; the second turns the same roots through
# nouns, tenses, and vowel-only meaning changes.

HARD_SENTENCE_ONE = [
    # "To go to harvest, a king walked on a road."
    (MUNACH, 'lalekhet'), (TSINNORIT, 'lakatzir'), (ZARQA, 'halakh'),
    (MUNACH, 'melekh'), (SEGOL, 'bederekh'),
    # "And a reaper reaped a harvest as he walked."
    (TELISHA_QETANA, 'vekatzar'), (GERSHAYIM, 'kotzer'),
    (MUNACH, 'katzir'), (REVIA, 'belekhtho'),
    # "A short course shortened his road."
    (MAHPACH, 'mahalakh'), (PASHTA, 'katzar_adj'),
    (MUNACH, 'kitzer'), (ZAQEF_QATAN, 'darko'),
    # "The king led reapers to the harvest."
    (MERCHA, 'holikh'), (TIPCHA, 'hamelekh'),
    (MUNACH, 'kotzrim'), (ETNACHTA, 'lakatzir'),
    # "At length he walked, and his road grew short when he reaped."
    (MERCHA_KEFULA, 'beorekh'), (TEVIR, 'halakh'),
    (MERCHA, 'veniktzerah'), (TIPCHA, 'darko'),
    (MERCHA, 'kaasher'), (SILLUQ, 'katzar'),
]

HARD_SENTENCE_TWO = [
    # "And these are the walks which the walkers walked on a short road to the
    # harvest." The repeated skeleton makes every vowel and suffix do real work.
    (SHALSHELET, 'veelleh'),
    (TELISHA_GEDOLA, 'hahalikhot'), (MUNACH, 'asher'), (PAZER, 'halkhu'),
    (QADMA, 'haholkhim'), (GERESH, 'baderekh'),
    (MUNACH, 'ketzarah'), (REVIA, 'lakatzir'),
    # "A reaper reaped in impatience, and a short circuit stopped things."
    # Qotser/qatsar/qotser/qetser changes meaning almost entirely by vowel.
    (MAHPACH, 'kotzer'), (PASHTA, 'katzar'),
    (MUNACH, 'bekotzer'), (ZAQEF_QATAN, 'ruach'),
    (YETIV, 'veketzer'), (ZAQEF_GADOL, 'atzar'),
    # "But a procession went along a long course to the harvest."
    (DARGA, 'akh'), (TEVIR, 'halkhah'),
    (MERCHA, 'tahalukhah'), (TIPCHA, 'bemahalakh'),
    (MUNACH, 'arokh'), (ETNACHTA, 'lakatzir'),
    # "When he walks, a reaper will reap a short harvest."
    # Yerach ben Yomo and Qarney Para remain embedded in an ordinary clause.
    (YERACH, 'kaasher'), (QARNEY_PARA, 'yelekh'),
    (MERCHA, 'yiktzor'), (TIPCHA, 'kotzer'),
    (MERCHA, 'katzir'), (SILLUQ, 'katzar_adj'),
]

# --- Every accent again, as bare word lists ---------------------------------
# The set the drills started as, kept because it is a genuinely different
# exercise. One root per pasuk and no sentence to follow: nothing carries the
# reader from word to word except the accent, which is punishing and exactly the
# point once the sentences have stopped being a challenge. Here the accents are
# sorted rather than mixed — everyday ones in the first pasuk, rare ones in the
# second — so a mark can be hunted down on its own before meeting it in traffic.

LIST_EVERYDAY = [
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

LIST_RARE = [
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

# Two lessons, each a complete round of every accent, and each a pair of pesukim
# that has to be taken together — the second of a pair carries what the first
# leaves out. The sentences come first because they are the easier way in, and
# because they mix the rare accents into ordinary phrases the way a real reading
# does; the word lists sort them again with the meaning taken away.
LESSONS = [
    {
        'title': 'Level 1A \u00b7 Two sound families, one poem, every accent',
        'note': 'A pair of playful pesukim built almost entirely from two sound families. '
                'Solomon, wearing a salmah (robe), repeats devarim (ideas) that dvorim (bees) '
                'spoke in the midbar, then climbs a sulam (ladder) as his davar is fulfilled. '
                'Dvorah answers the dvorim: their devarim are dvash (honey), not dever '
                '(plague), and the ladder becomes a metaphor for completion. The puns are a '
                'reading drill, not false etymology: true ש־ל־ם and ד־ב־ר inflections are '
                'interleaved with look- and sound-alikes, especially Shlomo / salmah / sulam '
                'and devarim / dvorim / Dvorah / dvash / dever. Tiny changes of consonant, '
                'vowel, prefix, tense, or noun pattern must be read rather than guessed, while '
                'every pause still falls where the sense pauses. The rare '
                'accents are not saved up for a hard pasuk: they are dealt through both '
                'sentences the way you meet them in a real reading \u2014 a Zarqa\u2013Segol '
                'clause opening the first, a Telisha Qetana and a Gershayim inside an ordinary '
                'Revia phrase, a Shalshelet opening the second, then Pazer, Yetiv, Zaqef Gadol, '
                'Mercha Kefula, and the Yerach ben Yomo with Qarney Para that appear once each '
                'in the entire Torah, each sitting inside the everyday phrase it serves. '
                'Note the Zarqa: Unicode splits it across two marks, and this is the one the '
                'Torah text uses. Both are long on purpose \u2014 use Divide on the sections '
                'stage to take them in halves first.',
        'pesukim': [
            {
                'label': '\u05E9\u05B8\u05C1\u05DC\u05D5\u05B9\u05DD',   # שָׁלוֹם
                'ref': 'Solomon, bees, and a ladder',
                'seq': SENTENCE_ONE,
                'en': 'And Solomon, in a robe, spoke ideas to the people, which bees had '
                      'spoken in the wilderness: a word of peace, whole in wholeness; and '
                      'Solomon paid a payment for their welfare. He climbed the ladder, and '
                      'his word was fulfilled: perfect peace.',
            },
            {
                'label': '\u05D3\u05BC\u05B0\u05D1\u05B8\u05E8\u05B4\u05D9\u05DD',   # דְּבָרִים
                'ref': 'Deborah answers the bees',
                'seq': SENTENCE_TWO,
                'en': 'And these are Deborah\u2019s words, which she spoke to bees in the '
                      'wilderness: their '
                      'words are honey in every matter, and not plague. As she said, she '
                      'completed a whole ladder toward wholeness. On the ladder the bees made '
                      'peace; their words were perfect peace.',
            },
        ],
    },
    {
        'title': 'Level 1B \u00b7 One root at a time, no sentence to lean on',
        'note': 'Every accent again with the meaning taken away: one root per pasuk, inflected '
                'every way that keeps the sound recognisable, and nothing carrying you from '
                'word to word but the trope itself. Sorted, too \u2014 the everyday accents in '
                'the first pasuk and the rare ones together in the second, so a mark can be '
                'hunted down on its own before you meet it in traffic. Harder than it looks, '
                'and worth coming back to once the story above chants easily \u2014 a sentence '
                'lets you guess where the phrase ends, and these do not. '
                'ש־ל־ם: shalom (peace), shalem (whole), shilem (he repaid), Shlomo, shlomam '
                '(their peace), meshulam (requited), shilumim (recompense). '
                'ד־ב־ר: davar (a word), diber (he spoke), dever (plague), midbar (wilderness), '
                'divreihem (their words), kidvarkha (as your word).',
        'pesukim': [
            {
                'label': '\u05E9\u05BE\u05DC\u05BE\u05DD',   # ש־ל־ם
                'ref': 'shalom',
                'seq': LIST_EVERYDAY,
            },
            {
                'label': '\u05D3\u05BE\u05D1\u05BE\u05E8',   # ד־ב־ר
                'ref': 'davar',
                'seq': LIST_RARE,
            },
        ],
    },
    {
        'title': 'Level 2 \u00b7 Hard sounds on the road to harvest',
        'note': 'A harder pair built around ה־ל־ך and ק־צ־ר. Lalekhet belongs to the root '
                'ה־ל־ך: lalekhet, halakh, halkhu, holekh, mahalakh, halikhah, and tahalukhah '
                'move medial and final khaf through changing vowels and endings, beside the '
                'near-rhymes melekh, derekh, and orekh; ruach adds chet to the same hard '
                'sound. The second family packs qof, tzadi, and resh into contrasts that the '
                'unpointed letters cannot resolve: qatsar (reaped), qatsar (short), qotser '
                '(reaper), qotser (shortness or impatience), qitser (shortened), and qetser '
                '(short circuit). Both pesukim mix common and rare accents naturally, and '
                'both tell one small story: a king and his reapers take a road that grows '
                'shorter, while a long procession keeps going after impatience and a short '
                'circuit bring everything else to a stop.',
        'pesukim': [
            {
                'label': '\u05DC\u05B8\u05DC\u05B6\u05DB\u05B6\u05EA',   # לָלֶכֶת
                'ref': 'The road that grows short',
                'seq': HARD_SENTENCE_ONE,
                'en': 'To go to harvest, a king walked on a road, and a reaper reaped a '
                      'harvest as he walked. A short course shortened his road; the king led '
                      'reapers to the harvest. At length he walked, and his road grew short '
                      'when he reaped.',
            },
            {
                'label': '\u05E7\u05BE\u05E6\u05BE\u05E8',   # ק־צ־ר
                'ref': 'The procession keeps walking',
                'seq': HARD_SENTENCE_TWO,
                'en': 'And these are the walks which the walkers walked on a short road to '
                      'the harvest: a reaper reaped in impatience, and a short circuit brought '
                      'things to a stop. But a procession went along a long course to the '
                      'harvest; when he walks, a reaper will reap a short harvest.',
            },
        ],
    },
]


def build():
    verses, groups = [], []
    for lesson in LESSONS:
        start = len(verses) + 1
        for pasuk in lesson['pesukim']:
            seq = pasuk['seq']
            words = [mark(key, accent, final=(j == len(seq) - 1))
                     for j, (accent, key) in enumerate(seq)]
            order = ' \u00b7 '.join(NAMES[accent] for accent, _ in seq)
            # A word list has nothing to translate, so its English column is the
            # trope order alone, which is what it is there to teach.
            gloss = f'Trope order: {order}'
            verses.append({
                'n': len(verses) + 1,
                'label': pasuk['label'],
                'ref': pasuk['ref'],
                'text': ' '.join(words),
                'en': f'{pasuk["en"]} \u2014 {gloss}' if pasuk.get('en') else gloss,
            })
        groups.append({'title': lesson['title'], 'note': lesson['note'],
                       'start': start, 'end': len(verses)})

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
            'ref': 'Two levels, every accent',
        },
        'groups': groups,
        'verses': verses,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    every = [p for lesson in LESSONS for p in lesson['pesukim']]
    print(f'wrote {OUT}: {len(LESSONS)} lessons, {len(verses)} practice pesukim, '
          f'{sum(len(p["seq"]) for p in every)} words')
    # Each lesson is a complete round on its own — a reader who chants one pair
    # has met every accent — so the coverage is checked lesson by lesson rather
    # than only across the set.
    ok = True
    for lesson in LESSONS:
        covered = {a for p in lesson['pesukim'] for a, _ in p['seq']}
        missing = sorted(NAMES[a] for a in set(NAMES) - covered)
        print(f'  {lesson["title"]}: {len(covered)} distinct accents'
              + (f", missing {', '.join(missing)}" if missing else ''))
        ok = ok and not missing
    # A rewrite must not quietly drop a root form or one of the poem's deliberate
    # spelling echoes: distinguishing every variant is half of what the set is for.
    used_words = {key for p in every for _, key in p['seq']}
    unused = sorted((set(ROOT_WORDS) | set(WORDPLAY_WORDS) | set(HARD_WORDS)) - used_words)
    if unused:
        print('  sound-family forms not used:', ', '.join(unused))
    return ok and not unused


if __name__ == '__main__':
    raise SystemExit(0 if build() else 1)
