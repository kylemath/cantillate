# Cantillate

🚀 **[Live Demo](https://kylemath.github.io/cantillate)** 🚀

A web MVP for reading, understanding, and **practicing the cantillation
(te'amim / trope)** of the weekly Torah parashah. It ships **Devarim
(Deuteronomy) chapter 1** and the full parashah **Va'etchanan (Deut 3:23–7:11)**,
and runs entirely locally with no build step and no external services at runtime
(an **optional** Google sign-in for cloud-saved progress + leaderboards can be
turned on — see [Accounts, saved progress & leaderboards](#accounts-saved-progress--leaderboards)).
Readings are data-driven — see [Adding a reading / parashah](#adding-a-reading--parashah).

## Quick start

```bash
./serve.sh            # starts a local server at http://localhost:8000
```

Then open **http://localhost:8000** in Chrome/Edge/Safari and allow microphone
access. No build step, no install. On a phone it works in the mobile browser:
tap the ☰ button to open the pesukim list, and rotate to landscape for a
larger practice view. (Mic + Web Audio require `http://`, so opening the file
directly won't work; pass a port to use another, e.g. `./serve.sh 8001`.)

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

## Adding a reading / parashah

Readings are **data-driven and auto-discovered**: the app lists whatever is in
`data/readings.json`, which the build script maintains. Adding a reading (a single
chapter *or* a full multi-chapter parashah) is two steps:

1. **Add a registry entry** in `scripts/readings.py` — copy the `TEMPLATE` and fill
   in: the book, the verse `range`, the PocketTorah label/audio file names, the
   local `audio_slug`, and the 7 **annual aliyah boundaries** as `(chapter, verse)`
   pairs. (Look up the exact PocketTorah names in the repo's `data/torah/labels`
   and `data/audio` folders — they're inconsistent, e.g. `Va’ethanan-1.txt` uses a
   curly apostrophe while `Vaethanan-1.mp3` doesn't.)
2. **Run one command:**

```bash
python3 -m venv .venv && .venv/bin/pip install numpy   # once
.venv/bin/python scripts/build_reading.py <slug>
```

That single command fetches the Masoretic Hebrew + Koren-Jerusalem English
(Sefaria), downloads and time-aligns the recorded chant + word onsets
(PocketTorah), extracts the per-word coach note-steps and per-trope shapes, and
**registers the reading in `data/readings.json`**. Reload the app and it appears
in the Reading menu — no JS edit needed.

It writes `data/<slug>.json`, `data/<slug>_audio.json`, `data/<slug>_pitch.json`,
`data/<slug>_shapes.json` and `audio/<audio_slug>-*.mp3`. Verses use a sequential
index `n` internally, with `c`/`v`/`ref` for chapter:verse display, so a reading
can span multiple chapters. Annual aliyot come from your boundaries; a triennial
split is approximated as even thirds.

**Notes:**
- The build prints an alignment self-check (audio onsets vs. Masoretic word count,
  and app-tokenizer vs. onsets). The only known misalignment is the **Ten
  Commandments** (in Yitro and Va'etchanan): their dual cantillation
  (*ta'am elyon/tachton*) segments the written text differently from the sung
  reading, so those few verses have an imperfect coach line.
- The legacy single-chapter scripts (`fetch_text.py`, `fetch_audio.py`,
  `extract_pitch.py`) still exist; `build_reading.py` reuses their logic. The
  original `devarim1` reading was built with them.

## Accounts, saved progress & leaderboards

Sign-in is **optional and off by default**. Out of the box the app is unchanged:
all practice scores, unlocks and heatmaps live in `localStorage` in the browser,
with no account and no network. If you enable it, users can **sign in with
Google** to sync that same progress to the cloud (so it follows them across
devices) and appear on a shared **leaderboard**.

It's built on **Firebase** (Google Auth + Firestore) loaded from the CDN as ES
modules, so there's still **no build step**. When the config below is left as
placeholders, none of it loads — the app stays 100% offline and the sign-in
button just reads "Sign-in not set up".

### How progress syncs

- Progress is still written to `localStorage` first, so reads stay instant and
  offline-friendly (`js/store.js` is unchanged in behavior).
- On sign-in, the account's cloud progress is **merged** with whatever is local
  (keeping the *best* of each score/level), so nothing is lost — including
  anything earned while logged out.
- After that, every change is pushed to Firestore (debounced), which also
  updates a small public **leaderboard summary** (`XP` = the sum of your best
  whole-verse and aliyah accuracies, plus verse/aliyah counts).

### Enable it (~5 minutes)

1. Create a project at the [Firebase console](https://console.firebase.google.com).
2. **Build → Authentication → Sign-in method → Google → Enable.** Add your site's
   domain (e.g. `kylemath.github.io` and `localhost`) under **Authentication →
   Settings → Authorized domains.**
3. **Build → Firestore Database → Create database** (production mode is fine).
4. **Project settings → General → Your apps → Web app** (`</>`), register an app,
   and copy the `firebaseConfig` values into `js/firebase-config.js`. (These are
   *not* secrets — a web config is meant to ship in the client; access is gated
   by the security rules below, so it's safe to commit for a public site.)
5. Paste these **Firestore security rules** (Firestore → Rules): each user can
   read/write only their own progress doc; leaderboard summaries are world-readable
   but writable only by their owner.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /leaderboard/{uid} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
    match /boards/{type}/refs/{refId}/entries/{uid} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

Reload the app: the topbar shows **Sign in with Google**, and the toolbar's
**🏆 Leaderboard** button opens the shared board (it shows your local-only
progress until sign-in is configured).

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
js/store.js           localStorage scores + unlocks (+ cloud merge/sync hooks)
js/auth.js            optional Google sign-in + Firestore progress sync + leaderboard
js/firebase-config.js Firebase web config (placeholders = offline-only; see above)
js/app.js             UI controller / glue
data/readings.json    reading manifest (auto-discovered by the app)
data/devarim1.json    local Hebrew text (Masoretic, with vowels + te'amim)
data/vaetchanan.json  parashat Va'etchanan text + aliyot (multi-chapter reading)
fonts/                Culmus fonts (modern Frank Ruehl + scroll Stam Ashkenaz)
scripts/readings.py   registry of buildable readings (add an entry here)
scripts/build_reading.py  ONE command: text+English+audio+pitch+shapes+register
scripts/fetch_text.py fetch/refresh text from Sefaria (legacy single-chapter)
scripts/fetch_translation.py fetch + merge an English translation
scripts/fetch_audio.py fetch recorded chant + per-verse/word timings (legacy)
scripts/extract_pitch.py derive per-word note steps from the recordings (numpy)
scripts/serve.py      range-enabled static server (audio seeking)
audio/                bundled recorded chant (Devarim 1–4, Va'ethanan 1–7)
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
  Bundled in `audio/`: Devarim 1–4 (Deut 1) and Va'ethanan 1–7 (Deut 3:23–7:11).
- **Fonts:** *Frank Ruehl CLM* and *Stam Ashkenaz CLM* from the
  [Culmus project](https://culmus.sourceforge.io) (GPLv2 with a font embedding
  exception).
- **Cantillation motifs:** stylized approximations of the Ashkenazi Torah reading
  tradition, defined in `js/trope.js` and intended to be refined per tradition.
  They convey the *shape* of each accent; they are not a substitute for a teacher.
```
