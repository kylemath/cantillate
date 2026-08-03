# Cantillate

🚀 **[Live Demo](https://kylemath.github.io/cantillate)** 🚀

A web MVP for reading, understanding, and **practicing the cantillation
(te'amim / trope)** of the weekly Torah parashah — its **haftarah** in the
haftarah melody, and **any passage of any book of the Tanakh** beside it. It ships
all of Deuteronomy with the recorded chant, the haftarot from Devarim onward, and
the text of all 39 books, and runs entirely locally with no build step and no
external services at runtime
(an **optional** Google sign-in for cloud-saved progress + leaderboards can be
turned on — see [Accounts, saved progress & leaderboards](#accounts-saved-progress--leaderboards)).
Readings are data-driven — see [Adding a reading / parashah](#adding-a-reading--parashah).

It has two faces over one engine: a **workshop** for someone who wants every
control, and a **[guided mode](#guided-mode-learning-one-reading-for-one-date)**
for someone preparing one reading for one date — enter the date of the simcha and
it names the parashah, then runs the whole ladder as five rounds of practice with
two buttons on screen.

## Quick start

```bash
./serve.sh            # starts a local server at http://localhost:8000
```

Then open **http://localhost:8000** in Chrome/Edge/Safari and allow microphone
access. No build step, no install. On a phone it works in the mobile browser:
tap the ☰ button to open the pesukim list, and rotate to landscape for a
larger practice view. (Mic + Web Audio require `http://`, so opening the file
directly won't work; pass a port to use another, e.g. `./serve.sh 8001`.)

A first-time visitor is met by **[guided mode](#guided-mode-learning-one-reading-for-one-date)**,
which asks what they are learning for and then runs it as five rounds of
practice. To go straight to the full workshop instead, open
`index.html?guided=0`.

## Guided mode: learning one reading for one date

Most people who open this app are not here to explore the te'amim. They have a
date, a reading, and a few months. Guided mode is the app for them; everything
described under [What it does today](#what-it-does-today) is the **workshop**
behind it, one tap away and unchanged.

**The wizard.** One question per screen, each answer a tap that also moves on:
what the occasion is → whose it is → their name → **the date**. The date is the
one fact a family reliably has, so it is the load-bearing answer: it resolves to
the parashah read that Shabbat, which is then shown as a card to *approve* —
name, Hebrew name, Hebrew date, and the Torah, maftir and haftarah passages. A
reader who doesn't know the date (or whose parashah isn't the one the date lands
on) can browse all 53 Shabbat readings by name instead, each with the next
Shabbat it comes round on. Then: the whole parashah or one triennial third (asked
as "how much is being read", with the rite named as a hint rather than as the
question, and the cycle year the date falls in offered as the answer), and which
parts they will chant — maftir and haftarah by default for a bar/bat mitzvah,
any of the seven aliyot otherwise.

That becomes the **plan**: a stored record of what is being learned, for whom,
for when. It is deliberately *not* the same thing as the reading that happens to
be open or the parashah of the upcoming Shabbat, so a reader preparing for next
spring is never displaced by this week. In the workshop it shows as a ★ chip in
the header (and stars the readings it needs in the Reading menu); tapping it
returns to guided mode.

**The five rounds.** The nine stages of the ladder are grouped into four rounds,
because "sing the words" and "read it from the scroll" are things a reader can be
asked to do and "stage 6 of 9" is not — and a fifth round carries the work that is
no stage of any pasuk:

| Round | Stages | What it is |
| --- | --- | --- |
| **1 · Words** | 1–2 | Hear each word, then sing it back |
| **2 · Phrases** | 3–4 | Join the words into the phrases the accents mark |
| **3 · Pesukim** | 5–7 | The whole pasuk, then with the aids taken away |
| **4 · The scroll** | 8–9 | Scroll letters, a pasuk at a time |
| **5 · Together** | — | Runs of 2, 3 and 4 pesukim, then the part end to end |

Round 5 is counted in runs of pesukim rather than in pesukim, because that is what
it is made of: every run of two, three and four consecutive pesukim in the part,
each of them twice, plus the part chanted through in one go. It used to be folded
into round 4, which meant a reader could be shown four full bars — the whole plan
complete — with most of the joins in the reading still unrehearsed.

Twice, because a run is a ramp rather than a single attempt: first from the
pointed text, where the vowels and the accents are in front of the reader and the
joins are the only hard part, and then — once that holds — the same pesukim off
the bare scroll. Passing the pointed take hands the scroll take over immediately,
while the run is still in the ear. See
[Verse chains](#verse-chains-the-rung-between-pasuk-and-aliyah).

The surface narrows to match: a top bar naming the part and the round (with the
five rounds as five filling pips), a mission card saying what to do, *why this
piece*, and where in it you are, and **one row of large buttons** — listen, sing,
stop. The workshop's own controls are hidden rather than removed, and reappear as
the rounds go up: the accuracy bars in round 2, the live pitch meter in round 3,
the spectrograms in round 4, and nothing taken away again in round 5. Round 1 is a
word and two buttons.

**What comes next is chosen, not offered.** `js/schedule.js` rotates between
three moves — **advance** (the next thing not yet done), **repair** (a word or a
pasuk whose stored best is weak, worst first, or merely-passed work to polish),
and **combine** (runs of 2–4 consecutive pesukim, and finally the whole part in
one go). Combine takes every run at every position, not the part cut into fixed
runs: the join between two pesukim is a thing to be practised, and cutting the
reading into 1–2, 3–4, 5–6 would leave the join at 2–3 inside no run at all and
give the opening of the part a run at every length. Runs come shortest first and,
at each length, with the vowels before the scroll. Equally short and equally
unpractised runs are shuffled, so the top of the aliyah is not what comes up every
time. The rotation is why a reader improves rather than merely accumulating:
marching forward only leaves verse 24 untouched and week-one's shaky words still
shaky, and drilling the weakest thing forever means never reaching a new pasuk.
Every task says why it was chosen ("Back to this — it scored 61"), and the result
is one number in a dial with one obvious next step.

**Where you are, and the way back.** Choosing an aliyah is asking to sing *that
aliyah*, so opening a part always starts on **its first pasuk**, whatever the
schedule would have picked and however much of the part is already on record. It is
handed at the round the part is working rather than at the pasuk's own stage, so a
first pasuk that has run ahead of its neighbours comes back as this round's work
instead of a Torah column to read cold; a finished part still shows its finished
card rather than starting over.

After that first task the schedule takes over, and it steps over pesukim that have
finished the round — which is right, and looks exactly like the app losing your
place. So the mission line says which pasuk of the part you are on ("Deuteronomy
7:24 · pasuk 3 of 5 · word 1 of 13"), including on a short landscape phone where the
rest of the small print is cut; the first task that does move on says which pesukim
it moved past and why ("Pesukim 1–2 are already through this round"); and the menu
lists **every pasuk of the part** with four ticks — one per round a pasuk can finish
by itself, which is every round but the chaining one — each tappable to sing it again. A pasuk asked for by name resumes at *its own* stage
rather than the part's, so going back to the opening pasuk of a reading you have
half-learned picks up where that pasuk stopped, and the schedule hands out its own
next choice again afterwards.

**The menu** (☰) shows each part's five rounds as five bars plus its whole-part
score, plus a direct **Read / listen / practice the full aliyah** action at any
point in the schedule. That full reader can be STA"M, regular pointed text, or
both side by side; when both are shown an optional follower keeps the same word
aligned as either column is scrolled. The menu also keeps the settings worth
having at this size (text size, pitch analysis, and — through the first three
rounds only — reading along in English letters), and the ways out: change the
date/cycle/parts, learn a different parashah, or open the full workshop. Changing
the plan never deletes practice — scores are filed under the pesukim themselves,
so coming back to a reading finds it exactly where it was left.

**A haftarah of his own.** Plenty of b'nei mitzvah chant something other than the
haftarah the calendar appoints: a shul with its own custom, a special Shabbat, a
passage chosen for the child. Tapping ✎ on a part in the menu opens the workshop's
[Any passage](#any-passage-any-book) picker with everything but the question taken
away — book, first pasuk, last pasuk, and a line saying what that comes to in both
languages. The two ends can't cross (moving one past the other takes the other with
it) and a passage too long to prepare is refused with the reason. What the calendar
appointed stays on record, so the substitution can be described and given back; and
because progress is filed under the book and the pasuk a passage starts at, a
substituted haftarah is measured on its own pesukim and keeps them if it is swapped
out again.

The picker also says **whose voice it will be**, before the choice is made. The app's
recordings are PocketTorah's, which cover the readings it was built with and nothing
else — so a passage picked elsewhere in Tanakh has no human recitation anywhere, and
is taught from the trope shapes measured across the recordings instead (the same way
a drill is: the words and every accent are exact, the voice is synthesized). Each
reading in `data/readings.json` declares the pesukim it `covers`
([`scripts/organize_readings.py`](scripts/organize_readings.py) stamps it from the
reading's own data file), so the picker can answer that question as a table lookup
and say one of three things: *recorded* — and when the range is exactly a recorded
reading, guided mode opens **that reading**, so the cantor is heard rather than a
recording of the same words sitting unused; *inside* a recorded reading, naming it,
so the reader can widen the range if they want the cantor; or *not recorded*, in
which case guided mode's Listen button reads **Guide voice** and round 1 says why.

**One of the seven.** A reader called for a single aliyah is told which one by
number — "you have the third" — so every screen that mentions an aliyah names the
pesukim it covers: the wizard offers the seven with their ranges beside them, and
the menu lists each part as its own passage rather than as the parashah it sits in.
This is not cosmetic. Only fifteen parashiyot ship as recorded readings (with
boundaries in their own data files); for the other thirty-eight guided mode builds
the text out of `data/tanakh/` from the reference the plan carries, so a plan that
knew only "Deuteronomy 7:12-11:25" handed a reader with one aliyah the whole
parashah to learn. Every Shabbat in `data/calendar.json` now points at where its
seven aliyot fall, annually and in that year's triennial third (as indices into a
pooled table — 228 distinct divisions for 22 years, 33 KB), taken from what Hebcal
schedules rather than reasoned about: the triennial division of a parashah that is
sometimes combined with its neighbour depends on the shape of the year. Where the
seventh aliyah is the Rosh Chodesh reading from another book, it says so.

## What it does today

- **Pick a reading & portion** — the Reading menu is grouped **by sefer** in
  chumash order (Bereshit · Genesis, Bamidbar · Numbers, Devarim · Deuteronomy),
  with each sefer's parashiyot in the order the book runs, followed by
  **Haftarot**, **Trope drills** and **Prayers & common passages**. For a parashah, a single
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
  A **Hand** control picks which scribal hand the STA"M is drawn in — *Shlomo*
  (the default: the mem's vav-leg runs down to the base with only a hairline
  break at the roof, as a sofer writes it) or *Ashkenaz* (the older Culmus font,
  whose detached mem-leg can read as a kaf plus a vav). It applies everywhere the
  scroll script appears: verse cards, the Torah column and the tikkun pages.
  Beside it, a **tracking slider** sets the space between STA"M letters. The
  notch inside a mem can't be closed — that notch is what keeps it an open mem
  and not a final one — so opening up the space between *real* letters is what
  stops a mem reading as a kaf plus a vav. The fixed tikkun pages opt out: their
  42 lines have no width to spare.
- **Transliteration** — Latin letters under each Hebrew word, for a reader who
  has to learn the tune before the alphabet is fluent. It appears on both reading
  surfaces at once (the pointed verse column and the words above the coach line),
  in the popular bencher scheme rather than an academic one: *v'ahavta*, not
  *wĕʾāhabtā*. It is generated at render time from the pointed text by
  `js/translit.js`, so it works for any passage of the Tanakh the app can open,
  and the tetragrammaton is read as it is said — **Adonai** — rather than
  spelled out. Two things are deliberately unlike a strict romanisation, because
  this is meant to be *read aloud*: a dagesh chazak is not doubled (*hadvarim*,
  not *haddevarim*), and silent letters are dropped (*Moshe*, not *Mosheh*).
  Unlike the vowels and the te'amim, this aid is **capped by the stage**: it
  switches itself off from **stage 6** on, everywhere, and the toggle greys out
  and says why. Stages 6–9 exist precisely to take the helpers away one at a
  time, and a Latin line in the column beside them would make every one of those
  stages a fiction. **Guided mode offers it too** — the reader who can't yet read
  the letters is exactly the reader that surface is for, and it hides the
  workshop's settings sheet — as a row in the ☰ menu through the Words, Phrases
  and Pesukim rounds. There it doesn't grey out but disappears, having said in
  advance which round it comes off in.
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
  Tap any word to jump to it for practice. Only the pages a reading needs are
  bundled — run `scripts/build_tikkun.py` after adding a reading, or it falls
  back to a reflowed column whose line breaks are the browser's, not the
  scroll's (`--check` reports the gap and exits non-zero). The **Full-reading
  text** setting generalizes that pane and the aliyah reader: choose STA"M,
  colored regular text with vowels and accents, or both side by side. Both
  surfaces carry the same verse/word coordinates, so the yad and post-take
  accuracy tint appear in both. **Follow together** aligns the nearest visible
  word when either column is scrolled; turn it off to move them independently.
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
- **The week's haftarah, in the haftarah melody** — see
  [Haftarot](#haftarot-the-weeks-reading-from-the-prophets).
- **Any pesukim of any book**, kept under a name of your own if you like — see
  [Any passage, any book](#any-passage-any-book).

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
pesukim chanted straight through. A chain reuses the aliyah reader (STA"M,
pointed, or paired scroll; moving yad; guided read / solo / duet) over a shorter span.
Chains are personal practice, so they aren't gated behind
readiness and don't post to the leaderboards.

A run keeps a **best per surface** — one for the pointed text, one for the bare
scroll — because they are not the same feat. Chaining brings two hard things at
once: the joins, which is the work of this rung, and reading unpointed letters at
speed across a verse boundary, which is the work of the rung below. Asked for
both in one take, a reader loses the joins to the letters. So a run is first
chanted with the vowels and the accents in front of them and only then off the
scroll, and the chip shows the best for whichever text the Torah column is
currently showing. A scroll run counts for the pointed rung too: it is the same
pesukim, read harder.

The chips in the verse list are the aliyah cut into runs end to end, which is what
a menu should be: predictable, and every pasuk in exactly one chip. Guided mode's
fifth round works the same chains from the other direction — every run at every
position, so no join is left out, each of them pointed and then from the scroll —
and both read and write the same per-range scores, so a chain chanted in one place
is chanted in the other.

## Trope drills & cantillated prayers

The parashah readings teach a tune by imitation: you hear the cantor and copy
him, so the melody always arrives before the mark does and you never learn to
*read* the accents. Two reading kinds address that, and both appear in the
Reading menu alongside the parashiyot:

- **Trope drills** (`data/trope-drills.json`, built by `scripts/build_drills.py`)
  — **two levels, presented as three lessons of two long pesukim each**. Every
  pair reaches every accent, down to the Yerach ben Yomo and Qarney Para that
  occur once each in the whole Torah.

  **Level 1** has two presentations of the same **Hebrew sound families**. The
  true ש־ל־ם forms (shalom, shalem,
  shilem, vayishalem, venishlam, hishlimah, shlemut, tashlum, meshulam) are set
  beside Shlomo, salmah (שַׂלְמָה, a robe), and sulam (סֻלָּם, a ladder). The
  ד־ב־ר forms (davar, diber/dibrah, devarim, divreihem, dever, midbar) are set
  beside dvorim (דְּבוֹרִים, bees), Dvorah, and dvash (דְּבַשׁ, honey). These
  are deliberate reading puns, not claims that all the words share an etymology:
  the syllables stay close while a vowel, prefix, tense, shin/sin/samekh, or
  nearby consonant changes under the trope.

  Its two lessons cover the **same accents** and are different exercises:

  1. **As sentences, mixed.** The pair reads as a playful poem. Solomon, wearing
     a *salmah*, repeats *devarim* (ideas) spoken by *dvorim* (bees) in the
     *midbar*, pays a *tashlum*, and climbs a *sulam* until his *davar* is
     *nishlam*. Dvorah then answers the bees: their words are *dvash*, not
     *dever*, and the ladder becomes a metaphor for completion and peace. The
     root forms and look-alikes carry almost the whole poem; ordinary joining
     words are kept to a minimum. The rare accents are dealt through both
     pesukim rather than saved for a hard one: a Zarqa–Segol clause opens the
     first, a Shalshelet opens the second, and a Pazer or a Qarney Para turns up
     inside an ordinary phrase without warning, which is how a reader actually
     meets one. A phrase that makes sense is a phrase you can hear going wrong.
  2. **As word lists, sorted.** One root per pasuk and no sentence to lean on:
     nothing carries you from word to word but the accent itself, and the rare
     marks are gathered into a pasuk of their own so you can hunt one down in
     isolation. Harder, and worth coming back to once the story chants easily,
     because a sentence lets you guess where a phrase ends and a list does not.

  **Level 2: hard consonants.** A second poem pairs ה־ל־ך with ק־צ־ר. *Lalekhet*
  belongs to ה־ל־ך, so *lalekhet, halakh, halkhu, holekh, mahalakh, halikhah,* and
  *tahalukhah* move medial and final khaf through changing vowels and endings;
  *melekh, derekh,* and *orekh* keep the same hard ending moving, while *ruach*
  adds chet. ק־צ־ר supplies qof, tzadi, and resh with unusually dense
  vowel-dependent contrasts: קָצַר (*qatsar*, reaped), קָצָר (*qatsar*, short),
  קוֹצֵר (*qotser*, reaper), קֹצֶר (*qotser*, shortness or impatience), קִצֵּר
  (*qitser*, shortened), and קֶצֶר (*qetser*, short circuit). A king and his
  reapers take a road that grows short while a long procession keeps walking.

  They are **not** grouped tier by tier. The accents run in the orders you
  actually meet them — each pause approached by the connectors that serve it
  (Qadma→Azla, Mahpach→Pashta→Munach→Zaqef, Darga→Tevir,
  Mercha→Tipcha→Munach→Etnachta), and falling where the sense pauses — and each
  drill divides at an Etnachta like a real pasuk, so the Divide control can take
  it in halves before you chant it end to end. Everything else — record, duet,
  hold-and-rewind, the spectrogram — works as it does for a real pasuk.

  **The melody is measured, not sketched.** `js/trope.js` carries hand-drawn
  motifs for each accent; they convey the shape but they are guesses, and for a
  drill the coach line is the *only* thing telling you what the accent sounds
  like. So `scripts/build_trope_shapes.py` merges every reading's measured
  `*_shapes.json` into `data/trope-shapes.json` — for each accent, the most
  representative recorded instance corpus-wide (weighted so a parashah with three
  examples can't outvote one with three hundred) plus the **median duration the
  cantor really spends on it**. A drill is then laid out on those real lengths:
  a Munach gets its second, a Shalshelet its full six and a half. Readings with
  their own recording are unaffected — they keep using their own extracted pitch.

  `scripts/smoke.html` checks the set against the corpus: the drills must cover
  **every accent that occurs in the shipped readings**, and must use the same
  codepoints the text does. That check earns its keep — Unicode splits the Zarqa
  across `U+0598` and `U+05AE`, and the Masoretic text overwhelmingly uses
  `U+05AE`, so drilling the other one would have taught a glyph the reader mostly
  won't meet. Both are in the drill now, side by side, since both turn up.

### Two ways to hear a drill

**▶ Sing these words** chants the drill itself. Synthesized voice — nobody has
ever recorded *shalom* with a Pazer on it — but every accent's melody and length
come from `data/trope-shapes.json`, measured off the cantor.

**🎤 Same tropes, real voice** is a human recitation of the same accent sequence.
The tune belongs to the accent, not the word, and the bundled readings hold
~19,000 recorded, word-aligned instances of those accents, so this searches the
corpus for the drill's accent *sequence* and splices the cantor's own voice
together, greedily taking the longest runs it can so the seams fall between
phrases rather than between every word. All six pesukim currently come out
**entirely from real audio** — the Level 1 poem in 6 and 9 splices, its word lists
in 3 and 12, and the Level 2 poem in 6 and 9 — which is only true because of the
three non-Deuteronomy readings below.

While it plays, the pane shows **the words being sung, not the drill's**, laid out
on their real durations. That matters: the first version left the drill's words on
screen over bars spaced by nominal lengths while a different verse played at its
own pace, so the accents looked wrong even though they were right (they were
verified correct word for word). A **↩ back to the drill's words** link restores
the drill when the recitation ends.

`data/trope-index.json` (`scripts/build_trope_index.py`, run automatically at the
end of every `build_reading.py`) is what makes the search cheap: every recorded
verse reduced to its mp3, its word onsets and one accent per word, ~335 KB for the
whole corpus. It deliberately **skips any verse whose tokens don't line up 1:1
with the audio onsets**, so a mis-split verse can never splice the wrong slice of
audio into a drill.
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

## Haftarot: the week's reading from the prophets

Each parashah has a **haftarah**, a passage from Nevi'im read after it — the same
te'amim, but **a different melody for every one of them**. A reader who has only
ever practiced here would arrive at the haftarah knowing the marks and singing the
wrong tune, so haftarot are their own reading kind rather than more parashiyot.

They appear in the Reading menu under **Haftarot**, in calendar order, and behave
like a parashah in every way except the two that matter:

- **One chunk, not seven aliyot.** A haftarah is chanted straight through by one
  reader, so there is no annual/triennial choice (the Portion control comes off
  the bar) and one **Whole haftarah** challenge spans the passage. Pesukim, verse
  chains, stages and scoring are unchanged.
- **The haftarah melody.** `js/trope.js` now carries **two** motif tables and the
  app threads the reading's style through everything it draws or sings; the Trope
  guide shows which melody is in force. The synthesized fallback comes from
  `data/haftarah-shapes.json` — built by `scripts/build_trope_shapes.py` from the
  **haftarah recordings only**, so the measured corpus can't average the two
  traditions into one wrong tune. Every accent that occurs in the shipped
  haftarot is sung differently in it from the same accent in the Torah corpus —
  which the tests assert, one accent at a time.

Boundaries are Hebcal's Ashkenazi `haft` refs (the same table the aliyot come
from); the recordings are PocketTorah's `-H` files. Nothing is typed out by hand:
`scripts/haftarot.py` derives all 54 configurations from those two sources, and
`scripts/tanakh.py` holds the book-name mapping the three projects disagree
about ("I Kings" on Sefaria, `Kings_1` in PocketTorah's WLC files).

```bash
.venv/bin/python scripts/build_haftarot.py --list          # what's available
.venv/bin/python scripts/build_haftarot.py --from-this-week 4   # the next four
.venv/bin/python scripts/build_haftarot.py --rest-of-book       # finish the sefer
.venv/bin/python scripts/build_haftarot.py haftarah-noach       # one by slug
```

Where PocketTorah recorded a different span from Hebcal's Ashkenazi one (Achrei
Mot, Kedoshim — a paired-week or rite difference), `RANGE_OVERRIDE` in
`scripts/haftarot.py` records the recorded range explicitly. Where nothing lines
up (Vayeilech), the haftarah ships **text-only** and is taught from the measured
shapes like a drill, rather than shipping audio that drifts out of sync. Both
lists are in that file with the reason beside each entry, and
`python scripts/haftarot.py` re-runs the alignment self-check against the WLC word
counts for all 54.

## Any passage, any book

The readings above are the *recorded* ones. **✦ Any passage** in the top bar opens
the rest of the canon: pick a book, then a **parashah** (in the Torah) or a
**chapter** (everywhere else), then the first and last pasuk. The passage becomes
an ordinary entry in the Reading menu — pesukim list, verse stages, whole-passage
challenge, leaderboard — and is chanted in the **haftarah melody**, the chant for
reading from a book rather than from the scroll.

**Give a passage a name and it keeps it.** A reference is how a passage is found;
a name is what the reader calls it. Type one in **Save as** and the passage joins
the menu under that name — "Yaakov's bar mitzvah haftarah" rather than *Isaiah
40:1-26*, with the reference it stands for moved into the tooltip — and it is
offered by name in the picker from then on. Saving and opening are separate
(**Save** leaves the picker open, so a reader setting themselves up can put
several in the menu in one visit) but a name typed before **Open passage** is
saved too, rather than lost. The same field renames; the ✕ beside a saved passage
gives up the name and nothing else. Names are kept with the reader's progress
rather than in a browser key of their own, so a signed-in reader finds them on
their other devices, and the newer list wins on sync — a passage forgotten here
isn't resurrected by a device holding an older one.

The text is a corpus of all 39 books (23,206 pesukim), fetched **one book at a
time** only when that book is picked:

```bash
.venv/bin/python scripts/build_tanakh.py --all      # ~8 min, one call per chapter
.venv/bin/python scripts/build_tanakh.py Isaiah     # or a book at a time
.venv/bin/python scripts/build_tanakh.py --missing   # only what isn't built yet
```

It writes `data/tanakh/index.json` (names, per-chapter verse counts, and the
Torah's parashah boundaries — enough to drive the picker and validate a range
with no text loaded) plus `data/tanakh/<book>.json` and `<book>.en.json`. A
chapter is stored as a bare array of verses, so verse *v* of chapter *c* is
`chapters[c-1][v-1]` and a book is a few hundred KB rather than a few MB. The
English is a separate file, fetched only if the English column is actually opened.

Notes on how it behaves:

- **No recording, so no example chant.** The guide voice is synthesized from
  `data/haftarah-shapes.json` — measured off the cantor, not sketched — exactly as
  a trope drill is.
- **Progress is filed under the book and where the passage starts**
  (`tanakh:isaiah:40.1`), so any range that begins at the same pasuk shares one
  tally however far it runs. On the leaderboard a pasuk is keyed by
  `book:chapter:verse` (`js/scores.js`), so Isaiah 40:1 practiced here and the
  same pasuk in Haftarat Va'etchanan are the same pasuk there.
- **Passages you open are remembered** (the last eight) and come back in the menu
  after a reload without fetching anything. Named ones don't age out at all, and
  naming, renaming or forgetting one never touches what has been practiced in it,
  since none of that was ever filed under the name.
- **Psalms, Proverbs and Job are flagged.** They are pointed with the *other*
  Masoretic accent system — accents that no Torah or haftarah melody was ever sung
  to — so the app says the guide is an approximation there instead of pretending
  otherwise.
- A passage is capped at 200 pesukim, which covers any haftarah or the longest
  chapter in the Tanakh.

## Tests

Three headless-Chrome harnesses, all driven over the DevTools protocol (the repo
has no Node toolchain). Start the server first, then:

```bash
.venv/bin/pip install websocket-client   # once
./serve.sh 8123 &
.venv/bin/python scripts/run_smoke.py    # modules: segmentation, ranks, store, manifest
.venv/bin/python scripts/check_app.py    # the real UI, incl. pause/rewind against live audio
.venv/bin/python scripts/check_label.py  # the onset labeller, on a scratch copy of a track
```

`scripts/run_smoke.py` loads `scripts/smoke.html`, which exercises the DOM-free
modules (accent ranks and every division, the phrase fold-back rule, the progress
migration, section/chain scores) and validates every entry in
`data/readings.json` — including that each haftarah is one chunk over its whole
passage and that every accent in the shipped haftarot has a measured *haftarah*
shape that differs from its Torah one. It also checks the three modules behind
[guided mode](#guided-mode-learning-one-reading-for-one-date): that
`data/calendar.json` names a parashah, a triennial year and seven aliyot for all
1,074 Shabbatot it covers and resolves a mid-week date forward to that week's
reading, that a plan built from one has the right parts and refs — including that
each of the seven aliyot covers its own pesukim rather than the whole parashah,
on either cycle — and that the scheduler **walks a part
to 100% and then stops** — all five rounds in order, every stage of every pasuk
handed out, every run of pesukim chained with the vowels and then off the scroll
(and counted where the chaining round can see it), and weak words coming back
before anything is polished. That last one matters most: a schedule that quietly never finishes, or
never revisits weak work, is invisible in the UI until months of practice have
gone into it. `scripts/check_app.py` walks the actual app:
the reading menu, the aliyah accordion, verse chains, all nine stages, the Divide
control, the drill set, the excerpts, a haftarah, and the **✦ Any passage** picker
end to end (book → parashah → pasuk range → open it → chant it → reload and find
it remembered → save one under a name and find it by that name after another
reload, with its progress untouched when the name is given up) — then plays the
recorded chant and records a duet with a fake
microphone to check that Space holds it, `,` and `.` step a word, and resuming and
stopping behave. Finally it walks the onboarding wizard question by question from
a clean slate (including that a date names the right parashah in both languages,
that Back keeps the answers, and that the browse-by-name list filters) and then
guided mode itself: the round pips, the mission card, listen → sing → score, the
progress menu, switching parts, and out to the workshop and back via the ★ chip.
It also checks that a part opened with its first pesukim already done says so and
still shows the position, that the menu's pasuk list reports the rounds each pasuk
has cleared, and that tapping one goes back to it at the stage it had reached.
It then trades the appointed haftarah for a passage from another book and back
again — that the picker opens on what was appointed, clamps a range instead of
refusing it, stops one that is too long, says whether anyone has recorded the
passage (and doesn't offer a cantor on one nobody has), opens the chosen passage
there and then, measures it under its own pesukim, keeps those pesukim when the
appointed one is taken back, and opens a passage the app HAS recorded as that
recording rather than as synthesized words. Last, a plan for one of the seven
aliyot: that each of the seven names its own pesukim, that opening the third starts
on the third's first pasuk, and that a parashah the app has no recording of is
still divided — the aliyah's own range is what gets assembled out of `data/tanakh/`,
not the whole reading.
Because those steps save a plan, they run last; the expert-mode steps pin
themselves to the workshop with `?guided=0`.

`scripts/check_label.py` covers the one tool that shapes a recording before the
app ever sees it: cutting a transition in two by double-click, dragging each edge
without letting it swallow a neighbour, hearing a word stop where it was cut,
saving the pair into the track and finding it still there on reopening. It works
on a scratch copy, so a failed run cannot damage anybody's labels. The transport
side — that a cut is jumped rather than played — is a step in `check_app.py`.
`scripts/shot.py` grabs a screenshot for eyeballing a change.

## Run it

```bash
./serve.sh            # range-enabled server (needed for audio seeking)
```

Then open `http://localhost:8000` in a modern browser and allow microphone
access. (Mic + Web Audio need `http://`, so opening the file directly won't work.
The server supports HTTP Range requests so individual verses/words can be seeked
within the shared mp3 tracks.)

## What's bundled

All of **Deuteronomy** — Devarim, Va'etchanan, Eikev, Re'eh, Shoftim, Ki Teitzei,
Ki Tavo, Nitzavim, Vayeilech, Ha'azinu and V'zot HaBerakhah — plus `devarim1`, the
original single-chapter reading the app started from (it overlaps Devarim 1).

Their **eleven Ashkenazi haftarot**, from Devarim to V'zot HaBerakhah, which is
the rest of this year's cycle from the week the feature landed. The remaining 43
are one command away and need no code (see
[Haftarot](#haftarot-the-weeks-reading-from-the-prophets)); each adds its
recording to `audio/`, so they are built as they are wanted rather than all at
once. **Every** book of the Tanakh is bundled as text for
[Any passage](#any-passage-any-book).

The **parashah calendar** for 2024–2045 (`data/calendar.json`, 1,074 Shabbatot),
so guided mode can turn the date of a simcha into a reading with no network and no
calendar arithmetic. Each Shabbat carries its Torah, maftir and haftarah refs and
where its **seven aliyot** fall on both cycles. Which parshiyot are read together
depends on the length of the Hebrew year and where the festivals fall, so it is
built from Hebcal rather than computed in the browser: `.venv/bin/python
scripts/build_calendar.py` (`--report` re-checks the triennial years against
Hebcal's own schedule). A
reading a reader's date lands on that the app doesn't ship yet still works — the
passage is assembled from `data/tanakh/` and chanted in the measured melody, the
same way a trope drill is.

Three readings from outside Deuteronomy are here for one reason: they are the only
places the four rarest accents are ever sung, so without them the trope drills had
nothing real to point at.

| Reading | Carries |
|---|---|
| **Vayera** (Gen 18:1–22:24) | Shalshelet, at 19:16 — one of only four in the Torah |
| **Matot** (Num 30:2–32:42) | Mercha Kefula, at 32:42 |
| **Masei** (Num 33:1–36:13) | Yerach ben Yomo *and* Qarney Para, both at 35:5 — the only occurrence of either in the entire Torah |

Two caveats on alignment. The **Ten Commandments** (Va'etchanan 5) carry a dual
cantillation, and **Ha'azinu** is laid out as poetry in two columns; in both the
text splits words differently from the recording, so their coach lines are
approximate. The splice index drops any verse that doesn't line up, so neither can
leak into the trope drills.

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
(PocketTorah), extracts the per-word coach note-steps and per-trope shapes,
**registers the reading in `data/readings.json`** (re-filing the whole menu by
sefer in chumash order — see `scripts/organize_readings.py`, which reads each
reading's book and opening verse from its own data file, so this works for a
reading built by any route), and rebuilds `data/trope-index.json` so the trope
drills can immediately splice from the new recording. Reload the app and it appears in the Reading menu — no JS edit
needed. A parashah takes about ten seconds end to end.

PocketTorah's file names are inconsistent — sometimes *within* one parashah
(Nitzavim ships `Nitzavim-1..6.txt` next to `nitzavim-7.txt`; Vayera ships
`vayera-1.txt` next to `Vayera-2..7.txt`). Where that happens, `pt_label` /
`pt_audio` accept a dict of per-file overrides with a `"*"` default instead of a
plain format string.

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
drop-in for audio you host yourself — provide the audio under `audio/<id>/` and
comma-separated onset tracks under `data/local_sources/<id>/`; nothing is
downloaded, and `"ext"` takes a container other than mp3, since a phone hands you
m4a and re-encoding would only cost a generation). A source with no pitch/shapes
files still plays, just without the coach line / spectrogram overlay. See
[A passage taught by your own recording](#a-passage-taught-by-your-own-recording)
for where the onsets come from.

> Note: the `eikev` reading ships a demonstration second voice
> (`ptaudioonly` — the same PocketTorah audio with no coach data) purely to show
> the selector and its graceful degradation. Licensed voices such as the
> [Chabad trainer](https://www.chabad.org/library/howto/trainer_cdo/aid/1771208)
> (readers Chayim B. Alevsky and Michoel Slavin) are **not** bundled: that audio
> is copyrighted with no redistribution license, so it can only be added as a
> `local` source once you have written permission.

### A passage taught by your own recording

The shipped corpus can only cover what somebody published: 54 parashiyot and 54
haftarot, all chanted by PocketTorah. A bar mitzvah passage is quite often
neither — I Samuel 28:8–19, the woman of Ein Dor, is nobody's week — and for
those the app teaches the accents from the measured trope shapes rather than
from a human voice. When a teacher records the actual pesukim, that gap closes.

What the app needs is the recording plus **word onsets**: one timestamp per
Masoretic word. PocketTorah publishes theirs; a recording made on a phone comes
with nothing, and tapping out several hundred marks by hand is a bad evening. So
`scripts/align_recording.py` derives them, using only what macOS already has:

```bash
.venv/bin/python scripts/align_recording.py \
    --audio audio/teacher/i-samuel-28-H.m4a \
    --book i-samuel --range 28:8-28:19 --id teacher --out i-samuel-28.txt
```

It speaks the passage word by word with `say -v Carmit` — a reference signal
whose boundaries are known exactly — reduces both signals to MFCCs (which
describe the sounds being made and ignore pitch, the one thing that separates
chanting from speech), and dynamic-time-warps the reference onto the recording.
That is precisely the problem DTW was made for: the same sounds in the same
order at wildly different speeds, here about 2.7x. Both ends of the path are
anchored, because a free endpoint makes skipping audio the cheapest thing
available and the text collapses into a corner; audio with no counterpart in the
text — a spoken introduction, an outro — is absorbed by a **garbage row** at each
end that matches anything at a flat price, while real words pay a small surcharge
for dwelling so they cannot swallow the introduction themselves. On the Ein Dor
recording it finds the chanting starting at 13.92s (the teacher introduces it
first) and ending at 268.58s, and reports its confidence per pasuk.

Close is not exact, and only ears can tell the difference, so
**`scripts/label.html`** plays the recording with the words lighting up in time:

```bash
./serve.sh 8123
open "http://localhost:8123/scripts/label.html?review=data/local_sources/teacher/i-samuel-28.txt.review.json"
```

Words the aligner was least sure of are underlined, a wrong one can be dragged
in the waveform, nudged with the arrow keys or re-tapped in time with playback,
and **Save** writes the track back through the dev server.

A person chanting into a phone also does things that are not the reading — a
false start, a cough, a word to whoever is in the room — and every moment
between two words otherwise belongs to one of them. **Double-clicking a
transition** in the waveform breaks it in two: the word before it stops at the
left edge, the word after begins at the right, and what lies between belongs to
neither. Drag either edge to fit it to what you hear, hit **Skip cuts** to
audition the result, and double-click the cut to close it again. Such a mark is
written as one field with two times, `60.500-61.050`, which is all
`scripts/onsettrack.py` adds to PocketTorah's format; nothing plays a cut, no
splice carries one into a drill, and the pitch analysis leaves it out of both the
word's coach line and the verse's tonic. `scripts/check_label.py` keeps that
working.

Then declare the passage in `scripts/local_readings.py` and build it like any
other reading:

```bash
.venv/bin/python scripts/build_reading.py i-samuel-28
```

From there nothing knows the recording came from a living room. It gets its text
and English from Sefaria, its coach line and spectrogram from the teacher's own
pitch, per-word playback, the trope drills, and a `covers` entry in the manifest
— which is what lets **guided mode** find it: a reader who swaps their haftarah
for these pesukim is told "♪ Recorded" and opened into that voice, instead of
being taught by the synthesized guide.

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
- Not everything is a score: chosen identity, custom aliyah boundaries and the
  passages you [named](#any-passage-any-book) travel with it. Those are *edits*
  rather than bests, so the most recent one wins instead of the highest — which is
  what lets a rename or a deletion survive the trip through another device.
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
css/guided.css        the onboarding wizard + guided mode's narrowed surface
js/hebrew.js          Unicode helpers: strip vowels/te'amim, tokenize, detect accents
js/translit.js        pointed Hebrew -> Latin letters, for the transliteration aid
js/trope.js           trope motifs as pitch contours + melody building
js/audio.js           Web Audio synthesis of the target melody
js/pitch.js           microphone + shared pitch detection (autocorrelation)
js/realaudio.js       recorded-chant playback + live spectrogram/pitch analysis
js/viz.js             canvas: coach contour, real/user overlays, spectrogram, scoring
js/levels.js          stage ladder, aid progression + the division ranks
js/calendar.js        date → parashah, triennial year + the week's passages
js/plan.js            the "currently learning" plan: whose, when, which parts
js/schedule.js        what to practise next: advance / repair / combine
js/onboarding.js      the first-run wizard, one question per screen
js/guided.js          guided mode: five rounds over the same practice engine
js/store.js           localStorage scores + unlocks (+ cloud merge/sync hooks)
js/auth.js            optional Google sign-in + Firestore progress sync + leaderboard
js/firebase-config.js Firebase web config (placeholders = offline-only; see above)
js/tanakh.js          the browsable Tanakh: book index, lazy per-book text, ranges
js/app.js             UI controller / glue
data/readings.json    reading manifest: parashiyot, haftarot, drills + excerpts
data/calendar.json    which parashah is read on which Shabbat, 2024–2045
data/devarim1.json    local Hebrew text (Masoretic, with vowels + te'amim)
data/vaetchanan.json  parashat Va'etchanan text + aliyot (multi-chapter reading)
data/trope-drills.json  synthetic te'amim exercises (no recording of their own)
data/trope-index.json   recorded verses as accent sequences (drives the splicer)
data/trope-shapes.json  how each accent is really sung, measured corpus-wide
data/haftarah-shapes.json  the same, measured from the haftarah recordings only
data/tanakh/          every book as text + index.json (drives ✦ Any passage)
fonts/                modern Frank Ruehl + two STA"M hands (Shlomo, Ashkenaz)
scripts/readings.py   registry of buildable readings (add an entry here)
scripts/tanakh.py     the 39 books: names in three projects' spellings, numerals
scripts/haftarot.py   all 54 haftarot, derived from Hebcal + PocketTorah
scripts/build_haftarot.py  build haftarot by slug, by book, or from this week on
scripts/build_tanakh.py    build the browsable text of the Tanakh
scripts/build_calendar.py  build data/calendar.json from Hebcal (date → parashah)
scripts/build_reading.py  ONE command: text+English+audio+pitch+shapes+register
scripts/fetch_text.py fetch/refresh text from Sefaria (legacy single-chapter)
scripts/fetch_translation.py fetch + merge an English translation
scripts/fetch_audio.py fetch recorded chant + per-verse/word timings (legacy)
scripts/extract_pitch.py derive per-word note steps from the recordings (numpy)
scripts/build_tikkun.py   refresh the scroll page/line layout for every reading
scripts/build_drills.py   regenerate data/trope-drills.json
scripts/build_trope_index.py  regenerate the splice index
scripts/build_trope_shapes.py regenerate the measured per-accent shapes
scripts/organize_readings.py  group the Reading menu by sefer, in chumash order
scripts/serve.py      range-enabled static server (audio seeking)
scripts/align_recording.py    word onsets for a recording of your own (TTS + DTW)
scripts/label.html            fix those onsets by ear; cut out false starts
scripts/onsettrack.py         the onset track format, cuts included
scripts/local_readings.py     passages taught by a recording of one's own
scripts/smoke.html    module tests (run via run_smoke.py)
scripts/run_smoke.py  headless module test runner
scripts/check_app.py  headless UI walkthrough (see Tests)
scripts/check_label.py headless walkthrough of the onset labeller
scripts/shot.py       headless screenshot helper
audio/                bundled recorded chant (all of Deuteronomy + Vayera/Matot/Masei)
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
  Bundled in `audio/`: all of Deuteronomy, Vayera/Matot/Masei, and the haftarot
  from Devarim onward (their `-H` recordings).
- **Fonts:** *Frank Ruehl CLM* and *Stam Ashkenaz CLM* from the
  [Culmus project](https://culmus.sourceforge.io) (GPLv2 with a font embedding
  exception); *Shlomo Stam* by Shlomo Orbach, a derivative of Ezra SIL SR, under
  the SIL Open Font License 1.1 (see `fonts/ShlomoStam-OFL.txt`).
- **Cantillation motifs:** stylized approximations of the Ashkenazi **Torah
  reading** and **haftarah** traditions — two motif tables in `js/trope.js`, and
  two measured corpora beside them (`data/trope-shapes.json`,
  `data/haftarah-shapes.json`) — intended to be refined per tradition. They convey
  the *shape* of each accent; they are not a substitute for a teacher.
- **Aliyah + haftarah boundaries:** [Hebcal](https://github.com/hebcal)
  (`hebcal-leyning`, `hebcal-triennial`), BSD-2-Clause.
```
