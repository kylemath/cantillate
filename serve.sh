#!/usr/bin/env bash
# Serve the Cantillate MVP locally. Web Audio + mic require http (not file://).
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "Open http://localhost:${PORT} in Chrome/Edge/Safari and allow microphone access."
# Range-enabled server so audio seeking (per-verse / per-word playback) works.
python3 scripts/serve.py "$PORT"
