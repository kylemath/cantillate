#!/usr/bin/env python3
"""Which parashah is read on which Shabbat, as a static table the app can read offline.

    .venv/bin/python scripts/build_calendar.py            # 2024-2045
    .venv/bin/python scripts/build_calendar.py 2026 2050
    .venv/bin/python scripts/build_calendar.py --check     # verify without writing
    .venv/bin/python scripts/build_calendar.py --divisions # only the aliyah table

A reader preparing for a bar/bat mitzvah knows the DATE, not the parashah — so the
guided onboarding asks for the date and names the reading. Going from one to the
other needs the Hebrew calendar plus the parashah schedule (which parshiyot are
combined depends on the length of the year and where the festivals fall), and
that is far more than the browser's `Intl` Hebrew calendar can answer on its own.

Rather than reimplement the schedule, we ask Hebcal once at build time for every
Shabbat in a range of civil years and ship the answer as `data/calendar.json`, so
the app needs no network and no calendar math at runtime.

Each record is deliberately small (short keys, refs as plain strings) because the
whole table is one download:

    {"d": "2026-01-03",              # Gregorian date of the Shabbat
     "p": "Vayechi",                 # Hebcal's parashah name
     "he": "\u05d5\u05d9\u05d7\u05d9",             # Hebrew name, without "\u05e4\u05e8\u05e9\u05ea"
     "s": "vayechi",                 # app slug (see scripts/haftarot.py)
     "hd": "14 Tevet 5786",          # Hebrew date
     "hy": 5786,                     # Hebrew year
     "ty": 2,                        # triennial year (1-3) actually read that year
     "t": "Genesis 47:28-50:26",     # the annual Torah reading
     "m": "Genesis 50:23-50:26",     # the annual maftir
     "tm": "Genesis 48:20-48:22",    # that year's triennial maftir
     "h": "I Kings 2:1-12"}          # the haftarah (Ashkenazi)

Each Shabbat also points at where its seven aliyot fall, annually (`aa`) and in
that year's triennial third (`at`), as indices into a pooled `divisions` list.
Only fifteen parashiyot ship as recorded readings with boundaries of their own, so
without these guided mode could not tell a reader learning the third aliyah of any
other week which pesukim are theirs.

Two weeks are combined in a short year and read separately in a long one, so a
combined week carries both slugs:

    {"p": "Matot-Masei", "s": "matot", "c": ["matot", "masei"], ...}

`ty` is derived by matching the year's actual triennial reading against Hebcal's
fixed Y.1/Y.2/Y.3 table (data/hebcal/triennial.json), so it is the same 1-3 index
the app's `aliyot.triennial` block is keyed by rather than a guess from the year
number. Where the two disagree the script says so.

Diaspora schedule (`i=off`): Israel's cycle diverges for part of some years, and
the recordings this app teaches from are the Ashkenazi diaspora ones.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aliyot_build import _load_table, _match_key, TRIENNIAL_URL  # noqa: E402
import haftarot                                                  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(DATA, "calendar.json")

# Wide enough to cover anyone planning a simcha today (a child born this year
# reaches bar mitzvah inside it) and to look back at one already past.
DEFAULT_FROM = 2024
DEFAULT_TO = 2045

API = "https://www.hebcal.com/hebcal"

ATTRIBUTION = ("Parashah schedule from Hebcal (hebcal.com, BSD-2-Clause); diaspora, "
               "Ashkenazi rite. Triennial per R. Eisenberg's CJLS system.")

# Hebcal writes the Hebrew name with the word "parashat" in front; the app puts
# that word in its own chrome, so it is stripped here rather than in the browser.
HE_PREFIX = "\u05e4\u05e8\u05e9\u05ea "


def parashah_slugs():
    """Hebcal parashah name -> app reading slug, for all 54.

    scripts/haftarot.py already holds the verified mapping (its keys are
    `haftarah-<slug>` and its values name the Hebcal parashah), so the two stay
    in step by construction instead of by a second hand-typed table.
    """
    out = {}
    for haft_slug, (parashah, *_rest) in haftarot.PT.items():
        out[parashah] = haft_slug[len("haftarah-"):]
    return out


NAME_TO_SLUG = parashah_slugs()


def slug_of(name):
    """App slug for a parashah name, or None if it isn't one of the 54."""
    if name in NAME_TO_SLUG:
        return NAME_TO_SLUG[name]
    # Hebcal is consistent, but apostrophes and spacing have bitten this project
    # before (see _match_key), so fall back to a normalised comparison.
    want = re.sub(r"[^a-z0-9]", "", name.lower())
    for parashah, slug in NAME_TO_SLUG.items():
        if re.sub(r"[^a-z0-9]", "", parashah.lower()) == want:
            return slug
    return None


