#!/usr/bin/env python3
"""Real annual + triennial aliyot boundaries, sourced from Hebcal (not hand-typed).

The authoritative divisions come from two small, static JSON tables published by
the Hebcal project (BSD-2-Clause), which implement the standard Ashkenazi full
kriyah and Richard Eisenberg's CJLS triennial system:

    annual (full kriyah):  hebcal-leyning/src/aliyot.json      root[parsha]["fullkriyah"]
    triennial (Y.1/2/3):   hebcal-triennial/src/triennial.json root[parsha]["years"]["Y.N"]

Each table is keyed by parashah English name; each aliyah is a ["c:v","c:v"]
pair (a rare third element is an ignorable note), and the maftir is key "M".
The triennial table is a FIXED per-parashah 1/2/3 table, so no Hebrew-calendar
math is needed to lay out a year's reading. We fetch both files once, cache them
under data/hebcal/, and map the c:v boundaries onto the reading's sequential
verse index n (matching data/<slug>.json). Set HEBCAL_REFRESH=1 to re-download.

`build_aliyot_doc()` returns the exact {annual, triennial[, maftir]} object the
app expects. If Hebcal can't be reached AND there's no cache, it falls back to a
provided annual table and an even-split triennial (the historical behaviour), so
a build never hard-fails on the network.
"""
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(HERE, "data", "hebcal")

ANNUAL_URL = "https://raw.githubusercontent.com/hebcal/hebcal-leyning/master/src/aliyot.json"
TRIENNIAL_URL = "https://raw.githubusercontent.com/hebcal/hebcal-triennial/master/src/triennial.json"

EN_DASH = "\u2013"
ALIYAH_KEYS = ("1", "2", "3", "4", "5", "6", "7")
MAFTIR_KEY = "M"

# Attribution to reproduce alongside any redistributed boundaries.
HEBCAL_ATTRIBUTION = ("Aliyah boundaries from Hebcal (hebcal-leyning & hebcal-triennial, "
                      "BSD-2-Clause); triennial per R. Eisenberg's CJLS system.")

_TABLES = None  # (annual_table, triennial_table) memoised per process


def _fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cantillate-aliyot/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


# Load a Hebcal table, preferring the on-disk cache. Downloads (and caches) when
# the file is missing or HEBCAL_REFRESH is set. Returns None if unavailable so
# callers can fall back gracefully.
def _load_table(url, cache_name):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, cache_name)
    refresh = os.environ.get("HEBCAL_REFRESH")
    if os.path.exists(path) and not refresh:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    try:
        raw = _fetch(url)
    except Exception as e:  # noqa: BLE001 - network is best-effort
        if os.path.exists(path):
            print(f"  [aliyot] fetch failed ({e}); using cached {cache_name}")
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        print(f"  [aliyot] fetch failed ({e}) and no cache at {cache_name}")
        return None
    with open(path, "wb") as f:
        f.write(raw)
    print(f"  [aliyot] cached {cache_name} ({len(raw)} bytes)")
    return json.loads(raw.decode("utf-8"))


def _tables():
    global _TABLES
    if _TABLES is None:
        _TABLES = (_load_table(ANNUAL_URL, "aliyot.json"),
                   _load_table(TRIENNIAL_URL, "triennial.json"))
    return _TABLES


# Hebcal keys parshiyot by an ASCII English name ("Vaetchanan", "Eikev",
# "Achrei Mot", ...). Our registry may spell it with a curly/straight apostrophe
# and/or spaces, so try progressively looser forms before giving up.
def _match_key(name, table):
    if not name or not table:
        return None
    stripped = name.replace("\u2019", "").replace("'", "")
    cands = [name, stripped, stripped.replace(" ", ""), stripped.replace("-", "")]
    for c in cands:
        if c in table:
            return c
    low = {k.lower(): k for k in table}
    for c in cands:
        if c.lower() in low:
            return low[c.lower()]
    return None


def _parse_ref(s):
    c, v = s.split(":")
    return int(c), int(v)


# One aliyah block ({"1":[...], ..., "M":[...]}) -> ordered list of aliyah
# ((c,v),(c,v)) tuples plus the maftir tuple (or None).
def _parse_block(block):
    aliyot = []
    for k in ALIYAH_KEYS:
        pair = block.get(k)
        if not pair:
            continue
        aliyot.append((_parse_ref(pair[0]), _parse_ref(pair[1])))
    maf = block.get(MAFTIR_KEY)
    maftir = (_parse_ref(maf[0]), _parse_ref(maf[1])) if maf else None
    return aliyot, maftir


