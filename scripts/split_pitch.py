#!/usr/bin/env python3
"""Split monolithic *_pitch.json files for lazy loading.

For each slug this produces:
  data/<slug>_pitch.slim.json      slim monolith (no per-word `raw`)
  data/<slug>_pitch.raw.json       raw-only monolith (i + raw per word)
  data/pitch/<slug>/<N>.json       per-verse slim shard
  data/pitch/<slug>/<N>.raw.json   per-verse raw shard (list of {i, raw})
  data/pitch/<slug>/index.json     manifest {slug, verses, hasRaw}

The original data/<slug>_pitch.json is never modified or deleted.
Pure Python 3 stdlib; safe and idempotent to re-run.
"""

import glob
import json
import os
import sys

# Resolve paths relative to the repo root (parent of this scripts/ dir),
# so the script works regardless of the current working directory.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(REPO_ROOT, "data")
PITCH_DIR = os.path.join(DATA_DIR, "pitch")

ROUND_DP = 4


def round_floats(obj):
    """Recursively round every float in a JSON-like structure to ROUND_DP."""
    if isinstance(obj, float):
        return round(obj, ROUND_DP)
    if isinstance(obj, dict):
        return {k: round_floats(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [round_floats(v) for v in obj]
    return obj


def slim_word(word):
    """Copy a word without its `raw` array, preserving key order otherwise."""
    return {k: v for k, v in word.items() if k != "raw"}


def raw_word(word):
    """Extract just {i, raw} for a word (raw defaults to empty list)."""
    return {"i": word.get("i"), "raw": word.get("raw", [])}


def slim_verse(verse):
    """Build a slim verse object: metadata + words with `raw` removed."""
    out = {k: v for k, v in verse.items() if k != "words"}
    out["words"] = [slim_word(w) for w in verse.get("words", [])]
    return out


def raw_verse(verse):
    """Build the raw-only word list for a verse."""
    return [raw_word(w) for w in verse.get("words", [])]


def write_json(path, obj):
    """Write compact JSON (rounded) and return the byte size written."""
    text = json.dumps(round_floats(obj), ensure_ascii=False, separators=(",", ":"))
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return len(text.encode("utf-8"))


def verse_sort_key(key):
    """Sort verse keys numerically when possible, else lexically."""
    try:
        return (0, int(key))
    except (TypeError, ValueError):
        return (1, key)


def discover_slugs():
    """Find every data/*_pitch.json slug, excluding generated .slim/.raw files."""
    slugs = []
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "*_pitch.json"))):
        name = os.path.basename(path)
        # Skip our own generated monoliths (e.g. foo_pitch.slim.json would end
        # in _pitch.json only via .slim/.raw which are excluded here anyway).
        if name.endswith(".slim.json") or name.endswith(".raw.json"):
            continue
        slugs.append(name[: -len("_pitch.json")])
    return slugs


def process_slug(slug):
    src_path = os.path.join(DATA_DIR, slug + "_pitch.json")
    if not os.path.isfile(src_path):
        print("  ! skip {}: no such file {}".format(slug, src_path))
        return

    original_size = os.path.getsize(src_path)
    with open(src_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    verses = data.get("verses", {})
    verse_keys = sorted(verses.keys(), key=verse_sort_key)

    # (a) slim monolith -----------------------------------------------------
    slim_data = {k: v for k, v in data.items() if k != "verses"}
    slim_data["verses"] = {k: slim_verse(verses[k]) for k in verse_keys}
    slim_path = os.path.join(DATA_DIR, slug + "_pitch.slim.json")
    slim_size = write_json(slim_path, slim_data)

    # (b) raw-only monolith -------------------------------------------------
    raw_data = {
        "slug": data.get("slug", slug),
        "verses": {k: {"words": raw_verse(verses[k])} for k in verse_keys},
    }
    raw_path = os.path.join(DATA_DIR, slug + "_pitch.raw.json")
    raw_size = write_json(raw_path, raw_data)

    # (c/d) per-verse shards ------------------------------------------------
    shard_dir = os.path.join(PITCH_DIR, slug)
    os.makedirs(shard_dir, exist_ok=True)

    verse_ints = []
    for k in verse_keys:
        write_json(os.path.join(shard_dir, k + ".json"), slim_verse(verses[k]))
        write_json(os.path.join(shard_dir, k + ".raw.json"), raw_verse(verses[k]))
        try:
            verse_ints.append(int(k))
        except (TypeError, ValueError):
            pass

    # (e) manifest ----------------------------------------------------------
    manifest = {
        "slug": data.get("slug", slug),
        "verses": sorted(verse_ints),
        "hasRaw": True,
    }
    write_json(os.path.join(shard_dir, "index.json"), manifest)

    # report ----------------------------------------------------------------
    n_verses = len(verse_keys)
    n_shards = n_verses * 2 + 1  # slim + raw per verse + index.json

    def pct(part):
        return (100.0 * part / original_size) if original_size else 0.0

    print("slug: {}".format(slug))
    print("  original : {:>10,} bytes  ({})".format(original_size, os.path.relpath(src_path, REPO_ROOT)))
    print("  slim     : {:>10,} bytes  ({:5.1f}% of original)  -> {}".format(
        slim_size, pct(slim_size), os.path.relpath(slim_path, REPO_ROOT)))
    print("  raw      : {:>10,} bytes  ({:5.1f}% of original)  -> {}".format(
        raw_size, pct(raw_size), os.path.relpath(raw_path, REPO_ROOT)))
    print("  savings  : slim drops {:5.1f}% vs original".format(100.0 - pct(slim_size)))
    print("  verses   : {} verses  ->  {} shard files (+1 index) in {}".format(
        n_verses, n_shards, os.path.relpath(shard_dir, REPO_ROOT)))
    print("")


def main(argv):
    slugs = argv[1:] if len(argv) > 1 else discover_slugs()
    if not slugs:
        print("No *_pitch.json files found in {}".format(DATA_DIR))
        return 1
    os.makedirs(PITCH_DIR, exist_ok=True)
    print("Processing {} slug(s): {}\n".format(len(slugs), ", ".join(slugs)))
    for slug in slugs:
        process_slug(slug)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