def split_combined(name):
    """["Matot", "Masei"] for a combined week, else None.

    Only splits when BOTH halves are real parashiyot, so Lech-Lecha — one
    parashah whose name contains a hyphen — is left alone.
    """
    if "-" not in name:
        return None
    head, _, tail = name.rpartition("-")
    if slug_of(head) and slug_of(tail):
        return [head, tail]
    return None


def fetch_year(year):
    url = (f"{API}?v=1&cfg=json&year={year}&month=x&s=on&i=off&maj=off&min=off"
           f"&mod=off&nx=off&mf=off&ss=off&c=off&geo=none")
    req = urllib.request.Request(url, headers={"User-Agent": "cantillate-calendar/0.1"})
    with urllib.request.urlopen(req, timeout=90) as r:
        doc = json.loads(r.read().decode("utf-8"))
    return [i for i in doc.get("items", []) if i.get("category") == "parashat"]


def triennial_years_table():
    """Hebcal's fixed per-parashah Y.1/Y.2/Y.3 triennial divisions.

    Used to recognise WHICH of the three years a given Shabbat is reading, by
    matching its actual first triennial aliyah against the three candidates.
    """
    tbl = _load_table(TRIENNIAL_URL, "triennial.json")
    return tbl or {}


# Most parashiyot list their three years under "years"; the ones whose division
# depends on a festival reading (Yitro's Ten Commandments, say) list "variations"
# instead, and a variation may be a bare alias to another year ("Y.3": "Y.2").
def _year_blocks(entry):
    blocks = (entry or {}).get("years") or (entry or {}).get("variations") or {}
    out = {}
    for y in (1, 2, 3):
        block = blocks.get(f"Y.{y}")
        seen = 0
        while isinstance(block, str) and seen < 3:
            block = blocks.get(block)
            seen += 1
        if isinstance(block, dict):
            out[y] = block
    return out


def _first_aliyah(block):
    pair = block.get("1") if isinstance(block, dict) else None
    if not pair:
        return None
    return f"{pair[0]}-{pair[1]}"


def triennial_year_of(parashah, leyning, tri_table, book):
    """Which triennial year (1-3) this Shabbat's reading is, or None.

    Compares the year's actual first triennial aliyah with Hebcal's Y.1/Y.2/Y.3
    entries for the parashah. Where two years share a division (Y.3 aliased to
    Y.2) the match is genuinely ambiguous, so the arithmetic cycle below breaks
    the tie. A combined week reads the whole parashah rather than a third of it,
    so there is nothing to match and None is returned.
    """
    tri = (leyning or {}).get("triennial")
    if not tri:
        return None
    got = tri.get("1")
    if not got:
        return None
    # "Genesis 47:28-47:31" -> "47:28-47:31", to compare with the table's refs.
    got_ref = got[len(book):].strip() if book and got.startswith(book) else got
    key = _match_key(parashah, tri_table)
    blocks = _year_blocks(tri_table.get(key) if key else None)
    hits = [y for y in (1, 2, 3)
            if _first_aliyah(blocks.get(y) or {}) == got_ref]
    if len(hits) == 1:
        return hits[0]
    return None


# Which year of the triennial cycle a Hebrew year is. The CJLS cycle is anchored
# at 5756, so the year is ((hy - 5756) mod 3) + 1 — verified against what Hebcal
# actually schedules for every Shabbat in the built range (see report()).
TRIENNIAL_EPOCH = 5756


def cycle_year(hyear):
    return ((hyear - TRIENNIAL_EPOCH) % 3) + 1 if hyear else None


# Which of the seven aliyot covers which pesukim. The app ships only fifteen of the
# 54 parashiyot as recorded readings, and those carry boundaries of their own; for
# every other week guided mode assembles the text out of data/tanakh/, and without
# these it would have nothing to divide by — a reader learning the third aliyah
# would be handed the whole parashah.
#
# Hebcal gives both divisions for each Shabbat, so they are taken as scheduled
# rather than reasoned about: the triennial division of a parashah that is
# sometimes combined with its neighbour depends on the shape of the year, and no
# per-parashah table can say which.
#
# The seven refs repeat (every parashah divides the same way most cycles), so the
# distinct divisions are pooled in one list and each Shabbat holds two indices into
# it — the whole pool costs less than a single year of spelled-out refs.
#
# The maftir is NOT pooled: it moves with the festival calendar (a Shabbat Rosh
# Chodesh maftir comes from another book entirely), so each Shabbat carries its own
# in `m`/`tm`.
ALIYAH_KEYS = ("1", "2", "3", "4", "5", "6", "7")

