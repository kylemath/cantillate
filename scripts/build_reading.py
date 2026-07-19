#!/usr/bin/env python3
"""Build ALL data for a reading in one command, from the scripts/readings.py
registry:

    .venv/bin/python scripts/build_reading.py <slug>

Produces (matching the app's schema, keyed by a sequential per-reading verse
index n):
    data/<slug>.json          Hebrew (MAM) + English + verses + annual/triennial aliyot
    data/<slug>_audio.json    per-verse PocketTorah audio ranges + word onsets
    data/<slug>_pitch.json    per-word note steps (coach line) from the recording
    data/<slug>_shapes.json   representative per-trope pitch shapes
and downloads audio/<audio_slug>-<i>.mp3, then registers the reading in
data/readings.json (the app auto-discovers it — no JS edit needed).

Sources: Sefaria API (text) + PocketTorah GitHub (audio, labels, WLC word counts).
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
from readings import REGISTRY             # noqa: E402

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


def build_text_audio(cfg):
    book = cfg["sefaria_book"]
    chapters_needed = sorted({c for c, _, _ in cfg["range"]})

    he_by_ch, he_version = {}, None
    en_by_ch, en_version = {}, None
    for ch in chapters_needed:
        data = json.loads(get(SEFARIA.format(book=book, ch=ch)).decode("utf-8"))
        he_by_ch[ch] = data.get("he") or []
        he_version = data.get("heVersionTitle") or "Miqra according to the Masorah"
        en, ver = ftr.get_english(book, ch)
        en_by_ch[ch], en_version = en, ver
        print(f"  {book} {ch}: {len(he_by_ch[ch])} he verses; English '{ver}'")

    wlc = json.loads(get(f"{RAW}/data/torah/json/{book}.json").decode("utf-8-sig"))
    wlc_ch = wlc["Tanach"]["tanach"]["book"]["c"]

    def wc(c, v):
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

    # labels + audio
    labels, foff, off = {}, {}, 0
    for i in cfg["pt_files"]:
        name = urllib.parse.quote(cfg["pt_label"].format(i=i))
        onsets = [float(x) for x in get(f"{RAW}/data/torah/labels/{name}")
                  .decode("utf-8-sig").strip().split(",") if x.strip()]
        labels[i], foff[i] = onsets, off
        off += len(onsets)
        dest = os.path.join(AUDIO_DIR, f"{cfg['audio_slug']}-{i}.mp3")
        if not os.path.exists(dest):
            print(f"  downloading {cfg['pt_audio'].format(i=i)} ...")
            with open(dest, "wb") as f:
                f.write(get(f"{RAW}/data/audio/{cfg['pt_audio'].format(i=i)}"))

    frange, acc = {}, 0
    for i in cfg["pt_files"]:
        frange[i] = (acc, acc + len(labels[i]))
        acc += len(labels[i])

    def file_for(gw):
        for i in cfg["pt_files"]:
            s, e = frange[i]
            if s <= gw < e:
                return i
        return None

    audio_verses, mism = {}, []
    for idx, row in enumerate(verses):
        gs, ge = bounds[idx]
        fi = file_for(gs)
        if fi is None:
            mism.append((row["ref"], "no audio file"))
            continue
        ons = labels[fi]
        ls, le = gs - foff[fi], ge - foff[fi]
        wons = ons[ls:le]
        if len(wons) != row["_wc"]:
            mism.append((row["ref"], f"onsets {len(wons)} != wc {row['_wc']}"))
        audio_verses[str(row["n"])] = {
            "file": f"audio/{cfg['audio_slug']}-{fi}.mp3",
            "start": round(ons[ls], 3),
            "end": round(ons[le], 3) if le < len(ons) else None,
            "onsets": [round(x, 3) for x in wons],
        }

    # aliyot
    cv_to_n = {(r["c"], r["v"]): r["n"] for r in verses}

    def find_n(c, v):
        if (c, v) in cv_to_n:
            return cv_to_n[(c, v)]
        cands = [r for r in verses if r["c"] == c and r["v"] <= v]
        best = max(cands, key=lambda r: r["v"]) if cands else verses[0]
        print(f"    snapped aliyah {c}:{v} -> {best['ref']}")
        return best["n"]

    annual = []
    for ai, ((c0, v0), (c1, v1)) in enumerate(cfg.get("annual") or [], start=1):
        s, e = find_n(c0, v0), find_n(c1, v1)
        annual.append({"n": ai, "start": s, "end": e,
                       "ref": f"{verses[s-1]['ref']}{EN_DASH}{verses[e-1]['ref']}"})

    triennial = {}
    for yi, (ylo, yhi) in enumerate(split_contig(1, N, 3), start=1):
        triennial[str(yi)] = [
            {"n": si, "start": s, "end": e,
             "ref": f"{verses[s-1]['ref']}{EN_DASH}{verses[e-1]['ref']}"}
            for si, (s, e) in enumerate(split_contig(ylo, yhi, 7), start=1)]

    for row in verses:
        row.pop("_wc", None)

    text_doc = {"slug": cfg["slug"], "book": cfg["book"], "multiChapter": cfg.get("multiChapter", False),
                "ref": cfg.get("ref"), "heRef": cfg.get("heRef"),
                "versionTitle": he_version, "heVersionTitle": he_version, "enVersionTitle": en_version,
                "license": "Leningrad Codex text is public domain; MAM digital edition CC-BY (Sefaria).",
                "source": "https://www.sefaria.org", "verses": verses}
    if cfg.get("parashah"):
        text_doc["parashah"] = cfg["parashah"]
    if annual or triennial:
        text_doc["aliyot"] = {"annual": annual, "triennial": triennial}

    audio_doc = {"slug": cfg["slug"], "source": "https://pockettorah.com",
                 "license": "PocketTorah audio & timing metadata, CC-BY-SA. Alignment via WLC.",
                 "attribution": "Recorded chanting courtesy of PocketTorah (Neiss & Schwartz), CC-BY-SA.",
                 "verses": audio_verses}

    _write(f"{cfg['slug']}.json", text_doc)
    _write(f"{cfg['slug']}_audio.json", audio_doc)
    print(f"  audio-onset vs WLC mismatches: {len(mism)}" + (f" {mism}" if mism else ""))
    # app-tokenizer alignment (what actually drives the coach)
    tokmm = [(r["ref"], len(js_tokenize(r["text"])), len(audio_verses[str(r["n"])]["onsets"]))
             for r in verses if str(r["n"]) in audio_verses
             and len(js_tokenize(r["text"])) != len(audio_verses[str(r["n"])]["onsets"])]
    print(f"  app-tokenizer vs onset mismatches: {len(tokmm)}" + (f" {tokmm}" if tokmm else ""))
    return verses, audio_verses


def extract_pitch(cfg, verses, audio_verses):
    text_by_n = {r["n"]: r for r in verses}
    tracks, durations = {}, {}
    for i in cfg["pt_files"]:
        src = os.path.join(AUDIO_DIR, f"{cfg['audio_slug']}-{i}.mp3")
        dst = os.path.join(WAV_DIR, f"{cfg['audio_slug']}-{i}.wav")
        if not os.path.exists(dst):
            os.makedirs(WAV_DIR, exist_ok=True)
            subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{ep.SR}", src, dst], check=True)
        sig = ep.read_wav_mono(dst)
        durations[i] = len(sig) / ep.SR
        print(f"  analyzing {cfg['audio_slug']}-{i} ({durations[i]:.0f}s)...")
        tracks[i] = ep.f0_track(sig)

    def file_num(path):
        return int(path.split(f"{cfg['audio_slug']}-")[1].split(".")[0])

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

    _write(f"{cfg['slug']}_pitch.json", {"slug": cfg["slug"], "source": "https://pockettorah.com",
           "license": "Derived pitch analysis of PocketTorah recordings (CC-BY-SA).",
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
    _write(f"{cfg['slug']}_shapes.json", {"slug": cfg["slug"],
           "note": "Most-representative (medoid-by-mean) pitch shape per trope.", "shapes": shapes}, indent=1)
    print(f"  shapes: {len(shapes)} tropes")


def _write(name, doc, indent=2):
    path = os.path.join(DATA_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=indent)
    print(f"  wrote {name}")


def register(cfg):
    try:
        manifest = json.load(open(MANIFEST, encoding="utf-8"))
    except FileNotFoundError:
        manifest = [{"slug": "devarim1", "file": "data/devarim1.json", "label": "Devarim (Deuteronomy) 1"}]
    entry = {"slug": cfg["slug"], "file": f"data/{cfg['slug']}.json", "label": cfg["label"]}
    manifest = [m for m in manifest if m["slug"] != cfg["slug"]] + [entry]
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"  registered '{cfg['slug']}' in data/readings.json")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in REGISTRY:
        print("usage: build_reading.py <slug>\nknown slugs: " + ", ".join(REGISTRY), file=sys.stderr)
        sys.exit(1)
    slug = sys.argv[1]
    cfg = dict(REGISTRY[slug], slug=slug)
    os.makedirs(AUDIO_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)
    print(f"== building '{slug}' ==")
    print("[1/3] text + audio")
    verses, audio_verses = build_text_audio(cfg)
    print("[2/3] pitch + shapes")
    extract_pitch(cfg, verses, audio_verses)
    print("[3/3] register")
    register(cfg)
    print(f"done: {slug} ({len(verses)} verses). Reload the app; it's in the Reading menu.")


if __name__ == "__main__":
    main()
