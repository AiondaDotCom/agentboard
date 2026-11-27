#!/usr/bin/env bash
cd "$(dirname "$0")"

URL="http://${HOST:-localhost}:${PORT:-3000}"
case "${HOST:-}" in ""|"*"|0.0.0.0|::) URL="http://localhost:${PORT:-3000}" ;; esac

# Start server if not running
if ! curl -s "$URL/api/agents" > /dev/null 2>&1; then
  echo "Starting server..."
  npm run build --silent 2>/dev/null
  node dist/server.js &
  SERVER_PID=$!

  # Wait until server is ready
  for i in $(seq 1 30); do
    curl -s "$URL/api/agents" > /dev/null 2>&1 && break
    sleep 0.5
  done
  echo "Server running (PID $SERVER_PID)"
fi

if [ $# -eq 0 ]; then set -- "$URL"; fi
npx tsx demo.ts "$@"
