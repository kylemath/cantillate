#!/usr/bin/env python3
"""Build ALL data for a reading in one command, from the scripts/readings.py
registry:

    .venv/bin/python scripts/build_reading.py <slug>

Produces (matching the app's schema, keyed by a sequential per-reading verse
index n):
    data/<slug>.json          Hebrew (MAM) + English + verses + annual/triennial aliyot
    data/<slug>_audio.json    per-verse audio ranges + word onsets (default voice)
    data/<slug>_pitch.json    per-word note steps (coach line) from the recording
    data/<slug>_shapes.json   representative per-trope pitch shapes
and downloads audio/<audio_slug>-<i>.mp3, then registers the reading in
data/readings.json (the app auto-discovers it — no JS edit needed).

A reading may offer more than one recorded voice (audio source). Declare a
`sources` list in scripts/readings.py (see the template there). The default
source keeps the unsuffixed names above; each additional source `<id>` writes
data/<slug>_<id>_audio.json / _pitch.json / _shapes.json and audio/<id>/*.mp3,
and is listed under the reading's `sources` in data/readings.json so the app
shows a voice selector. Text + aliyot are built once (voice-independent).

Sources: Sefaria API (text) + PocketTorah GitHub (audio, labels, WLC word
counts), plus optional `local` drop-in voices you host yourself.
Reuses fetch_translation.get_english/clean and the extract_pitch.py DSP pipeline.
"""
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_translation as ftr           # noqa: E402  (clean + get_english)
import extract_pitch as ep                # noqa: E402  (f0_track, tokenize, make_steps, ...)
import tanakh                             # noqa: E402  (book names, Hebrew numerals)
from readings import REGISTRY as TORAH_REGISTRY   # noqa: E402
from haftarot import REGISTRY as HAFTARAH_REGISTRY  # noqa: E402
from aliyot_build import build_aliyot_doc, HEBCAL_ATTRIBUTION  # noqa: E402

# Every buildable reading, by slug. The Torah parashiyot are hand-written in
# scripts/readings.py; the haftarot are derived from Hebcal's leyning table in
# scripts/haftarot.py, so all 54 are available without typing any of them out.
REGISTRY = {**TORAH_REGISTRY, **HAFTARAH_REGISTRY}

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(HERE, "audio")
DATA_DIR = os.path.join(HERE, "data")
WAV_DIR = "/tmp/cw"
MANIFEST = os.path.join(DATA_DIR, "readings.json")

RAW = "https://raw.githubusercontent.com/rneiss/PocketTorah/master"
SEFARIA = "https://www.sefaria.org/api/texts/{book}.{ch}?context=0&commentary=0"
EN_DASH = "\u2013"
MAQAF = "\u05be"
PASEQ = "\u05c0"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cantillate-mvp/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


# App tokenizer replica (js/hebrew.js) for the alignment self-check.
def js_tokenize(text):
    import re
    text = re.sub(r"<[^>]*>|&[#a-zA-Z0-9]+;", "", text)
    text = re.sub(r"\{[^}]*\}", " ", text)
    out = []
    for w in text.split():
        cur = ""
        for s in re.split(r"([\u05be\u05c0])", w):
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


def split_contig(lo, hi, parts):
    total = hi - lo + 1
    base, rem = total // parts, total % parts
    out, cur = [], lo
    for k in range(parts):
        size = base + (1 if k < rem else 0)
        out.append((cur, cur + size - 1))
        cur += size
    return out


DEFAULT_SOURCE = "pockettorah"
LOCAL_LABELS_DIR = os.path.join(DATA_DIR, "local_sources")


def is_default_source(src):
    return src.get("id", DEFAULT_SOURCE) == DEFAULT_SOURCE


# Output data-file name for a source. The default source keeps the original
# unsuffixed names (zero migration); other sources use a `_<id>` suffix. Must
# stay in sync with srcPath() in js/app.js.
def out_name(cfg, src, suffix):
    sid = src.get("id", DEFAULT_SOURCE)
    return f"{cfg['slug']}_{suffix}" if sid == DEFAULT_SOURCE else f"{cfg['slug']}_{sid}_{suffix}"


