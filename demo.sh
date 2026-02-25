#!/usr/bin/env bash
cd "$(dirname "$0")"

# Start server if not running
if ! curl -s http://localhost:3000/api/agents > /dev/null 2>&1; then
  echo "Starting server..."
  npm run build --silent 2>/dev/null
  node dist/server.js &
  SERVER_PID=$!

  # Wait until server is ready
  for i in $(seq 1 30); do
    curl -s http://localhost:3000/api/agents > /dev/null 2>&1 && break
    sleep 0.5
  done
  echo "Server running (PID $SERVER_PID)"
fi

npx tsx demo.ts "$@"
