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

- **Pick a reading & portion** — the Reading menu is grouped into **Parashiyot**,
  **Trope drills** and **Prayers & common passages**. For a parashah, a single
  **Portion** control sets how much you read: the full annual parashah, or one
  shorter **triennial-cycle year** (which narrows the verses shown *and* switches
  to that year's aliyot). 📅 Today jumps to the current triennial year.
- **Pesukim grouped by aliyah** — the verse list is an accordion of the reading's
  seven aliyot. Collapsed, the whole parashah is seven rows you can see at once;
  open one and its pesukim (plus its verse chains and the aliyah challenge) are in
  front of you without the rest of the reading pushing them off screen. Which
  section you had open is remembered.
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
  steps for direct comparison. The example spectrogram renders the same way when
  you **sing a duet** (the recorded chant plays as a guide while you record) as it
  does when you play the chant on its own, so you can watch the cantor's
  spectrogram and your own side by side.
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
  the verse-by-verse cards with fixed, right-to-left STA"M pages on parchment:
  consonants only, no verse numbers, no maqaf/sof-pasuk. Page and line boundaries
  follow tikkun.io's modern Davidovich 245-column / 42-line layout; the completed
  page scales as one unit on desktop and mobile, so its lines never re-wrap.
  Tap any word to jump to it for practice.
- **Hold and rewind a word at a time** — anything running (the recorded chant, the
  voice guide, a duet, your own take) can be held with **Space** and nudged with
  **,** and **.** — one word back, one word forward. Fumble a word halfway through
  a pasuk and you can stop, step back over it and carry on, instead of restarting
  the verse. Paused, stepping plays just the word you land on so you can hear it
  first. Rewinding *into a take* also discards what you sang past that point, so
  the retry replaces the fumbled stretch rather than scoring on top of it.
- **Level progression** — start with everything shown and *hear & repeat* single
  words; advance to generating words, then phrases, then the verse's larger
  **sections**, then whole lines guitar-hero style with a moving cue; then aids
  are removed one at a time (cantillation → vowels → scroll font) as your scores
  improve.
- **Divide a pasuk the way the accents do** — see
  [The accent hierarchy](#the-accent-hierarchy-how-a-pasuk-is-divided).
- **Chain pesukim before chanting a whole aliyah** — see
  [Verse chains](#verse-chains-the-rung-between-pasuk-and-aliyah).
- **Cantillation teaching** — each accent in the current unit is listed with its
  Hebrew/English name, mark glyph, role, and a **data-driven mini shape**: the
  averaged (time-normalized) pitch contour of *every* instance of that trope in
  the recording (e.g. Munach averaged from 81 instances), so the icon reflects
  how the accent is actually sung, not a hand-drawn guess.
- **Heatmap** — toggle the score overlay to color each verse by how well you've
  chanted it, so you can target weak spots.

## The accent hierarchy: how a pasuk is divided

The te'amim are not a flat run of pauses — they are a nesting hierarchy, and the
app now models it (`RANK` in `js/trope.js`):

| Rank | Accents | Divides |
|---|---|---|
| **Emperor** | Silluq (Sof Pasuk), Etnachta | the verse itself |
| **King** | Zaqef Qatan/Gadol, Segol, Shalshelet, Tipcha | each half of the verse |
| **Duke** | Revia, Zarqa, Pashta, Yetiv, Tevir | a king's stretch |
| **Count** | Geresh, Gershayim, Telisha Gedola, Pazer, Qarney Para | a duke's stretch |

`splitAtRank(segs, rank)` cuts a verse at one level of that hierarchy, keeping
every *weaker* accent inside the unit it builds up to. Two things follow:

- **Phrases (stage 3) never strand a strong accent.** Breaking at every
  disjunctive can leave an Etnachta alone on its own word when the word before it
  carries a Tipcha — musically meaningless, since the Tipcha *is* the run-up to
  the Etnachta. `splitPhrases` folds such a lone word back into the phrase that
  leads into it, so a pause is always practiced with its approach.
- **Sections (stage 4) are a real stage of their own,** sitting between phrases
  and the whole pasuk. Its **Divide** control slides between *Phrases → Clauses →
  Sections → Halves*, so a long verse can be drilled in halves (split at the
  Etnachta) or thirds (at the Zaqef/Tipcha) before you attempt it whole. A
  division that can't cut *this* pasuk (no Etnachta in a short verse) is shown
  greyed rather than hidden, so the hierarchy stays legible. Section bests are
  keyed by the **word range** they cover, so the same stretch of text keeps its
  score whichever division you reached it by.

The Trope guide labels every accent with its rank, so the tiers you practice and
the tiers you read are the same thing.

## Verse chains: the rung between pasuk and aliyah

Knowing every pasuk of an aliyah cold still leaves the *joins* between them
unrehearsed, which is usually where a long aliyah falls apart. Open an aliyah in
the verse list and it offers **verse chains**: back-to-back runs of 2, 3 or 4
pesukim chanted straight through. A chain reuses the aliyah reader (bare STA"M
scroll, moving yad, guided read / solo / duet) over a shorter span, and keeps its
own best score. Chains are personal practice, so they aren't gated behind
readiness and don't post to the leaderboards.

## Trope drills & cantillated prayers

The parashah readings teach a tune by imitation: you hear the cantor and copy
him, so the melody always arrives before the mark does and you never learn to
*read* the accents. Two reading kinds address that, and both appear in the
Reading menu alongside the parashiyot:

- **Trope drills** (`data/trope-drills.json`, built by `scripts/build_drills.py`)
  — two long practice pesukim, each built from **one Hebrew root**, so the
  syllables stay familiar and the only thing changing from word to word is the
  trope, the way a language course drills a new alphabet one letter at a time.
  *The everyday progression* (ש־ל־ם: shalom, shalem, shilem, Shlomo, meshulam,
  shilumim) carries the accents in almost every verse; *the rare flourishes*
  (ד־ב־ר: davar, diber, dever, midbar) carries everything else, down to the
  Yerach ben Yomo and Qarney Para that occur once each in the whole Torah.

  They are **not** grouped tier by tier. The accents run in the orders you
  actually meet them — each pause approached by the connectors that serve it
  (Qadma→Azla, Mahpach→Pashta→Munach→Zaqef, Darga→Tevir,
  Mercha→Tipcha→Munach→Etnachta) — and each drill divides at an Etnachta like a
  real pasuk, so the Divide control can take it in halves before you chant it end
  to end. Word lengths vary so the line has some rhythm and the ornate accents get
  the syllables they need to unfold. There is no recording: the coach line, the
  note steps and the scoring all come from the motifs in `js/trope.js` via
  `buildSyntheticCoach`, which is exactly what these lines teach. Everything else
  — record, duet, hold-and-rewind, the spectrogram — works as it does for a real
  pasuk.

  `scripts/smoke.html` checks the set against the corpus: the drills must cover
  **every accent that occurs in the shipped readings**, and must use the same
  codepoints the text does. That check earns its keep — Unicode splits the Zarqa
  across `U+0598` and `U+05AE`, and the Masoretic text overwhelmingly uses
  `U+05AE` (21× vs 5× across the three parashiyot), so drilling the other one
  would have taught a glyph the reader mostly won't meet. Both are in the drill
  now, side by side, since both turn up.
- **Prayers & common passages** — the Shema and V'ahavta, V'haya im shamo'a, the
  Ten Commandments, V'zot haTorah, Ein od milvado, and the verse behind Birkat
  haMazon. These are `kind: "excerpt"` entries: they reuse a parashah's text,
  recording and extracted pitch and simply narrow the verses on screen, so they
  come with the real recorded chant for free and **count toward that parashah's
  progress** rather than starting a parallel tally.

Adding either is a manifest edit in `data/readings.json` — no JS change:

```jsonc
// a named passage carved out of a parashah already in the app
{ "slug": "shema", "file": "data/vaetchanan.json", "kind": "excerpt",
  "base": "vaetchanan", "group": "Prayers & common passages",
  "label": "Shema & V'ahavta (Deut 6:4–9)", "range": [90, 95],
  "groups": [ { "title": "Shema Yisrael", "ref": "6:4", "start": 90, "end": 90 } ] }
```

`range` and `groups` use the reading's sequential verse index `n` (see
`data/<slug>.json`), which is also what the audio and pitch files are keyed by.

## Tests

Two headless-Chrome harnesses, both driven over the DevTools protocol (the repo
has no Node toolchain). Start the server first, then:

```bash
.venv/bin/pip install websocket-client   # once
./serve.sh 8123 &
.venv/bin/python scripts/run_smoke.py    # modules: segmentation, ranks, store, manifest
.venv/bin/python scripts/check_app.py    # the real UI, incl. pause/rewind against live audio
```

`scripts/run_smoke.py` loads `scripts/smoke.html`, which exercises the DOM-free
modules (accent ranks and every division, the phrase fold-back rule, the progress
migration, section/chain scores) and validates every entry in
`data/readings.json`. `scripts/check_app.py` walks the actual app: the reading
menu, the aliyah accordion, verse chains, all nine stages, the Divide control, the
drill set and the excerpts — then plays the recorded chant and records a duet with
a fake microphone to check that Space holds it, `,` and `.` step a word, and
resuming and stopping behave. `scripts/shot.py` grabs a screenshot for eyeballing
a change.

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
can span multiple chapters. Both the **annual** (full kriyah) and the 3-year
**triennial** aliyot — plus the **maftir** — are the real, standard boundaries
fetched from Hebcal (`hebcal-leyning` + `hebcal-triennial`, BSD-2-Clause;
triennial per R. Eisenberg's CJLS system) and mapped onto the reading's verse
indices (see `scripts/aliyot_build.py`). The tables are cached under
`data/hebcal/`; set `HEBCAL_REFRESH=1` to re-download. The registry `annual`
tuples remain only as an offline fallback if Hebcal can't be reached. To
re-derive boundaries for already-built readings without re-running audio/pitch,
run `.venv/bin/python scripts/update_aliyot.py [slug ...]`.

### Multiple voices (switchable audio sources)

A reading can offer more than one recorded voice for the **example** and **duet**
practice. Users pick the voice from a **Voice** selector in the top bar (shown
only when a reading has more than one source); the choice is remembered in
`localStorage` and applied to any reading that offers it. Each voice ships its own
word-onset alignment and its own extracted pitch/shapes, so the coach line,
spectrogram overlay and scoring match whichever voice is playing.

To add a voice, declare a `sources` list on the reading in `scripts/readings.py`
(see the template's *MULTIPLE VOICES* block) instead of the top-level `pt_*`
fields, then rebuild. The default source keeps the unsuffixed file names above;
each additional source `<id>` writes `data/<slug>_<id>_audio.json` /
`_pitch.json` / `_shapes.json` and `audio/<id>/*.mp3`, and is listed under the
reading's `sources` in `data/readings.json`. Sources come in two kinds:
`pockettorah` (fetches labels + MP3s from the PocketTorah repo) and `local` (a
drop-in for audio you host yourself — provide the MP3s under `audio/<id>/` and
comma-separated onset tracks under `data/local_sources/<id>/`; nothing is
downloaded). A source with no pitch/shapes files still plays, just without the
coach line / spectrogram overlay.

> Note: the `eikev` reading ships a demonstration second voice
> (`ptaudioonly` — the same PocketTorah audio with no coach data) purely to show
> the selector and its graceful degradation. Licensed voices such as the
> [Chabad trainer](https://www.chabad.org/library/howto/trainer_cdo/aid/1771208)
> (readers Chayim B. Alevsky and Michoel Slavin) are **not** bundled: that audio
> is copyrighted with no redistribution license, so it can only be added as a
> `local` source once you have written permission.

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
devices) and appear on a shared **leaderboard**. Users who'd rather not sign in
can still **post a full-verse score anonymously** — see
[Submit a score without an account](#submit-a-score-without-an-account).

It's built on **Firebase** (Google Auth + Firestore) loaded from the CDN as ES
modules, so there's still **no build step**. When the config below is left as
placeholders, none of it loads — the app stays 100% offline and the sign-in
button just reads "Sign-in not set up".

### Anonymous nickname & avatar

Signing in uses Google, but you don't have to *appear* as your Google name and
photo. **On your first sign-in** a friendly picker offers to set an **anonymous
nickname** (with a 🎲 suggestion button) and a **cartoon or solid-colour
avatar** instead — or you can tap **"Use my Google name & photo"** to keep the
defaults. Whatever you choose (or dismiss) is remembered, so you're only asked
once; you can change it anytime by clicking your name/avatar chip in the topbar.

The avatars are generated locally as inline SVG data-URLs (no network, no
external avatar service), so this works fully offline and the chosen identity is
what shows up everywhere on the shared leaderboards. It syncs with the rest of
your progress, so it follows you across devices.

### Submit a score without an account

Signing in is never required to compete. **After recording a full verse**, a
logged-out reader sees a **🏆 Submit to leaderboard** button. Tapping it opens
the same nickname + avatar picker (pre-filled with a random anonymous identity),
and on **Save & submit** the app signs in with **Firebase Anonymous Auth** (a
real, throwaway `uid` behind the scenes — no email, no Google account) and posts
their pesukim/aliyah/parashah scores just like a signed-in user. Anonymous
entries are tagged with an **`anon`** flag and show a small **anon** pill on the
board.

The anonymous identity persists in the browser (with a topbar chip you can edit
like any profile), and it can be **upgraded in place**: tapping **Sign in** on an
anonymous session *links* a Google account to the same `uid`, so the nickname,
progress and leaderboard standing carry over. Anonymous submission needs the
Anonymous provider enabled (step 2b below); if it isn't, the app simply doesn't
show the submit button and stays offline-only for logged-out users.

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
2b. *(optional, for logged-out submissions)* On the same **Sign-in method** page,
   enable **Anonymous**. This lets readers post a full-verse score without a
   Google account (see [Submit a score without an account](#submit-a-score-without-an-account)).
   The existing security rules already cover it, since anonymous users are still
   authenticated (`request.auth != null`).
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
progress until sign-in is configured). The board has three tabs: **Aliyot** and
**Pesukim** browse the current record-holder for *every* aliyah / pasuk across
all readings, grouped by parashah and sorted best-first — tap any row to jump
straight into practicing (and challenging) that unit — and **Overall** is the
classic global XP ranking. When you start a take, the live meter also marks your
own best (dashed) and the current record score (dotted) as targets to beat.

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
js/levels.js          stage ladder, aid progression + the division ranks
js/store.js           localStorage scores + unlocks (+ cloud merge/sync hooks)
js/auth.js            optional Google sign-in + Firestore progress sync + leaderboard
js/firebase-config.js Firebase web config (placeholders = offline-only; see above)
js/app.js             UI controller / glue
data/readings.json    reading manifest: parashiyot, drills + prayer excerpts
data/devarim1.json    local Hebrew text (Masoretic, with vowels + te'amim)
data/vaetchanan.json  parashat Va'etchanan text + aliyot (multi-chapter reading)
data/trope-drills.json  synthetic te'amim exercises (no recording)
fonts/                Culmus fonts (modern Frank Ruehl + scroll Stam Ashkenaz)
scripts/readings.py   registry of buildable readings (add an entry here)
scripts/build_reading.py  ONE command: text+English+audio+pitch+shapes+register
scripts/fetch_text.py fetch/refresh text from Sefaria (legacy single-chapter)
scripts/fetch_translation.py fetch + merge an English translation
scripts/fetch_audio.py fetch recorded chant + per-verse/word timings (legacy)
scripts/extract_pitch.py derive per-word note steps from the recordings (numpy)
scripts/build_drills.py   regenerate data/trope-drills.json
scripts/serve.py      range-enabled static server (audio seeking)
scripts/smoke.html    module tests (run via run_smoke.py)
scripts/run_smoke.py  headless module test runner
scripts/check_app.py  headless UI walkthrough (see Tests)
scripts/shot.py       headless screenshot helper
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
