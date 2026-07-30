#!/usr/bin/env python3
"""Drive the onset labeller in headless Chrome.

scripts/label.html is where a recording made by a person is made usable: the
onsets the aligner guessed get fixed by ear, and the false starts and asides get
cut out. Nothing else in the project checks it, and a regression here does not
throw — it silently writes a track that highlights the wrong word or plays a
stumble back to a child as if it were the reading.

Runs against a scratch copy of a real track, so a failed run cannot damage
anybody's labels. Needs the dev server:

    ./serve.sh 8123
    .venv/bin/python scripts/check_label.py
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

import websocket

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9231
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8123"

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(HERE, "data", "local_sources", "teacher", "i-samuel-28.txt")
SCRATCH = os.path.join(HERE, "data", "local_sources", "teacher", "_check.txt")
URL = f"{BASE}/scripts/label.html?review=data/local_sources/teacher/_check.txt.review.json"

# The mark to work on: a transition partway through the second pasuk, chosen
# because the words on either side of it are long enough to leave room for a cut.
MARK = 31

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"PASS {name}" + (f": {detail}" if detail else ""))
    else:
        fail += 1
        print(f"FAIL {name}" + (f": {detail}" if detail else ""))


def make_fixture():
    """A copy of a real track and its review file, pointed at the copy."""
    if not os.path.exists(SOURCE):
        sys.exit(f"no track to copy at {os.path.relpath(SOURCE, HERE)}")
    shutil.copy(SOURCE, SCRATCH)
    doc = json.load(open(SOURCE + ".review.json", encoding="utf-8"))
    doc["labels"] = os.path.relpath(SCRATCH, HERE)
    for w in doc["words"]:
        w.pop("end", None)
    json.dump(doc, open(SCRATCH + ".review.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    return len(doc["words"])


def drop_fixture():
    for path in (SCRATCH, SCRATCH + ".review.json"):
        if os.path.exists(path):
            os.remove(path)


def main():
    words = make_fixture()
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
         "--autoplay-policy=no-user-gesture-required", "--window-size=1400,900",
         f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
         "--user-data-dir=/tmp/cantillate-label", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        target = None
        for _ in range(80):
            try:
                pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
                target = next((p for p in pages if p["type"] == "page"), None)
                if target:
                    break
            except Exception:                                    # noqa: BLE001
                pass
            time.sleep(0.25)
        if not target:
            sys.exit("could not reach headless Chrome")
        ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=30)
        n = [0]

        def call(method, **params):
            n[0] += 1
            ws.send(json.dumps({"id": n[0], "method": method, "params": params}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == n[0]:
                    return msg

        def js(expr):
            r = call("Runtime.evaluate", expression=f"(async()=>{{ return ({expr}); }})()",
                     returnByValue=True, awaitPromise=True)
            res = r.get("result", {})
            if res.get("exceptionDetails"):
                return {"error": json.dumps(res["exceptionDetails"])[:300]}
            return (res.get("result") or {}).get("value")

        def load():
            call("Page.navigate", url=URL)
            for _ in range(80):
                if js("document.querySelectorAll('.w').length") == words:
                    return True
                time.sleep(0.25)
            return False

        def click(x, y, count):
            for kind in ("mousePressed", "mouseReleased"):
                call("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left",
                     clickCount=count, buttons=1 if kind == "mousePressed" else 0)

        def drag(x, y, dx):
            call("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y,
                 button="left", clickCount=1, buttons=1)
            call("Input.dispatchMouseEvent", type="mouseMoved", x=x + dx, y=y,
                 button="left", buttons=1)
            call("Input.dispatchMouseEvent", type="mouseReleased", x=x + dx, y=y,
                 button="left", clickCount=1, buttons=0)
            time.sleep(0.3)

        # Where a time sits on the canvas, in page pixels.
        def xof(expr):
            return js("(() => { const c = document.getElementById('wave'),"
                      " r = c.getBoundingClientRect();"
                      " const view = Math.max(0, audio.currentTime - 6);"
                      f" return r.left + (({expr}) - view) / 12 * r.width; }})()")

        call("Page.enable")
        call("Runtime.enable")
        check("the labeller loads the track", load(), f"{words} words")

        js(f"(audio.currentTime = onsets[{MARK}], 'ok')")
        time.sleep(0.4)
        geom = js("(() => { const r = document.getElementById('wave').getBoundingClientRect();"
                  " return { y: r.top + r.height / 2, perSec: r.width / 12 }; })()")
        was = js(f"onsets[{MARK}]")

        click(xof(f"onsets[{MARK}]"), geom["y"], 1)
        click(xof(f"onsets[{MARK}]"), geom["y"], 2)
        time.sleep(0.3)
        cut = js(f"({{cut: isCut({MARK}), end: ends[{MARK}], start: onsets[{MARK}],"
                 " marked: document.querySelectorAll('.w.cut').length,"
                 f" label: document.querySelectorAll('.w')[{MARK - 1}].querySelector('.t').textContent}})")
        check("double-clicking a transition cuts it", cut.get("cut") is True, json.dumps(cut))
        check("the word before the cut keeps its end", abs(cut["end"] - was) < 1e-6)
        check("the word after it starts later", cut["start"] > cut["end"] + 0.2,
              f"{cut['start']:.3f}")
        check("the text marks the word that was cut short",
              cut["marked"] == 1 and "\u2192" in cut["label"], cut["label"])

        drag(xof(f"onsets[{MARK}]"), geom["y"], 0.1 * geom["perSec"])
        wider = js(f"({{start: onsets[{MARK}], end: ends[{MARK}], next: ends[{MARK + 1}]}})")
        check("dragging the right edge widens the cut",
              wider["start"] > cut["start"] + 0.05 and abs(wider["end"] - cut["end"]) < 1e-6,
              json.dumps(wider))
        check("a cut cannot swallow the word after it", wider["start"] < wider["next"])

        drag(xof(f"ends[{MARK}]"), geom["y"], -0.2 * geom["perSec"])
        moved = js(f"({{start: onsets[{MARK}], end: ends[{MARK}]}})")
        check("dragging the left edge ends the word earlier",
              moved["end"] < wider["end"] - 0.1 and abs(moved["start"] - wider["start"]) < 1e-6,
              json.dumps(moved))

        heard = js(f"(hearWord({MARK - 1}), loopUntil)")
        js("audio.pause()")
        check("hearing that word stops at the cut, not at the next word",
              abs(heard - moved["end"]) < 1e-6, f"{heard} vs {moved['end']}")
        check("the cut itself belongs to no word",
              js(f"indexAt({(moved['end'] + moved['start']) / 2})") == -1)

        saved = js("save().then(() => document.getElementById('status').textContent)")
        check("saving reports the cut", "1 cut" in str(saved), str(saved))
        marks = open(SCRATCH, encoding="utf-8").read().strip().split(",")
        check("the track writes the cut as one mark",
              marks[MARK].count("-") == 1, marks[MARK])
        check("every other mark is left alone",
              len(marks) == words + 1 and sum(1 for m in marks if "-" in m) == 1)
        review = json.load(open(SCRATCH + ".review.json", encoding="utf-8"))
        check("the review file remembers where the word now ends",
              abs(review["words"][MARK - 1].get("end", 0) - moved["end"]) < 0.001,
              json.dumps(review["words"][MARK - 1].get("end")))

        load()
        time.sleep(0.5)
        check("reopening shows the cut already made", js(f"isCut({MARK})") is True,
              str(js(f"({{start: onsets[{MARK}], end: ends[{MARK}]}})")))

        js(f"(audio.currentTime = ends[{MARK}], 'ok')")
        time.sleep(0.3)
        mid = xof(f"(ends[{MARK}] + onsets[{MARK}]) / 2")
        click(mid, geom["y"], 1)
        click(mid, geom["y"], 2)
        time.sleep(0.3)
        check("double-clicking the cut closes it again", js(f"isCut({MARK})") is False,
              str(js(f"({{start: onsets[{MARK}], end: ends[{MARK}]}})")))
    finally:
        proc.terminate()
        drop_fixture()

    print(f"\n{ok} pass, {fail} fail")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
