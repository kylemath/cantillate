#!/usr/bin/env python3
"""Rebuild data/tikkun-torah-245.json to cover every registered reading.

The Torah-column view (level 9) puts each word where a real scroll puts it, using
tikkun.io's Davidovich 245-column / 42-line layout. That layout is per PAGE, so a
reading only gets true scroll line breaks if its pages are bundled; a reading
whose pages are missing silently falls back to the reflowed column, whose line
breaks are the browser's, not the scroll's.

This script keeps the bundled pages in step with data/readings.json: it reads the
verse range of every reading, works out which of the 245 pages those verses land
on, and writes exactly those pages (plus one either side, for the context the
reader shows around a portion).

    .venv/bin/python scripts/build_tikkun.py            # rebuild
    .venv/bin/python scripts/build_tikkun.py --check    # report gaps, write nothing

The upstream commit is pinned (see SOURCE) so the layout can't shift underfoot;
bump it deliberately and re-run. Downloads one tarball and caches it in
/tmp/tikkun-io-<sha>/.
"""
import argparse
import io
import json
import os
import sys
import tarfile
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(DATA, "tikkun-torah-245.json")

SOURCE = {
    "project": "tikkun.io",
    "repository": "https://github.com/akivajgordon/tikkun.io",
    "commit": "57ba104e8de055cf92d3cf6aa91245bd92b34d60",
    "license": "MIT",
    "layout": "Davidovich 245-column / 42-line",
}
TARBALL = ("https://codeload.github.com/akivajgordon/tikkun.io/tar.gz/"
           + SOURCE["commit"])
PAGES_IN_TAR = "src/data/pages/torah"
LINES_PER_PAGE = 42

# js/tikkun.js keys pages by the same numbering.
BOOK_NUMBER = {"Genesis": 1, "Exodus": 2, "Leviticus": 3, "Numbers": 4,
               "Deuteronomy": 5}

# A portion is shown with a little of the surrounding scroll around it, and a
# verse can begin on one page and finish on the next, so the span is padded.
PAGE_PADDING = 1


def fetch_pages():
    """The 245 Torah pages from the pinned commit, as {number: [line, ...]}."""
    cache = f"/tmp/tikkun-io-{SOURCE['commit'][:12]}.tar.gz"
    if not os.path.exists(cache):
        print(f"downloading {TARBALL}")
        with urllib.request.urlopen(TARBALL) as r, open(cache, "wb") as f:
            f.write(r.read())
    pages = {}
    with tarfile.open(cache, "r:gz") as tar:
        for member in tar.getmembers():
            parts = member.name.split("/")
            if len(parts) < 3 or not member.isfile():
                continue
            if "/".join(parts[1:-1]) != PAGES_IN_TAR or not parts[-1].endswith(".json"):
                continue
            number = int(parts[-1][:-len(".json")])
            pages[number] = json.load(io.TextIOWrapper(tar.extractfile(member), "utf-8"))
    if not pages:
        sys.exit(f"no pages found under {PAGES_IN_TAR} in the tarball")
    return pages


def page_of_verse(pages):
    """Map every (book, chapter, verse) that STARTS on a page to that page."""
    where = {}
    for number, lines in pages.items():
        for line in lines:
            for ref in line.get("verses", []):
                key = (ref["book"], ref["chapter"], ref["verse"])
                # A verse starts once; keep the first page if data ever repeats.
                where.setdefault(key, number)
    return where


def readings():
    """Registered readings that are real scripture, as (slug, label, [refs])."""
    with open(os.path.join(DATA, "readings.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    out = []
    for entry in manifest:
        path = entry.get("file")
        if not path:
            continue
        full = os.path.join(HERE, path)
        if not os.path.exists(full):
            print(f"  ! {entry['slug']}: {path} is missing, skipped")
            continue
        with open(full, encoding="utf-8") as f:
            data = json.load(f)
        book = BOOK_NUMBER.get(((data.get("book") or {}).get("en")))
        if not book:
            continue  # drills and other synthetic sets have no book
        refs = []
        for verse in data.get("verses", []):
            chapter = verse.get("c") or data.get("chapter")
            number = verse.get("v") or verse.get("n")
            if chapter and number:
                refs.append((book, chapter, number))
        if refs:
            out.append((entry["slug"], entry.get("label", entry["slug"]), refs))
    return out


def build(check=False):
    """Select and write the pages every registered reading needs.

    Returns 0 when the bundled data already covers every reading; with
    check=True nothing is written and a non-zero return means pages are missing.
    """
    pages = fetch_pages()
    where = page_of_verse(pages)
    print(f"{len(pages)} pages upstream, {len(where)} verse starts indexed\n")

    wanted = set()
    gaps = []
    for slug, label, refs in readings():
        found = [where[r] for r in refs if r in where]
        missing = len(refs) - len(found)
        if not found:
            gaps.append((slug, label, len(refs)))
            print(f"  {slug:22} NO PAGES     {label}")
            continue
        lo, hi = min(found), max(found)
        span = range(max(1, lo - PAGE_PADDING), min(max(pages), hi + PAGE_PADDING) + 1)
        wanted.update(span)
        note = f"pages {lo}-{hi}" + (f" ({missing} verses unmatched)" if missing else "")
        print(f"  {slug:22} {note:24} {label}")

    if gaps:
        print(f"\n{len(gaps)} reading(s) have no page at all — check the book/verse refs")

    selected = sorted(wanted)
    print(f"\nselected {len(selected)} of {len(pages)} pages: "
          f"{selected[0]}-{selected[-1]}")

    if check:
        before = json.load(open(OUT, encoding="utf-8"))
        have = sorted(p["number"] for p in before["pages"])
        adding = sorted(set(selected) - set(have))
        print(f"bundled now: {len(have)} pages; would add {len(adding)}: {adding}")
        # Non-zero so this can guard a commit: a reading without its pages reads
        # from a reflowed column, not the scroll's own line breaks.
        return 1 if (adding or gaps) else 0

    out = {
        "source": SOURCE,
        "linesPerPage": LINES_PER_PAGE,
        "pages": [{"number": n, "lines": pages[n]} for n in selected],
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(OUT)
    print(f"wrote {OUT} — {len(selected)} pages, {size / 1024:.0f} KB")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="report which readings lack pages; write nothing")
    return build(check=ap.parse_args().check)


if __name__ == "__main__":
    sys.exit(main())