# Web-relative MP3 path stored in the audio doc's "file" field (what the app
# fetches). Default source lives at audio/<slug>-<i>.mp3; others are namespaced
# under audio/<id>/ so voices never collide.
def mp3_rel(src, i):
    sid = src.get("id", DEFAULT_SOURCE)
    slug = src["audio_slug"]
    sub = "" if sid == DEFAULT_SOURCE else f"{sid}/"
    return f"audio/{sub}{slug}-{i}.mp3"


def mp3_disk(src, i):
    return os.path.join(HERE, mp3_rel(src, i))


# Normalise a reading's audio sources. A cfg may declare an explicit `sources`
# list (each PocketTorah-style remote fetch, or a `local` drop-in), or use the
# legacy top-level pt_* fields (treated as a single default PocketTorah source).
def reading_sources(cfg):
    if cfg.get("sources"):
        out = []
        for s in cfg["sources"]:
            d = dict(s)
            d.setdefault("id", DEFAULT_SOURCE)
            d.setdefault("kind", "pockettorah")
            out.append(d)
        return out
    # A reading with no recording at all (text only). The app teaches it from the
    # measured trope shapes for its style instead of from a cantor's audio.
    if not cfg.get("pt_files"):
        return []
    return [{
        "id": DEFAULT_SOURCE,
        "label": "PocketTorah (Neiss & Schwartz)",
        "default": True,
        "kind": "pockettorah",
        "pt_files": cfg["pt_files"],
        "pt_label": cfg["pt_label"],
        "pt_audio": cfg["pt_audio"],
        "audio_slug": cfg["audio_slug"],
        "source_url": "https://pockettorah.com",
        "license": "PocketTorah audio & timing metadata, CC-BY-SA. Alignment via WLC.",
        "attribution": "Recorded chanting courtesy of PocketTorah (Neiss & Schwartz), CC-BY-SA.",
    }]


def chapters_of(cfg):
    """Chapter numbers a reading touches, from either `range` or `spans`."""
    if cfg.get("range"):
        return sorted({c for c, _, _ in cfg["range"]})
    chs = set()
    for ((c0, _), (c1, _)) in cfg["spans"]:
        chs.update(range(c0, c1 + 1))
    return sorted(chs)


def expand_spans(spans, chapter_lengths):
    """[((c0,v0),(c1,v1))] -> the `range` shape [(c, v0, v1)].

    A reading given as chapter:verse endpoints (the way Hebcal cites a haftarah)
    can only be turned into per-chapter verse runs once the length of each
    chapter is known, which is why this happens after the text is fetched.
    """
    out = []
    for ((c0, v0), (c1, v1)) in spans:
        for c in range(c0, c1 + 1):
            first = v0 if c == c0 else 1
            last = v1 if c == c1 else chapter_lengths.get(c)
            if last is None:
                raise SystemExit(f"chapter {c} length unknown; cannot expand span")
            out.append((c, first, last))
    return out