# Full boundary set for a parashah, or None if Hebcal has nothing for it. Shape:
#   {"annual": [tuples], "annual_maftir": tuple|None,
#    "triennial": {1:[tuples],2:[...],3:[...]}, "triennial_maftir": {1:tuple,...}}
def hebcal_aliyot(parashah_name, hebcal_key=None):
    annual_tbl, tri_tbl = _tables()
    key = hebcal_key or _match_key(parashah_name, annual_tbl) or _match_key(parashah_name, tri_tbl)
    if not key:
        return None
    out = {"annual": [], "annual_maftir": None, "triennial": {}, "triennial_maftir": {}}
    a_entry = (annual_tbl or {}).get(key)
    if a_entry and a_entry.get("fullkriyah"):
        out["annual"], out["annual_maftir"] = _parse_block(a_entry["fullkriyah"])
    t_entry = (tri_tbl or {}).get(key)
    if t_entry and t_entry.get("years"):
        for y in (1, 2, 3):
            block = t_entry["years"].get(f"Y.{y}")
            if not block:
                continue
            aliyot, maf = _parse_block(block)
            out["triennial"][y] = aliyot
            if maf:
                out["triennial_maftir"][y] = maf
    if not out["annual"] and not out["triennial"]:
        return None
    return out


def _indexer(verses):
    """Return (find_n, ref_of) closures over a reading's verse list.

    `verses` is the app's per-verse list (dicts with n, c, v, ref). find_n maps a
    (chapter, verse) to its 1-based reading index, snapping to the nearest earlier
    verse in the same chapter when the exact pasuk isn't loaded (e.g. an aliyah
    that starts before the loaded range).
    """
    cv_to_n = {(r["c"], r["v"]): r["n"] for r in verses}

    def find_n(c, v):
        if (c, v) in cv_to_n:
            return cv_to_n[(c, v)]
        cands = [r for r in verses if r["c"] == c and r["v"] <= v]
        best = max(cands, key=lambda r: r["v"]) if cands else verses[0]
        print(f"    [aliyot] snapped {c}:{v} -> {best['ref']}")
        return best["n"]

    def ref_of(s, e):
        return f"{verses[s - 1]['ref']}{EN_DASH}{verses[e - 1]['ref']}"

    return find_n, ref_of


def _entry(n, cv0, cv1, find_n, ref_of):
    s, e = find_n(*cv0), find_n(*cv1)
    return {"n": n, "start": s, "end": e, "ref": ref_of(s, e)}


def _maftir_entry(cv0, cv1, find_n, ref_of):
    s, e = find_n(*cv0), find_n(*cv1)
    return {"n": MAFTIR_KEY, "start": s, "end": e, "ref": ref_of(s, e)}


def _split_contig(lo, hi, parts):
    total = hi - lo + 1
    base, rem = total // parts, total % parts
    out, cur = [], lo
    for k in range(parts):
        size = base + (1 if k < rem else 0)
        out.append((cur, cur + size - 1))
        cur += size
    return out


def build_aliyot_doc(verses, parashah_name=None, hebcal_key=None, fallback_annual=None):
    """Build data/<slug>.json's `aliyot` object from real Hebcal boundaries.

    Prefers Hebcal's annual + triennial tables (mapped onto verse indices). If
    Hebcal is unavailable, falls back to `fallback_annual` (registry tuples) for
    the annual cycle and an even 3x7 split for the triennial cycle, so a build is
    never blocked. Returns {"annual": [...], "triennial": {"1":[...],...}} plus a
    "maftir" sibling ({"annual": {...}, "triennial": {"1": {...}, ...}}) when the
    maftir is known. `source` names where the boundaries came from.
    """
    find_n, ref_of = _indexer(verses)
    N = len(verses)
    hz = hebcal_aliyot(parashah_name, hebcal_key) if (parashah_name or hebcal_key) else None

    annual, maftir = [], {}
    if hz and hz["annual"]:
        for ai, (cv0, cv1) in enumerate(hz["annual"], start=1):
            annual.append(_entry(ai, cv0, cv1, find_n, ref_of))
        if hz["annual_maftir"]:
            maftir["annual"] = _maftir_entry(*hz["annual_maftir"], find_n, ref_of)
        source = "hebcal"
    else:
        for ai, (cv0, cv1) in enumerate(fallback_annual or [], start=1):
            annual.append(_entry(ai, cv0, cv1, find_n, ref_of))
        source = "registry+split" if (fallback_annual or []) else "split"

    triennial = {}
    if hz and hz["triennial"]:
        tri_maftir = {}
        for y in (1, 2, 3):
            tuples = hz["triennial"].get(y)
            if not tuples:
                continue
            triennial[str(y)] = [_entry(si, cv0, cv1, find_n, ref_of)
                                 for si, (cv0, cv1) in enumerate(tuples, start=1)]
            if hz["triennial_maftir"].get(y):
                tri_maftir[str(y)] = _maftir_entry(*hz["triennial_maftir"][y], find_n, ref_of)
        if tri_maftir:
            maftir["triennial"] = tri_maftir
    else:
        for yi, (ylo, yhi) in enumerate(_split_contig(1, N, 3), start=1):
            triennial[str(yi)] = [
                {"n": si, "start": s, "end": e, "ref": ref_of(s, e)}
                for si, (s, e) in enumerate(_split_contig(ylo, yhi, 7), start=1)]

    doc = {"annual": annual, "triennial": triennial}
    if maftir:
        doc["maftir"] = maftir
    return doc, source