DIVISIONS_FIELD = ("distinct sets of seven aliyah refs; each Shabbat's aa/at "
                   "index into this list. Refs omit the book, which is the one "
                   "named in that Shabbat's `t`.")


def _seven(block, book):
    """A leyning block's seven aliyot as ["7:12-8:10", ...], or None.

    All seven or nothing: a gap would silently mislabel every aliyah after it,
    which is worse than falling back to the whole reading.

    An aliyah is occasionally from another book altogether — on Shabbat Rosh
    Chodesh the seventh is the Rosh Chodesh reading from Numbers — so a ref that
    names its own book keeps it. The reason Hebcal appends ("| Shabbat Shekalim")
    is dropped: each Shabbat already carries it once, in `special`.
    """
    out = []
    for k in ALIYAH_KEYS:
        ref = (block or {}).get(k)
        if not isinstance(ref, str) or not ref.strip():
            return None
        out.append(_bookless(ref.split("|")[0].strip(), book))
    return out


def _bookless(ref, book):
    """"Numbers 30:2-30:9" -> "30:2-30:9", but only for the reading's own book."""
    if book and ref.startswith(f"{book} "):
        return ref[len(book) + 1:].strip()
    return ref


def pool_divisions(rows):
    """Replace each row's spelled-out aliyot with indices into a shared pool."""
    pool, seen = [], {}

    def index_of(refs):
        key = "|".join(refs)
        if key not in seen:
            seen[key] = len(pool)
            pool.append(refs)
        return seen[key]

    for r in rows:
        annual, tri = r.pop("_a", None), r.pop("_t", None)
        if annual:
            r["aa"] = index_of(annual)
        if tri:
            r["at"] = index_of(tri)
    return pool


def book_of(ref):
    """"Genesis 47:28-50:26" -> "Genesis" (book names can contain a space)."""
    if not ref:
        return None
    m = re.match(r"^(.*?)\s+\d+:\d+", ref)
    return m.group(1) if m else None


def record(item, tri_table):
    leyning = item.get("leyning") or {}
    name = item.get("title", "").replace("Parashat ", "").strip()
    hebrew = item.get("hebrew", "")
    if hebrew.startswith(HE_PREFIX):
        hebrew = hebrew[len(HE_PREFIX):]
    hdate = item.get("hdate", "")
    hyear = int(hdate.rsplit(" ", 1)[-1]) if hdate else None
    torah = leyning.get("torah")
    combined = split_combined(name)
    primary = combined[0] if combined else name
    rec = {
        "d": item.get("date", "")[:10],
        "p": name,
        "he": hebrew,
        "s": slug_of(primary),
        "hd": hdate,
        "hy": hyear,
        "ty": cycle_year(hyear),
        # Only for report(): which year the actual reading identifies itself as,
        # where that is unambiguous. Dropped before the table is written.
        "_read": triennial_year_of(primary, leyning, tri_table, book_of(torah)),
    }
    if combined:
        rec["c"] = [slug_of(p) for p in combined]
    if torah:
        rec["t"] = torah
    # Pooled into `divisions` once every row is in (see pool_divisions).
    rec["_a"] = _seven(leyning, book_of(torah))
    rec["_t"] = _seven(leyning.get("triennial"), book_of(torah))
    if leyning.get("maftir"):
        rec["m"] = leyning["maftir"]
    tri_maftir = (leyning.get("triennial") or {}).get("maftir")
    if tri_maftir:
        rec["tm"] = tri_maftir
    if leyning.get("haftarah"):
        rec["h"] = leyning["haftarah"]
    return rec


def build(year_from, year_to):
    tri_table = triennial_years_table()
    seen = set()
    rows = []
    for year in range(year_from, year_to + 1):
        items = fetch_year(year)
        print(f"  {year}: {len(items)} Shabbatot")
        for item in items:
            rec = record(item, tri_table)
            if not rec["d"] or rec["d"] in seen:
                continue
            seen.add(rec["d"])
            rows.append(rec)
    rows.sort(key=lambda r: r["d"])
    return rows


