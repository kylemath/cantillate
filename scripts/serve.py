#!/usr/bin/env python3
"""Static file server with HTTP Range support so the browser can seek within the
mp3 files (required to play individual verses/words from a shared audio track).
Python's stock http.server ignores Range requests, which breaks audio seeking.
"""
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class RangeHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

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
