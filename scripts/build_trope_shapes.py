#!/usr/bin/env python3
"""Write data/trope-shapes.json — how each accent is really sung, corpus-wide.

js/trope.js carries hand-drawn motifs for every accent: honest sketches of the
shape, but guesses. Every reading also ships a *_shapes.json holding the
most-representative RECORDED instance of each trope it contains, measured off the
cantor. This merges those across the whole corpus so the trope drills can be sung
with the real melody and the real rhythm instead of a sketch — which matters,
because a drill's coach line is the only thing telling you what the accent sounds
like.

Per trope it keeps:
  n        how many recorded instances stand behind it, corpus-wide
  steps    the note steps of the most representative instance
  dur      the median duration of that accent in the recordings, in seconds
  from     which reading the representative instance came from

Run:  python3 scripts/build_trope_shapes.py
"""
import json
import os
import re
import statistics

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(DATA, "trope-shapes.json")

MAQAF, PASEQ = "\u05be", "\u05c0"
DISJUNCTIVE = {0x0591, 0x0592, 0x0593, 0x0594, 0x0595, 0x0596, 0x0597, 0x0598,
               0x0599, 0x059A, 0x059B, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0,
               0x05A1, 0x05AD, 0x05AE}


def tokenize(text):
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


def primary_taam(token):
    marks = [ord(c) for c in token if 0x0591 <= ord(c) <= 0x05AE]
    if not marks:
        return None
    for cp in marks:
        if cp in DISJUNCTIVE:
            return cp
    return marks[0]


def load(path):
    try:
        return json.load(open(path, encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return None


def build():
    manifest = json.load(open(os.path.join(DATA, "readings.json"), encoding="utf-8"))
    slugs = [m["slug"] for m in manifest if m.get("kind", "parashah") == "parashah"]

    candidates, durations = {}, {}
    for slug in slugs:
        shapes = load(os.path.join(DATA, f"{slug}_shapes.json"))
        text = load(os.path.join(DATA, f"{slug}.json"))
        pitch = (load(os.path.join(DATA, f"{slug}_pitch.slim.json"))
                 or load(os.path.join(DATA, f"{slug}_pitch.json")))
        if shapes:
            for key, sh in (shapes.get("shapes") or {}).items():
                if sh.get("steps") and sh.get("contour"):
                    candidates.setdefault(key, []).append({**sh, "from": slug})
        # How long the cantor actually spends on a word carrying each accent.
        if text and pitch:
            for v in text["verses"]:
                pv = (pitch.get("verses") or {}).get(str(v["n"]))
                if not pv:
                    continue
                toks = tokenize(v["text"])
                for w in pv.get("words") or []:
                    i = w.get("i")
                    if i is None or i >= len(toks) or w.get("start") is None:
                        continue
                    key = "sof" if i == len(toks) - 1 else (
                        str(primary_taam(toks[i])) if primary_taam(toks[i]) is not None else "none")
                    d = (w.get("end") or 0) - w["start"]
                    # Generous upper bound: a Shalshelet or Pazer can run past
                    # four seconds, and those are exactly the ones worth timing.
                    if 0.15 < d < 8.0:
                        durations.setdefault(key, []).append(d)

    merged = {}
    for key, cands in candidates.items():
        total = sum(c.get("n", 1) for c in cands)
        # The representative instance from each reading, weighted by how many
        # instances stood behind it; keep the one closest to that weighted mean,
        # so a parashah with three examples can't outvote one with three hundred.
        grid = len(cands[0]["contour"])
        cands = [c for c in cands if len(c["contour"]) == grid] or cands[:1]
        mean = [sum(c["contour"][i]["p"] * c.get("n", 1) for c in cands) / max(1, total)
                for i in range(len(cands[0]["contour"]))]
        best = min(cands, key=lambda c: sum((c["contour"][i]["p"] - mean[i]) ** 2
                                            for i in range(len(mean))))
        entry = {"n": total, "steps": best["steps"], "from": best["from"]}
        if durations.get(key):
            entry["dur"] = round(statistics.median(durations[key]), 3)
        merged[key] = entry

    doc = {
        "note": "How each accent is really sung, merged across every recorded reading. "
                "Built by scripts/build_trope_shapes.py; used for the trope drills' coach "
                "line so a drill is taught with the cantor's melody, not a sketch.",
        "readings": slugs,
        "shapes": merged,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(OUT) / 1024
    top = sorted(merged.items(), key=lambda kv: -kv[1]["n"])[:5]
    print(f"  wrote data/trope-shapes.json: {len(merged)} tropes from {len(slugs)} readings "
          f"({size:.0f} KB)")
    print("   best-attested: " + ", ".join(
        f"{k}(n={v['n']}, {v.get('dur', '?')}s)" for k, v in top))
    thin = [k for k, v in merged.items() if v["n"] < 5]
    if thin:
        print(f"   thin evidence (<5 instances): {', '.join(thin)}")


if __name__ == "__main__":
    build()
