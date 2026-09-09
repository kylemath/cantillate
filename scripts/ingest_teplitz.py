#!/usr/bin/env python3
"""Download, map, align, and build Cantor Teplitz High Holiday recordings.

Public files (41 .m4a) from https://www.mjcnj.com/hhrecordings, hosted at
https://images.shulcloud.com/1220/uploads/. No login. Do not re-encode.

    .venv/bin/python scripts/ingest_teplitz.py download
    .venv/bin/python scripts/ingest_teplitz.py link
    .venv/bin/python scripts/ingest_teplitz.py align
    .venv/bin/python scripts/ingest_teplitz.py build
    .venv/bin/python scripts/ingest_teplitz.py all
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from holiday_readings import AUDIO_PARTS, BLESSINGS, REGISTRY  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO = os.path.join(HERE, "audio", "teplitz")
LABELS = os.path.join(HERE, "data", "local_sources", "teplitz")
CATALOG = os.path.join(
    HERE, "backgroundMaterial", "agent1411", "coordinator",
    "manager_M3", "hh_shulcloud_catalog.json")
MAP_PATH = os.path.join(AUDIO, "filename_map.json")
PYTHON = os.path.join(HERE, ".venv", "bin", "python")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")
MANIFEST = os.path.join(HERE, "data", "readings.json")

BUILD_SLUGS = [
    "rh1-torah", "rh1-maftir", "rh1-haftarah",
    "rh2-torah", "rh2-maftir", "rh2-haftarah",
    "yk-torah", "yk-maftir", "yk-haftarah",
    "yk-mincha-torah", "yk-mincha-haftarah",
]


def _req(url):
    return urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "*/*",
                      "Referer": "https://www.mjcnj.com/hhrecordings"})


def cmd_download():
    os.makedirs(AUDIO, exist_ok=True)
    data = json.load(open(CATALOG, encoding="utf-8"))
    seen, ok, skip, fail = set(), 0, 0, 0
    for item in data["m4a"]:
        name = item["file"]
        if name in seen:
            continue
        seen.add(name)
        dest = os.path.join(AUDIO, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 1000:
            print(f"  skip {name}")
            skip += 1
            continue
        try:
            with urllib.request.urlopen(_req(item["url"]), timeout=180) as r:
                body = r.read()
            if len(body) < 1000:
                print(f"  FAIL {name}: short body {len(body)}")
                fail += 1
                continue
            with open(dest, "wb") as f:
                f.write(body)
            print(f"  ok   {name} ({len(body)} bytes)")
            ok += 1
        except Exception as e:
            print(f"  FAIL {name}: {e}")
            fail += 1
    print(f"download: ok={ok} skip={skip} fail={fail} unique={len(seen)}")
    return fail == 0


def pipeline_name(slug, i):
    return f"{slug}-{i}.m4a"


def cmd_link():
    os.makedirs(AUDIO, exist_ok=True)
    mapping = []
    for slug, parts in AUDIO_PARTS.items():
        for p in parts:
            original = p["file"]
            pipe = pipeline_name(slug, p["i"])
            src = os.path.join(AUDIO, original)
            dst = os.path.join(AUDIO, pipe)
            if not os.path.exists(src):
                raise SystemExit(f"missing original {src}")
            if os.path.islink(dst) or os.path.exists(dst):
                os.remove(dst)
            os.symlink(original, dst)
            mapping.append({
                "slug": slug, "i": p["i"], "pipeline": pipe,
                "original": original, "book": p["book"], "range": p["range"],
                "label": f"{slug}-{p['i']}.txt",
            })
            print(f"  {pipe} -> {original}")
    for b in BLESSINGS:
        mapping.append({
            "slug": None, "i": None, "pipeline": None,
            "original": b["file"], "label": b["label"], "kind": "blessing",
        })
    with open(MAP_PATH, "w", encoding="utf-8") as f:
        json.dump({"source": "https://www.mjcnj.com/hhrecordings",
                   "ext": "m4a", "id": "teplitz", "files": mapping},
                  f, indent=2)
    print(f"wrote {os.path.relpath(MAP_PATH, HERE)}")
    return True


def cmd_align(force=False):
    os.makedirs(LABELS, exist_ok=True)
    failed = []
    for slug, parts in AUDIO_PARTS.items():
        for p in parts:
            out = f"{slug}-{p['i']}.txt"
            out_path = os.path.join(LABELS, out)
            if os.path.exists(out_path) and not force:
                print(f"  skip align {out}")
                continue
            audio = os.path.join(AUDIO, pipeline_name(slug, p["i"]))
            if not os.path.exists(audio):
                audio = os.path.join(AUDIO, p["file"])
            cmd = [PYTHON, os.path.join(HERE, "scripts", "align_recording.py"),
                   "--audio", audio, "--book", p["book"], "--range", p["range"],
                   "--id", "teplitz", "--out", out]
            print(f"== align {slug} {p['i']} {p['range']} ==")
            r = subprocess.run(cmd)
            if r.returncode != 0:
                failed.append(out)
                print(f"  FAIL align {out} (exit {r.returncode})")
    if failed:
        print("align failures:", ", ".join(failed))
        return False
    print("align: all parts ok")
    return True


def _manifest_stable(seconds=8):
    """Avoid colliding with M2 if readings.json is mid-write."""
    if not os.path.exists(MANIFEST):
        return True
    t0 = os.path.getmtime(MANIFEST)
    time.sleep(seconds)
    t1 = os.path.getmtime(MANIFEST)
    if t1 != t0:
        print("readings.json changed while waiting — another writer is active")
        return False
    return True


def cmd_build(force_wait=True):
    if force_wait:
        for attempt in range(6):
            if _manifest_stable():
                break
            print(f"  waiting for readings.json to settle ({attempt + 1}/6)")
        else:
            print("  proceeding after waits; will append/replace only HH slugs")
    failed = []
    for slug in BUILD_SLUGS:
        if slug not in REGISTRY:
            print(f"  skip unknown slug {slug}")
            continue
        print(f"== build {slug} ==")
        r = subprocess.run([PYTHON, os.path.join(HERE, "scripts", "build_reading.py"), slug])
        if r.returncode != 0:
            failed.append(slug)
            print(f"  FAIL build {slug}")
    if failed:
        print("build failures:", ", ".join(failed))
        return False
    print("build: all slugs ok")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["download", "link", "align", "build", "all", "status"])
    ap.add_argument("--force-align", action="store_true")
    args = ap.parse_args()
    if args.cmd == "status":
        originals = [p["file"] for parts in AUDIO_PARTS.values() for p in parts]
        originals += [b["file"] for b in BLESSINGS]
        present = sum(1 for n in originals if os.path.exists(os.path.join(AUDIO, n)))
        print(f"audio originals present: {present}/{len(set(originals))}")
        labels = 0
        expected = 0
        for slug, parts in AUDIO_PARTS.items():
            for p in parts:
                expected += 1
                if os.path.exists(os.path.join(LABELS, f"{slug}-{p['i']}.txt")):
                    labels += 1
        print(f"onset labels: {labels}/{expected}")
        return
    ok = True
    if args.cmd in ("download", "all"):
        ok = cmd_download() and ok
    if args.cmd in ("link", "all"):
        ok = cmd_link() and ok
    if args.cmd in ("align", "all"):
        ok = cmd_align(force=args.force_align) and ok
    if args.cmd in ("build", "all"):
        ok = cmd_build() and ok
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