def build_text(cfg):
    """Fetch text + aliyot (source-independent) and write data/<slug>.json.

    Returns (verses, bounds) where `verses` has no _wc (matching the doc) and
    `bounds` gives each verse's cumulative WLC word span for audio alignment.
    """
    book = cfg["sefaria_book"]
    chapters_needed = chapters_of(cfg)

    he_by_ch, he_version = {}, None
    en_by_ch, en_version = {}, None
    for ch in chapters_needed:
        url = SEFARIA.format(book=urllib.parse.quote(book), ch=ch)
        data = json.loads(get(url).decode("utf-8"))
        he_by_ch[ch] = data.get("he") or []
        he_version = data.get("heVersionTitle") or "Miqra according to the Masorah"
        en, ver = ftr.get_english(book, ch)
        en_by_ch[ch], en_version = en, ver
        print(f"  {book} {ch}: {len(he_by_ch[ch])} he verses; English '{ver}'")

    # A reading cited as chapter:verse endpoints becomes explicit verse runs now
    # that the chapter lengths are known.
    if not cfg.get("range"):
        cfg["range"] = expand_spans(cfg["spans"],
                                    {c: len(he_by_ch[c]) for c in chapters_needed})
        print(f"  range: {cfg['range']}")

    # PocketTorah's WLC word counts are what the recording's onsets were labelled
    # against. Its file names differ from Sefaria's outside the Torah ("Kings_1"
    # for "I Kings"), so the registry names the file explicitly.
    wlc_book = cfg.get("wlc_book") or book
    wlc_ch = []
    if wlc_book:
        wlc = json.loads(get(f"{RAW}/data/torah/json/{wlc_book}.json").decode("utf-8-sig"))
        # These files end with a trailing null chapter; drop it so the list index
        # is chapter-1 throughout.
        wlc_ch = [c for c in wlc["Tanach"]["tanach"]["book"]["c"] if c]

    def wc(c, v):
        if not wlc_ch or c - 1 >= len(wlc_ch):
            return 0
        vs = wlc_ch[c - 1]["v"]
        return len(vs[v - 1]["w"]) if v - 1 < len(vs) else 0

    verses, n = [], 0
    for (c, v0, v1) in cfg["range"]:
        last = v1 if v1 is not None else len(he_by_ch[c])
        for v in range(v0, last + 1):
            n += 1
            he = he_by_ch[c]
            en = en_by_ch[c]
            verses.append({"n": n, "c": c, "v": v, "ref": f"{c}:{v}",
                           "text": he[v - 1] if v - 1 < len(he) else "",
                           "en": ftr.clean(en[v - 1]) if v - 1 < len(en) else "",
                           "_wc": wc(c, v)})
    N = len(verses)
    print(f"  built {N} verses (n=1..{N})")

    # cumulative WLC bounds in reading order
    bounds, cum = [], 0
    for row in verses:
        bounds.append((cum, cum + row["_wc"]))
        cum += row["_wc"]

    kind = cfg.get("kind", "parashah")

    if kind == "haftarah":
        # A haftarah has no aliyot: it is chanted straight through by one reader.
        # It still gets ONE chunk covering the whole passage, so the app's
        # continuous-reading mode (guided read, solo record, scoring across many
        # pesukim) works for it exactly as it does for an aliyah. 'H' marks it,
        # the way 'M' marks the maftir.
        N = len(verses)
        aliyot_doc = {"annual": [{"n": "H", "start": 1, "end": N,
                                  "ref": f"{verses[0]['ref']}{EN_DASH}{verses[-1]['ref']}"}],
                      "triennial": {}}
        aliyot_src = "haftarah"
        print(f"  haftarah: one chunk of {N} pesukim")
    else:
        # aliyot (source-independent): real annual + triennial (+ maftir) boundaries
        # from Hebcal, mapped onto this reading's verse indices. Falls back to the
        # registry `annual` tuples + an even split only if Hebcal is unreachable.
        parashah_name = (cfg.get("parashah") or {}).get("en")
        aliyot_doc, aliyot_src = build_aliyot_doc(
            verses, parashah_name=parashah_name, hebcal_key=cfg.get("hebcal"),
            fallback_annual=cfg.get("annual"))
        print(f"  aliyot: source={aliyot_src}; annual={len(aliyot_doc['annual'])} aliyot, "
              f"triennial years={sorted(aliyot_doc['triennial'])}, "
              f"maftir={'yes' if aliyot_doc.get('maftir') else 'no'}")

    for row in verses:
        row.pop("_wc", None)

    # Chapter lengths are needed to cite a range that runs to the end of a chapter.
    lengths = {c: len(he_by_ch[c]) for c in chapters_needed}
    ref = cfg.get("ref") or tanakh.en_ref(book, cfg["range"], lengths)
    he_ref = cfg.get("heRef") or tanakh.he_ref(book, cfg["range"])
    # A haftarah's menu label can only be written once its range is resolved, so
    # the registry leaves it out and it is composed here.
    if not cfg.get("label"):
        if kind == "haftarah":
            cfg["label"] = f"Haftarat {cfg['haftarah']['parashah']} ({ref})"
        else:
            cfg["label"] = ref

    text_doc = {"slug": cfg["slug"], "book": cfg["book"], "multiChapter": cfg.get("multiChapter", False),
                "ref": ref, "heRef": he_ref,
                "versionTitle": he_version, "heVersionTitle": he_version, "enVersionTitle": en_version,
                "license": "Leningrad Codex text is public domain; MAM digital edition CC-BY (Sefaria).",
                "source": "https://www.sefaria.org", "verses": verses}
    if kind != "parashah":
        text_doc["kind"] = kind
    if cfg.get("tropeStyle"):
        text_doc["tropeStyle"] = cfg["tropeStyle"]
    if cfg.get("haftarah"):
        text_doc["haftarah"] = cfg["haftarah"]
    if cfg.get("parashah"):
        text_doc["parashah"] = dict(cfg["parashah"])
        text_doc["parashah"].setdefault("ref", ref)
    if aliyot_doc["annual"] or aliyot_doc["triennial"]:
        text_doc["aliyot"] = aliyot_doc
        if aliyot_src == "hebcal":
            text_doc["aliyotAttribution"] = HEBCAL_ATTRIBUTION
        elif cfg.get("aliyotAttribution"):
            text_doc["aliyotAttribution"] = cfg["aliyotAttribution"]

    _write(f"{cfg['slug']}.json", text_doc)
    return verses, bounds


