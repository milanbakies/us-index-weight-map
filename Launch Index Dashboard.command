#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIR="$ROOT/index-dashboard"
PORT="${PORT:-8787}"
URL="http://127.0.0.1:${PORT}"

# Avoid macOS Desktop TCC issues: run Node from $HOME with an absolute script path.
cd "$HOME"

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "Node.js required" message "Install Node.js, then double-click this file again."'
  exit 1
fi

if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  kill "$(lsof -tiTCP:"$PORT" -sTCP:LISTEN)" 2>/dev/null || true
  sleep 0.4
fi

osascript -e "tell application \"Terminal\" to do script \"cd \\\"$HOME\\\" && echo 'US Index Weight Map — live dashboard' && echo 'Auto-refresh enabled. Close this window to stop.' && echo && node \\\"$DIR/server.mjs\\\"\"" >/dev/null

for _ in $(seq 1 40); do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    open "$URL"
    exit 0
  fi
  sleep 0.25
done

osascript -e 'display alert "Dashboard did not start" message "Check the Terminal window for errors."'
exit 1