def report(rows, div=None):
    """Sanity-check the table and describe what it covers. Returns problem count."""
    bad = 0
    if div is not None:
        # Every Shabbat needs both divisions: a reader on the annual cycle and one
        # on the triennial both have to be told which pesukim are their aliyah.
        blind = [r for r in rows if "aa" not in r or "at" not in r]
        if blind:
            bad += len(blind)
            print(f"  FAIL {len(blind)} Shabbatot have no aliyah divisions "
                  f"(first: {blind[0]['d']} {blind[0]['p']})")
        else:
            print(f"  aliyah divisions on all {len(rows)} Shabbatot, "
                  f"{len(div)} distinct")
    missing_slug = [r for r in rows if not r["s"]]
    if missing_slug:
        bad += len(missing_slug)
        names = sorted({r["p"] for r in missing_slug})
        print(f"  FAIL {len(missing_slug)} Shabbatot have no app slug: {names}")

    no_tri = [r for r in rows if not r.get("ty")]
    if no_tri:
        bad += len(no_tri)
        print(f"  FAIL {len(no_tri)} weeks have no triennial year "
              f"(first: {no_tri[0]['d']} {no_tri[0]['p']})")

    # `ty` is the closed form (cycle_year); this asserts it against what Hebcal
    # actually schedules, for every week that names its year unambiguously. A
    # mismatch would send readers to the wrong third of the parashah.
    checked = [r for r in rows if r.get("_read")]
    off = [r for r in checked if r["_read"] != r["ty"]]
    if off:
        bad += len(off)
        print(f"  FAIL {len(off)}/{len(checked)} weeks read a different triennial year "
              f"than ((hy-{TRIENNIAL_EPOCH})%3)+1 predicts (e.g. {off[0]['d']} "
              f"{off[0]['p']}: reads Y.{off[0]['_read']}, predicted Y.{off[0]['ty']})")
    else:
        print(f"  triennial year verified against the actual reading in "
              f"{len(checked)}/{len(rows)} weeks")

    combined = [r for r in rows if "c" in r]
    print(f"  {len(rows)} Shabbatot, {len(combined)} combined weeks, "
          f"{len({r['s'] for r in rows if r['s']})} distinct parashiyot")
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("years", nargs="*", type=int,
                    help=f"first and last civil year (default {DEFAULT_FROM} {DEFAULT_TO})")
    ap.add_argument("--check", action="store_true",
                    help="fetch and verify, but don't write data/calendar.json")
    args = ap.parse_args()
    if len(args.years) == 2:
        year_from, year_to = args.years
    elif len(args.years) == 1:
        year_from = year_to = args.years[0]
    else:
        year_from, year_to = DEFAULT_FROM, DEFAULT_TO

    print(f"[calendar] {year_from}-{year_to}, diaspora")
    rows = build(year_from, year_to)
    div = pool_divisions(rows)
    bad = report(rows, div)
    if args.check:
        return 1 if bad else 0

    doc = {
        "note": ("Which parashah is read on which Shabbat. Built by "
                 "scripts/build_calendar.py so the app can name a reader's parashah "
                 "from the date of their simcha with no network and no calendar math."),
        "source": ATTRIBUTION,
        "tradition": "ashkenaz",
        "israel": False,
        "builtAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": rows[0]["d"] if rows else None,
        "to": rows[-1]["d"] if rows else None,
        "fields": {
            "d": "Gregorian date of the Shabbat (YYYY-MM-DD)",
            "p": "parashah name", "he": "Hebrew name", "s": "app reading slug",
            "c": "both slugs when two parshiyot are combined that week",
            "hd": "Hebrew date", "hy": "Hebrew year",
            "ty": "triennial year (1-3) read that year",
            "t": "annual Torah reading", "m": "annual maftir",
            "tm": "triennial maftir", "h": "haftarah (Ashkenazi)",
            "aa": "index into divisions: the seven annual aliyot",
            "at": "index into divisions: the seven of that year's triennial third",
            "divisions": DIVISIONS_FIELD,
        },
        "shabbatot": [{k: v for k, v in r.items() if not k.startswith("_")}
                      for r in rows],
    }
    write(doc, div)
    return 1 if bad else 0


def write(doc, div):
    # `divisions` sits after the metadata and before the long table, so the file
    # still reads top-down.
    out = {k: v for k, v in doc.items() if k != "shabbatot"}
    out["divisions"] = div
    out["shabbatot"] = doc["shabbatot"]
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    size = os.path.getsize(OUT)
    print(f"[calendar] wrote {os.path.relpath(OUT, HERE)} ({size / 1024:.0f} KB)")


if __name__ == "__main__":
    sys.exit(main())