# PocketTorah's file names are inconsistent — not just between parashiyot but
# sometimes WITHIN one (Nitzavim ships Nitzavim-1..6.txt alongside nitzavim-7.txt;
# Vayera ships vayera-1.txt alongside Vayera-2..7.txt). So `pt_label` / `pt_audio`
# may be either a format string or a dict of per-file overrides keyed by index,
# with a "*" entry as the default.
def pt_name(src, key, i):
    spec = src[key]
    if isinstance(spec, dict):
        return (spec.get(i) or spec["*"]).format(i=i)
    return spec.format(i=i)


# Load this source's word-onset tracks, ensuring the MP3s are present.
# PocketTorah sources fetch labels + audio from GitHub; `local` drop-in sources
# read comma-separated onsets from data/local_sources/<id>/ and require the MP3s
# to already exist under audio/<id>/ (e.g. licensed material provided offline).
def load_source_tracks(src):
    kind = src.get("kind", "pockettorah")
    sid = src.get("id", DEFAULT_SOURCE)
    labels = {}
    for i in src["pt_files"]:
        dest = mp3_disk(src, i)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if kind == "pockettorah":
            name = urllib.parse.quote(pt_name(src, "pt_label", i))
            raw = get(f"{RAW}/data/torah/labels/{name}").decode("utf-8-sig")
            if not os.path.exists(dest):
                print(f"  downloading {pt_name(src, 'pt_audio', i)} ...")
                with open(dest, "wb") as f:
                    f.write(get(f"{RAW}/data/audio/{pt_name(src, 'pt_audio', i)}"))
        elif kind == "local":
            lbl = os.path.join(LOCAL_LABELS_DIR, sid, pt_name(src, "pt_label", i))
            if not os.path.exists(lbl):
                raise SystemExit(f"local source '{sid}': missing onset labels {lbl}")
            if not os.path.exists(dest):
                raise SystemExit(f"local source '{sid}': missing audio {dest}")
            with open(lbl, encoding="utf-8-sig") as f:
                raw = f.read()
        else:
            raise SystemExit(f"unknown source kind '{kind}' for '{sid}'")
        labels[i] = [float(x) for x in raw.strip().split(",") if x.strip()]
    return labels


