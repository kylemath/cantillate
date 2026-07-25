#!/usr/bin/env python3
"""Screenshot the app in headless Chrome after running a setup expression.

    .venv/bin/python scripts/shot.py out.png "JS to run first"
"""
import base64
import json
import subprocess
import sys
import time
import urllib.request

import websocket

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9224
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/shot.png"
SETUP = sys.argv[2] if len(sys.argv) > 2 else "'ok'"
URL = sys.argv[3] if len(sys.argv) > 3 else "http://localhost:8123/index.html"
W, H = (int(x) for x in (sys.argv[4] if len(sys.argv) > 4 else "1440x1100").split("x"))

proc = subprocess.Popen(
    [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
     f"--window-size={W},{H}",
     f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
     "--user-data-dir=/tmp/cantillate-shot", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    target = None
    for _ in range(80):
        try:
            pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
            target = next((p for p in pages if p["type"] == "page"), None)
            if target:
                break
        except Exception:
            pass
        time.sleep(0.25)
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=30)
    n = [0]

    def call(method, **params):
        n[0] += 1
        ws.send(json.dumps({"id": n[0], "method": method, "params": params}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == n[0]:
                return msg

    call("Page.enable")
    call("Runtime.enable")
    call("Emulation.setDeviceMetricsOverride", width=W, height=H,
         deviceScaleFactor=1, mobile=H > W)
    call("Page.navigate", url=URL)
    for _ in range(60):
        r = call("Runtime.evaluate", expression="document.querySelectorAll('.alsec').length",
                 returnByValue=True)
        if (r.get("result", {}).get("result", {}) or {}).get("value"):
            break
        time.sleep(0.25)
    time.sleep(1.0)
    r = call("Runtime.evaluate", expression=f"(()=>{{ return ({SETUP}); }})()",
             returnByValue=True, awaitPromise=True)
    print("setup:", json.dumps(r.get("result", {}))[:300])
    time.sleep(1.2)
    shot = call("Page.captureScreenshot", format="png")
    with open(OUT, "wb") as f:
        f.write(base64.b64decode(shot["result"]["data"]))
    print("wrote", OUT)
finally:
    proc.terminate()
