#!/usr/bin/env python3
"""Refresh ONLY the `aliyot` block of already-built readings, in place.

Rebuilding a reading with build_reading.py re-downloads audio and re-runs the
pitch DSP. When you just need to correct the annual/triennial (+ maftir) aliyah
boundaries, this patches data/<slug>.json using the verses already on disk and
the real Hebcal tables (see aliyot_build.py). It never touches text or audio.

    .venv/bin/python scripts/update_aliyot.py                # all built readings
    .venv/bin/python scripts/update_aliyot.py vaetchanan eikev

Parashah name / overrides come from scripts/readings.py when the slug is in the
REGISTRY, otherwise from the data file's own `parashah.en`.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aliyot_build import build_aliyot_doc, HEBCAL_ATTRIBUTION  # noqa: E402

try:
    from readings import REGISTRY
except Exception:  # noqa: BLE001
    REGISTRY = {}

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(HERE, "data")


def update(slug):
    path = os.path.join(DATA_DIR, f"{slug}.json")
    if not os.path.exists(path):
        print(f"skip {slug}: {path} not found")
        return False
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    verses = doc.get("verses")
    if not verses:
        print(f"skip {slug}: no verses in data file")
        return False

    cfg = REGISTRY.get(slug, {})
    parashah_name = (cfg.get("parashah") or doc.get("parashah") or {}).get("en")
    aliyot_doc, source = build_aliyot_doc(
        verses, parashah_name=parashah_name, hebcal_key=cfg.get("hebcal"),
        fallback_annual=cfg.get("annual"))

    doc["aliyot"] = aliyot_doc
    if source == "hebcal":
        doc["aliyotAttribution"] = HEBCAL_ATTRIBUTION
    else:
        doc.pop("aliyotAttribution", None)

    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)

    maf = aliyot_doc.get("maftir", {})
    print(f"updated {slug} (source={source}): annual={len(aliyot_doc['annual'])}, "
          f"triennial years={sorted(aliyot_doc['triennial'])}, "
          f"maftir annual={'yes' if maf.get('annual') else 'no'}, "
          f"maftir tri={sorted(maf.get('triennial', {}))}")
    for y in sorted(aliyot_doc["triennial"]):
        refs = ", ".join(f"{a['n']}:{a['ref']}" for a in aliyot_doc["triennial"][y])
        mref = maf.get("triennial", {}).get(y)
        if mref:
            refs += f", maf:{mref['ref']}"
        print(f"    Y{y}: {refs}")
    return True


def main():
    slugs = sys.argv[1:]
    if not slugs:
        slugs = sorted(p[:-5] for p in os.listdir(DATA_DIR)
                       if p.endswith(".json") and os.path.isfile(os.path.join(DATA_DIR, p))
                       and json.load(open(os.path.join(DATA_DIR, p), encoding="utf-8")).get("aliyot"))
    print(f"refreshing aliyot for: {', '.join(slugs)}")
    for slug in slugs:
        update(slug)


if __name__ == "__main__":
    main()