def build_audio(cfg, src, verses, bounds):
    """Align this source's word onsets to the reading and write its audio doc."""
    labels = load_source_tracks(src)
    foff, off = {}, 0
    for i in src["pt_files"]:
        foff[i] = off
        off += len(labels[i])

    frange, acc = {}, 0
    for i in src["pt_files"]:
        frange[i] = (acc, acc + len(labels[i]))
        acc += len(labels[i])

    def file_for(gw):
        for i in src["pt_files"]:
            s, e = frange[i]
            if s <= gw < e:
                return i
        return None

    audio_verses, mism = {}, []
    for idx, row in enumerate(verses):
        gs, ge = bounds[idx]
        wc_expected = ge - gs
        fi = file_for(gs)
        if fi is None:
            mism.append((row["ref"], "no audio file"))
            continue
        ons = labels[fi]
        ls, le = gs - foff[fi], ge - foff[fi]
        wons = ons[ls:le]
        if len(wons) != wc_expected:
            mism.append((row["ref"], f"onsets {len(wons)} != wc {wc_expected}"))
        audio_verses[str(row["n"])] = {
            "file": mp3_rel(src, fi),
            "start": round(ons[ls], 3),
            "end": round(ons[le], 3) if le < len(ons) else None,
            "onsets": [round(x, 3) for x in wons],
        }

    audio_doc = {"slug": cfg["slug"],
                 "source": src.get("source_url", "https://pockettorah.com"),
                 "license": src.get("license", "PocketTorah audio & timing metadata, CC-BY-SA. Alignment via WLC."),
                 "attribution": src.get("attribution", "Recorded chanting courtesy of PocketTorah (Neiss & Schwartz), CC-BY-SA."),
                 "verses": audio_verses}
    _write(out_name(cfg, src, "audio.json"), audio_doc)
    print(f"  audio-onset vs WLC mismatches: {len(mism)}" + (f" {mism}" if mism else ""))
    # app-tokenizer alignment (what actually drives the coach)
    tokmm = [(r["ref"], len(js_tokenize(r["text"])), len(audio_verses[str(r["n"])]["onsets"]))
             for r in verses if str(r["n"]) in audio_verses
             and len(js_tokenize(r["text"])) != len(audio_verses[str(r["n"])]["onsets"])]
    print(f"  app-tokenizer vs onset mismatches: {len(tokmm)}" + (f" {tokmm}" if tokmm else ""))
    return audio_verses


