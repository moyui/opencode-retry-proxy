#!/bin/bash
# One-shot launcher for opencode-retry-proxy
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE=/tmp/opencode-proxy.pid
LOG=/tmp/opencode-retry-proxy.log
STDOUT=/tmp/opencode-proxy-stdout.log

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "proxy already running pid=$(cat "$PIDFILE") on 127.0.0.1:${LISTEN_PORT:-8765}"
  exit 0
fi
pkill -f "proxy.mjs" 2>/dev/null || true
sleep 0.5
nohup node "$SCRIPT_DIR/proxy.mjs" > "$STDOUT" 2>&1 &
echo $! > "$PIDFILE"
sleep 1
echo "started pid=$(cat "$PIDFILE")"
cat "$STDOUT"
echo "--- verify ---"
# NOTE: a bogus model returns "ModelError: Model test is not supported" —
# that is the proxy forwarding correctly to the upstream, NOT a failure.
curl -s -X POST "http://127.0.0.1:${LISTEN_PORT:-8765}/v1/responses" -H 'content-type: application/json' -d '{"model":"test","input":[]}' 2>&1 | head -c 400; echo
