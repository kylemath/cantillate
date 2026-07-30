#!/usr/bin/env python3
"""Static file server with HTTP Range support so the browser can seek within the
mp3 files (required to play individual verses/words from a shared audio track).
Python's stock http.server ignores Range requests, which breaks audio seeking.

It also takes a POST from scripts/label.html to save a corrected onset track, so
fixing a word's timing by ear is one keystroke rather than a copy-paste round
trip. Writes are confined to data/local_sources/.
"""
import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import onsettrack                                            # noqa: E402

SAVE_PATH = "/_save_labels"
SAVE_ROOT = os.path.join("data", "local_sources")


class RangeHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_POST(self):
        if self.path != SAVE_PATH:
            self.send_error(404)
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            rel = os.path.normpath(body["labels"]).lstrip("/")
            if not rel.startswith(SAVE_ROOT + os.sep) or not rel.endswith(".txt"):
                raise ValueError(f"refusing to write outside {SAVE_ROOT}/: {rel}")
            # Mark-indexed, as in scripts/onsettrack.py: `onsets[i]` opens the
            # word at mark i and `ends[i]` closes the one before it. They differ
            # only where the labeller cut something out.
            onsets = [float(t) for t in body["onsets"]]
            ends = [float(t) for t in body.get("ends") or onsets]
            bad = onsettrack.check(onsets, ends)
            if bad:
                raise ValueError(bad)
            with open(rel, "w") as f:
                f.write(onsettrack.dump(onsets, ends))
            review = rel + ".review.json"
            if os.path.exists(review):
                doc = json.load(open(review))
                for i, w in enumerate(doc.get("words", [])):
                    if i >= len(onsets):
                        break
                    w["t"] = round(onsets[i], 3)
                    # A word's own end, carried only when it was cut short — so
                    # reopening the labeller shows the cuts already made.
                    if i + 1 < len(ends) and round(ends[i + 1], 3) != round(onsets[i + 1], 3):
                        w["end"] = round(ends[i + 1], 3)
                    else:
                        w.pop("end", None)
                doc["end"] = round(ends[-1], 3)
                doc["corrected"] = True
                json.dump(doc, open(review, "w"), ensure_ascii=False, indent=1)
            cut = len(onsettrack.cuts(onsets, ends))
            self.reply({"ok": True, "wrote": rel, "marks": len(onsets), "cuts": cut})
        except Exception as e:                                   # noqa: BLE001
            self.reply({"ok": False, "error": str(e)}, 400)

    def reply(self, payload, code=200):
        blob = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def send_head(self):
        rng = self.headers.get("Range")
        if rng is None:
            return super().send_head()

        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        if not m:
            return super().send_head()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()

        size = os.path.getsize(path)
        start_s, end_s = m.group(1), m.group(2)
        if start_s == "":  # suffix range: last N bytes
            length = int(end_s)
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        end = min(end, size - 1)
        if start > end:
            self.send_error(416, "Requested Range Not Satisfiable")
            return None

        length = end - start + 1
        ctype = self.guess_type(path)
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206, "Partial Content")
        self.send_header("Content-type", ctype)
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        # Hand back a limited reader.
        return _LimitedReader(f, length)


class _LimitedReader:
    def __init__(self, f, length):
        self.f = f
        self.remaining = length

    def read(self, amt=-1):
        if self.remaining <= 0:
            return b""
        if amt < 0 or amt > self.remaining:
            amt = self.remaining
        data = self.f.read(amt)
        self.remaining -= len(data)
        return data

    def close(self):
        self.f.close()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    httpd = ThreadingHTTPServer(("", port), RangeHandler)
    print(f"Cantillate (range-enabled) at http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