def extract_pitch(cfg, src, verses, audio_verses):
    audio_slug = src["audio_slug"]
    sid = src.get("id", DEFAULT_SOURCE)
    text_by_n = {r["n"]: r for r in verses}
    tracks, durations = {}, {}
    for i in src["pt_files"]:
        mp3 = mp3_disk(src, i)
        dst = os.path.join(WAV_DIR, f"{sid}-{audio_slug}-{i}.wav")
        if not os.path.exists(dst):
            os.makedirs(WAV_DIR, exist_ok=True)
            subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{ep.SR}", mp3, dst], check=True)
        sig = ep.read_wav_mono(dst)
        durations[i] = len(sig) / ep.SR
        print(f"  analyzing {audio_slug}-{i} ({durations[i]:.0f}s)...")
        tracks[i] = ep.f0_track(sig)

    # The key each track was analysed under. Torah readings number their files
    # 1..7; a haftarah is one file named "H", so the key stays a string and is
    # matched back against pt_files rather than parsed as an integer.
    by_str = {str(i): i for i in src["pt_files"]}

    def file_num(path):
        return by_str[path.split(f"{audio_slug}-")[1].split(".")[0]]

    trope_data, out_verses = {}, {}
    for v in sorted(int(k) for k in audio_verses.keys()):
        info = audio_verses[str(v)]
        fn = file_num(info["file"])
        ts, f0 = tracks[fn]
        vstart = info["start"]
        vend = info["end"] if info["end"] is not None else durations[fn]
        voiced = f0[(ts >= vstart) & (ts <= vend) & (f0 > 0)]
        if len(voiced) < 5:
            continue
        tonic = float(np.median(voiced))
        onsets = info["onsets"]
        tokens = ep.tokenize(text_by_n[v]["text"])
        words = []
        for k in range(len(onsets)):
            w_start = onsets[k]
            if k + 1 < len(onsets):
                w_end = onsets[k + 1]
            elif info["end"] is not None:
                w_end = info["end"]
            else:
                w_end = min(w_start + 1.4, vend)
            wmask = (ts >= w_start) & (ts < w_end) & (f0 > 0)
            wts, wf0 = ts[wmask], f0[wmask]
            if len(wf0) < 2:
                words.append({"i": k, "start": round(w_start, 3), "end": round(w_end, 3), "steps": [], "raw": []})
                continue
            semis = 12.0 * np.log2(wf0 / tonic)
            if len(semis) >= 3:
                sm = np.copy(semis)
                sm[1:-1] = np.median(np.vstack([semis[:-2], semis[1:-1], semis[2:]]), axis=0)
                semis = sm
            if len(semis) >= 5:
                med = float(np.median(semis))
                octn = np.round((semis - med) / 12.0)
                near = (octn != 0) & (np.abs(semis - med - 12.0 * octn) < 3.0)
                semis = np.where(near, semis - 12.0 * octn, semis)
                keep = np.abs(semis - med) <= 9.0
                wts, wf0, semis = wts[keep], wf0[keep], semis[keep]
            if len(semis) < 2:
                words.append({"i": k, "start": round(w_start, 3), "end": round(w_end, 3), "steps": [], "raw": []})
                continue
            steps_abs = ep.make_steps(wts, semis)
            dur = (w_end - w_start) or 1.0
            steps = [{"t0": round((s[0] - w_start) / dur, 3), "t1": round((s[1] - w_start) / dur, 3),
                      "p": round(s[2], 2)} for s in steps_abs]
            step_r = max(1, len(wts) // 40)
            raw = [{"t": round((wts[j] - w_start) / dur, 3), "p": round(float(semis[j]), 2)}
                   for j in range(0, len(wts), step_r)]
            words.append({"i": k, "start": round(w_start, 3), "end": round(w_end, 3), "steps": steps, "raw": raw})
            if len(semis) >= 5 and steps:
                if k == len(onsets) - 1:
                    key = "sof"
                elif k < len(tokens):
                    pt = ep.primary_taam(tokens[k])
                    key = str(pt) if pt is not None else "none"
                else:
                    key = "none"
                trope_data.setdefault(key, []).append({"r": ep.resample((wts - w_start) / dur, semis), "steps": steps})
        out_verses[str(v)] = {"tonicHz": round(tonic, 2), "start": round(vstart, 3),
                              "end": round(vend, 3), "file": info["file"], "words": words}

    _write(out_name(cfg, src, "pitch.json"), {"slug": cfg["slug"],
           "source": src.get("source_url", "https://pockettorah.com"),
           "license": src.get("pitch_license", "Derived pitch analysis of the source recording."),
           "note": "Per-word note steps from the recording's fundamental; semitones vs each verse's median (tonic).",
           "verses": out_verses}, indent=1)
    print(f"  pitch: {len(out_verses)} verses")

    xs = np.linspace(0.0, 1.0, ep.NSHAPE)
    shapes = {}
    for key, insts in trope_data.items():
        R = np.vstack([d["r"] for d in insts])
        best = int(np.argmin(np.sqrt(((R - R.mean(axis=0)) ** 2).sum(axis=1))))
        rep = insts[best]
        shapes[key] = {"n": len(insts), "steps": rep["steps"],
                       "contour": [{"t": round(float(xs[i]), 3), "p": round(float(rep["r"][i]), 2)}
                                   for i in range(ep.NSHAPE)]}
    _write(out_name(cfg, src, "shapes.json"), {"slug": cfg["slug"],
           "note": "Most-representative (medoid-by-mean) pitch shape per trope.", "shapes": shapes}, indent=1)
    print(f"  shapes: {len(shapes)} tropes")


def _write(name, doc, indent=2):
    path = os.path.join(DATA_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=indent)
    print(f"  wrote {name}")


def manifest_sources(sources):
    out = []
    for s in sources:
        entry = {"id": s.get("id", DEFAULT_SOURCE),
                 "label": s.get("label", s.get("id", DEFAULT_SOURCE))}
        if s.get("default"):
            entry["default"] = True
        if s.get("attribution"):
            entry["attribution"] = s["attribution"]
        if s.get("license"):
            entry["license"] = s["license"]
        out.append(entry)
    # Guarantee exactly one default (first source if none flagged).
    if out and not any(e.get("default") for e in out):
        out[0]["default"] = True
    return out


def register(cfg, sources):
    try:
        manifest = json.load(open(MANIFEST, encoding="utf-8"))
    except FileNotFoundError:
        manifest = [{"slug": "devarim1", "file": "data/devarim1.json",
                     "group": "Parashiyot", "label": "Devarim (Deuteronomy) 1"}]
    prev = next((m for m in manifest if m["slug"] == cfg["slug"]), {})
    # `group` is assigned by organize_readings (one group per sefer, plus one for
    # the haftarot) right below.
    entry = {"slug": cfg["slug"], "file": f"data/{cfg['slug']}.json",
             "label": cfg["label"]}
    kind = cfg.get("kind", "parashah")
    if kind != "parashah":
        entry["kind"] = kind
    # What the app needs to know about a reading before it opens it: which
    # cantillation style teaches it, and (for a haftarah) which parashah it goes
    # with and where in the year it falls, so the menu can be put in order.
    for key in ("tropeStyle", "tradition", "calendarNumber"):
        if cfg.get(key) is not None:
            entry[key] = cfg[key]
    if cfg.get("haftarah"):
        entry["haftarah"] = cfg["haftarah"]
    if sources:
        entry["sources"] = manifest_sources(sources)
    note = cfg.get("note") or prev.get("note")
    if note:
        entry["note"] = note
    manifest = [m for m in manifest if m["slug"] != cfg["slug"]] + [entry]
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"  registered '{cfg['slug']}' in data/readings.json "
          f"({len(entry.get('sources') or [])} source(s))")
    # Re-file the whole menu by sefer, in chumash order.
    import organize_readings
    organize_readings.organize(quiet=True)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in REGISTRY:
        print("usage: build_reading.py <slug>\nknown slugs: " + ", ".join(REGISTRY), file=sys.stderr)
        sys.exit(1)
    slug = sys.argv[1]
    cfg = dict(REGISTRY[slug], slug=slug)
    sources = reading_sources(cfg)
    os.makedirs(AUDIO_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)
    print(f"== building '{slug}' ({len(sources)} audio source(s)) ==")
    print("[1/3] text")
    verses, bounds = build_text(cfg)
    print("[2/3] audio + pitch per source")
    if not sources:
        print("  none: text-only reading; the coach line comes from the measured "
              "trope shapes for its style")
    for src in sources:
        print(f"  -- source '{src.get('id', DEFAULT_SOURCE)}' ({src.get('kind', 'pockettorah')}) --")
        audio_verses = build_audio(cfg, src, verses, bounds)
        extract_pitch(cfg, src, verses, audio_verses)
    print("[3/3] register")
    register(cfg, sources)
    # The trope drills draw their melody and their spliced recitation from
    # whatever is recorded, so a new reading immediately improves both. Torah and
    # haftarah are kept apart: they are different melodies for the same accents,
    # so mixing them would average one into the other.
    import build_trope_index
    import build_trope_shapes
    build_trope_index.build()
    build_trope_shapes.build_all()
    # Without its scroll pages the reading's Torah column silently reflows
    # instead of breaking lines where the scroll does, so pull them in now.
    # (Skipped for Nevi'im, which has no tikkun column data.)
    import build_tikkun
    build_tikkun.build()
    print(f"done: {slug} ({len(verses)} verses, {len(sources)} source(s)). "
          f"Reload the app; it's in the Reading menu.")


if __name__ == "__main__":
    main()
