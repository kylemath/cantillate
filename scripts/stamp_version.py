#!/usr/bin/env python3
"""Content-hash cache-busting stamp.

Computes a hash over the app's cacheable source (HTML/CSS/JS + primary data
JSON), and writes it into:
  - sw.js       -> `const VERSION = '...'`  (so the service worker's cache name
                   changes exactly when content changes, triggering a fresh
                   install + purge of the old caches on the next visit)
  - version.json -> { version, builtAt }    (handy for debugging / display)

Run it before committing/deploying. The repo's git pre-commit hook runs it
automatically and re-stages sw.js + version.json, so you never have to remember
to bump a version by hand — the classic "stale cache" problem is gone.

    python3 scripts/stamp_version.py
"""
import datetime
import glob
import hashlib
import os
import re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SW = os.path.join(HERE, "sw.js")
VERSION_JSON = os.path.join(HERE, "version.json")

# Files whose content should drive the cache version. Audio (huge, never cached)
# and per-verse shards (many, regenerated) are intentionally excluded; changing
# any of these below means users get a fresh service worker + purged caches.
def cacheable_files():
    files = [os.path.join(HERE, "index.html")]
    files += sorted(glob.glob(os.path.join(HERE, "css", "**", "*.css"), recursive=True))
    files += sorted(glob.glob(os.path.join(HERE, "js", "**", "*.js"), recursive=True))
    files += sorted(glob.glob(os.path.join(HERE, "data", "*.json")))
    return files


def sw_without_version(text):
    # Exclude the VERSION line itself from the hash so stamping is stable (only
    # a real content change moves the hash, never our own rewrite).
    return re.sub(r"const VERSION = '[^']*';", "const VERSION = '';", text)


def compute_hash():
    h = hashlib.sha1()
    for path in cacheable_files():
        with open(path, "rb") as f:
            h.update(path.encode("utf-8"))
            h.update(f.read())
    # Fold in sw.js's own logic (minus the VERSION line) so strategy changes bust too.
    if os.path.exists(SW):
        with open(SW, "r", encoding="utf-8") as f:
            h.update(sw_without_version(f.read()).encode("utf-8"))
    return h.hexdigest()[:12]


def main():
    version = "v-" + compute_hash()
    with open(SW, "r", encoding="utf-8") as f:
        sw = f.read()
    new_sw, n = re.subn(r"const VERSION = '[^']*';", f"const VERSION = '{version}';", sw, count=1)
    if n == 0:
        raise SystemExit("stamp_version: could not find `const VERSION = '...';` in sw.js")
    changed = new_sw != sw
    if changed:
        with open(SW, "w", encoding="utf-8") as f:
            f.write(new_sw)
    built_at = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    with open(VERSION_JSON, "w", encoding="utf-8") as f:
        f.write('{\n  "version": "%s",\n  "builtAt": "%s"\n}\n' % (version, built_at))
    print(f"stamped {version} ({'sw.js updated' if changed else 'sw.js unchanged'}); wrote version.json")


if __name__ == "__main__":
    main()
