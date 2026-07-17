# Cantillate

🚀 **[Live Demo](https://kylemath.github.io/cantillate)** 🚀

A web MVP for reading, understanding, and **practicing the cantillation
(te'amim / trope)** of the weekly Torah parashah. This first build loads
**Devarim (Deuteronomy) chapter 1** and runs entirely locally with no build
step and no external services at runtime.

## What it does today

- **Pick a reading & division** — Devarim 1, as the full parashah or one of three
  parts (a triennial-style division).
- **Text with real vowels + cantillation** — the Masoretic (Leningrad Codex)
  text, stored locally in `data/devarim1.json`.
- **Show / hide aids** — toggle niqqud (vowels) and te'amim (cantillation marks),
  and switch between a **modern Hebrew font** and a **Torah-scroll STA"M font**.
- **Hear the real chant** — the actual recorded cantor's chanting of the selected
  verse (PocketTorah, CC-BY-SA), with karaoke-style word highlighting. You can
  also **tap any word** (or use "Hear this word") to play just that word, sliced
  from the mp3 using Masoretic word onsets.
- **Ground-truth note steps from the recording** — the coach line is not guessed;
  `scripts/extract_pitch.py` analyzes the mp3s and derives, per word, the discrete
  note **steps** (per-syllable tones, their up/down and relative lengths) that
  match the spectrogram fundamental. These are drawn as horizontal bars (no
  diagonal connectors) on a time axis aligned with the spectrogram below.
- **Word vs. verse modes** — single-word focus shows one word's steps + its own
  spectrogram (skipping to the next word updates the graph); whole-verse mode is a
  "piano-trope" timeline of every word laid out on the real time axis, with the
  words stretched across their note slots and the spectrogram aligned beneath.
- **Voice spectrogram + live overlay** — a time-aligned log-frequency spectrogram
  shows the singing voice with its fundamental ("tonal line") and harmonics; the
  recording's live pitch (green) and your mic pitch (orange) overlay the coach
  steps for direct comparison.
- **Voice guide** — a synthesized, *voice-like* rendering of the trope that
  articulates each syllable (stops/gaps + formant color), not a flat pure tone.
- **Tone-shape practice** — every cantillation accent is drawn as a *linear tone
  shape over time* (the "ideal tone pattern"), color-coded by trope family. Press
  **Record my try**: your microphone pitch is detected live and drawn as a
  **fuzzy orange line over the colored target**, like whistling with a
  spectrogram open. A match score (0–100) is computed.
- **Color-coded tropes + families** — each *disjunctive* (pause) accent group has
  a color, and its **connector (conjunctive) accents inherit that color**, since a
  connector is just a pickup into the accent it leads into. This pairs connectors
  with their phrase instead of a generic grey. The family bar shows the actual
  cantillation-mark glyphs; tap a family (or a trope card) to **highlight every
  occurrence in the text**.
- **Torah-column view** — toggle "📜 Torah column" (or reach Level 8) to replace
  the verse-by-verse cards with a continuous, justified, right-to-left STA"M
  column on parchment: consonants only, no verse numbers, no maqaf/sof-pasuk —
  the authentic scroll format. (Exact scribal line/paragraph breaks would need a
  dedicated tikkun dataset; the column format, justification and script are
  faithful.) Tap any word to jump to it for practice.
- **Level progression** — start with everything shown and *hear & repeat* single
  words; advance to generating words, phrases, then whole lines guitar-hero style
  with a moving cue; then aids are removed one at a time (cantillation → vowels →
  scroll font) as your scores improve.
- **Cantillation teaching** — each accent in the current unit is listed with its
  Hebrew/English name, mark glyph, role, and a **data-driven mini shape**: the
  averaged (time-normalized) pitch contour of *every* instance of that trope in
  the recording (e.g. Munach averaged from 81 instances), so the icon reflects
  how the accent is actually sung, not a hand-drawn guess.
- **Heatmap** — toggle the score overlay to color each verse by how well you've
  chanted it, so you can target weak spots.

## Run it

```bash
./serve.sh            # range-enabled server (needed for audio seeking)
```

Then open `http://localhost:8000` in a modern browser and allow microphone
access. (Mic + Web Audio need `http://`, so opening the file directly won't work.
The server supports HTTP Range requests so individual verses/words can be seeked
within the shared mp3 tracks.)

## Refresh / add texts

```bash
python3 scripts/fetch_text.py Deuteronomy 1 --out data/devarim1.json --slug devarim1
python3 scripts/fetch_audio.py            # recorded chant + per-verse/word timings
python3 -m venv .venv && .venv/bin/pip install numpy
.venv/bin/python scripts/extract_pitch.py # derive per-word note steps from audio
```

Change the book/chapter and register the new file in `AVAILABLE` at the top of
`js/app.js`.

## Project layout

```
index.html            app shell
css/styles.css        styling (RTL-aware, dark theme)
js/hebrew.js          Unicode helpers: strip vowels/te'amim, tokenize, detect accents
js/trope.js           trope motifs as pitch contours + melody building
js/audio.js           Web Audio synthesis of the target melody
js/pitch.js           microphone + shared pitch detection (autocorrelation)
js/realaudio.js       recorded-chant playback + live spectrogram/pitch analysis
js/viz.js             canvas: coach contour, real/user overlays, spectrogram, scoring
js/levels.js          level/aid progression config
js/store.js           localStorage scores + unlocks
js/app.js             UI controller / glue
data/devarim1.json    local Hebrew text (Masoretic, with vowels + te'amim)
fonts/                Culmus fonts (modern Frank Ruehl + scroll Stam Ashkenaz)
scripts/fetch_text.py fetch/refresh text from Sefaria
scripts/fetch_audio.py fetch recorded chant + per-verse/word timings
scripts/extract_pitch.py derive per-word note steps from the recordings (numpy)
scripts/serve.py      range-enabled static server (audio seeking)
audio/                bundled recorded chant (Devarim files 1-4)
```

## Toward mobile (Android / iOS)

The app is plain HTML/JS/CSS with no framework lock-in, so it can be wrapped with
Capacitor or Tauri later. The audio, pitch, and canvas layers are isolated
modules that port directly.

## Credits & licensing

- **Text:** *Miqra according to the Masorah* (MAM) via
  [Sefaria](https://www.sefaria.org). The underlying Leningrad Codex text is in
  the public domain; the MAM digital edition is distributed CC-BY.
- **Recorded chant:** audio and word-timing metadata from
  [PocketTorah](https://pockettorah.com) (Neiss & Schwartz), released CC-BY-SA.
  Only Devarim files 1–4 (covering Deut 1) are bundled in `audio/`.
- **Fonts:** *Frank Ruehl CLM* and *Stam Ashkenaz CLM* from the
  [Culmus project](https://culmus.sourceforge.io) (GPLv2 with a font embedding
  exception).
- **Cantillation motifs:** stylized approximations of the Ashkenazi Torah reading
  tradition, defined in `js/trope.js` and intended to be refined per tradition.
  They convey the *shape* of each accent; they are not a substitute for a teacher.
```
