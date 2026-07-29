#!/usr/bin/env python3
"""Build haftarot in the order they will be needed — this week's first.

    .venv/bin/python scripts/build_haftarot.py --list
    .venv/bin/python scripts/build_haftarot.py --from-this-week 4
    .venv/bin/python scripts/build_haftarot.py --rest-of-book
    .venv/bin/python scripts/build_haftarot.py haftarah-eikev haftarah-reeh
    .venv/bin/python scripts/build_haftarot.py --all

Each haftarah costs about 2 MB of audio, so they are built a few weeks at a time
rather than all 54 at once. `--from-this-week N` starts from the parashah of the
coming Shabbat and takes the next N, which is the order a reader actually wants
them in; `--rest-of-book` takes every remaining haftarah in the current book of
the Torah.

Which parashah "this week" is comes from the browser-grade Hebrew calendar in
Python's own zoneinfo-free date math via Hebcal's calendar API, falling back to
counting Shabbatot from the fixed anniversary of Simchat Torah if the network is
unavailable — the same question the app answers client-side.

Already-built haftarot are skipped unless --force, so re-running is cheap.
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import haftarot                                   # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
BUILD = os.path.join(HERE, "scripts", "build_reading.py")

HEBCAL = ("https://www.hebcal.com/hebcal?v=1&cfg=json&s=on&geo=none"
          "&start={start}&end={end}")

# Which book of the Torah each parashah's week belongs to, from Hebcal's table.
BOOK_NAMES = {1: "Bereshit", 2: "Shemot", 3: "Vayikra", 4: "Bamidbar", 5: "Devarim"}


def upcoming_parashah(today=None):
    """Hebcal's parashah for the coming Shabbat, or None if it can't be reached."""
    today = today or datetime.date.today()
    start = today
    end = today + datetime.timedelta(days=21)
    url = HEBCAL.format(start=start.isoformat(), end=end.isoformat())
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "cantillate-haftarot/0.1"})
        with urllib.request.urlopen(req, timeout=30) as r:
            doc = json.load(r)
    except Exception as e:  # noqa: BLE001 - offline is a supported state
        print(f"  (Hebcal unreachable: {e})", file=sys.stderr)
        return None
    for item in doc.get("items", []):
        if item.get("category") == "parashat":
            # "Parashat Nitzavim-Vayeilech" -> the first of a combined pair, which
            # is the one whose haftarah is chanted when they are read together.
            name = item["title"].replace("Parashat ", "").strip()
            return name.split("-")[0] if name.count("-") and " " not in name else name
    return None


def slug_for_parashah(name):
    if not name:
        return None
    want = name.replace("'", "").replace("\u2019", "").replace(" ", "").replace("-", "").lower()
    for slug, (parashah, *_rest) in haftarot.PT.items():
        got = parashah.replace("'", "").replace("\u2019", "").replace(" ", "").replace("-", "").lower()
        if got == want:
            return slug
    return None


def built(slug):
    return os.path.exists(os.path.join(DATA, f"{slug}.json"))


def order():
    """Every haftarah slug in calendar order."""
    return haftarot.slugs()


def rotate_to(slugs, start_slug):
    """The year is a cycle, so a list starting at this week wraps around."""
    if start_slug not in slugs:
        return slugs
    i = slugs.index(start_slug)
    return slugs[i:] + slugs[:i]


def book_of(slug):
    num = haftarot.PT[slug][1]
    entry = haftarot.REGISTRY.get(slug) or {}
    return (entry.get("haftarah") or {}).get("torahBook") or _book_from_number(num)


def _book_from_number(num):
    # Hebcal numbers the parashiyot 1..54 straight through the Torah.
    for last, book in ((12, 1), (23, 2), (33, 3), (43, 4), (54, 5)):
        if num <= last:
            return book
    return 5


def build_one(slug, force=False):
    if built(slug) and not force:
        print(f"== {slug}: already built, skipped (use --force to rebuild)")
        return True
    print(f"\n{'=' * 72}\n== {slug}\n{'=' * 72}")
    r = subprocess.run([sys.executable, BUILD, slug], cwd=HERE)
    return r.returncode == 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("slugs", nargs="*", help="explicit haftarah slugs to build")
    ap.add_argument("--list", action="store_true",
                    help="show every haftarah, in calendar order, and whether it's built")
    ap.add_argument("--from-this-week", type=int, metavar="N",
                    help="build the next N haftarot starting with the coming Shabbat's")
    ap.add_argument("--rest-of-book", action="store_true",
                    help="build every remaining haftarah in the current book of the Torah")
    ap.add_argument("--all", action="store_true", help="build all 54 (about 100 MB of audio)")
    ap.add_argument("--force", action="store_true", help="rebuild even if already built")
    args = ap.parse_args()

    all_slugs = order()
    this_week = slug_for_parashah(upcoming_parashah())
    if this_week:
        print(f"this week's haftarah: {this_week} "
              f"(Haftarat {haftarot.parashah_of(this_week)})")

    if args.list:
        for slug in all_slugs:
            mark = "x" if built(slug) else " "
            here = " <- this week" if slug == this_week else ""
            note = " (text only)" if slug in haftarot.TEXT_ONLY else ""
            cfg = haftarot.REGISTRY.get(slug)
            ref = cfg["sefaria_book"] if cfg else "?"
            print(f"  [{mark}] {slug:28s} {ref:12s}{note}{here}")
            
        done = sum(1 for s in all_slugs if built(s))
        print(f"\n{done} of {len(all_slugs)} built")
        return 0

    targets = list(args.slugs)
    if args.all:
        targets = all_slugs
    elif args.from_this_week:
        if not this_week:
            print("could not determine this week's parashah; pass slugs explicitly",
                  file=sys.stderr)
            return 1
        targets = rotate_to(all_slugs, this_week)[:args.from_this_week]
    elif args.rest_of_book:
        if not this_week:
            print("could not determine this week's parashah; pass slugs explicitly",
                  file=sys.stderr)
            return 1
        book = book_of(this_week)
        targets = [s for s in rotate_to(all_slugs, this_week) if book_of(s) == book]

    if not targets:
        ap.print_help()
        return 1

    unknown = [s for s in targets if s not in haftarot.REGISTRY]
    if unknown:
        print(f"unknown haftarah slug(s): {', '.join(unknown)}", file=sys.stderr)
        return 1

    print(f"\nbuilding {len(targets)}: {', '.join(targets)}")
    failed = [s for s in targets if not build_one(s, args.force)]
    print(f"\n{'=' * 72}")
    print(f"built {len(targets) - len(failed)} of {len(targets)}")
    if failed:
        print(f"failed: {', '.join(failed)}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
