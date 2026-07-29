#!/usr/bin/env python3
"""Run scripts/smoke.html in headless Chrome and print its PASS/FAIL report.

Chrome's --dump-dom hangs on this project, so we drive a headless instance over
the DevTools protocol instead: navigate, wait for the page to write "DONE", and
echo the report plus anything the page logged to the console.

    .venv/bin/python scripts/run_smoke.py [url]
"""
import json
import subprocess
import sys
import time
import urllib.request

import websocket

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9222
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8123/scripts/smoke.html"
TIMEOUT = int(sys.argv[2]) if len(sys.argv) > 2 else 180


def main():
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
         f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
         "--user-data-dir=/tmp/cantillate-smoke",
         "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
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
        if not target:
            print("FAIL could not reach headless Chrome")
            return 1

        ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=30)
        seq = [0]

        def send(method, **params):
            seq[0] += 1
            ws.send(json.dumps({"id": seq[0], "method": method, "params": params}))
            return seq[0]

        send("Runtime.enable")
        send("Log.enable")
        send("Page.enable")
        send("Page.navigate", url=URL)

        logs, report = [], None
        # The page fetches and re-analyses every shipped reading, so the wait has
        # to grow with the corpus rather than sit at a round number.
        deadline = time.time() + TIMEOUT
        while time.time() < deadline:
            ws.settimeout(max(0.2, deadline - time.time()))
            try:
                msg = json.loads(ws.recv())
            except Exception:
                break
            method = msg.get("method")
            if method == "Runtime.consoleAPICalled":
                text = " ".join(str(a.get("value", a.get("description", "")))
                                for a in msg["params"].get("args", []))
                logs.append(f"[{msg['params']['type']}] {text}")
            elif method == "Runtime.exceptionThrown":
                d = msg["params"]["exceptionDetails"]
                logs.append(f"[exception] {d.get('text')} {d.get('exception', {}).get('description', '')}")
            elif method == "Log.entryAdded":
                e = msg["params"]["entry"]
                if e.get("level") in ("error", "warning"):
                    logs.append(f"[{e['level']}] {e.get('text')}")

            eid = send("Runtime.evaluate",
                       expression="document.getElementById('out') && document.getElementById('out').textContent",
                       returnByValue=True)
            while True:
                reply = json.loads(ws.recv())
                if reply.get("id") == eid:
                    break
                if reply.get("method") == "Runtime.exceptionThrown":
                    d = reply["params"]["exceptionDetails"]
                    logs.append(f"[exception] {d.get('text')} {d.get('exception', {}).get('description', '')}")
            value = (reply.get("result", {}).get("result", {}) or {}).get("value")
            if value and "DONE" in value:
                report = value
                break
            time.sleep(0.2)

        if logs:
            print("--- console ---")
            for line in logs:
                print(line)
        if report is None:
            # Print whatever the page did manage to write: the last PASS line is
            # what says where it stopped.
            if value:
                print("--- partial report ---")
                print(value)
            print("FAIL page never finished (no DONE marker)")
            return 1
        print(report)
        return 1 if "FAIL" in report else 0
    finally:
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
