#!/usr/bin/env bash
# Only kill the process LISTENING on the port – a plain `lsof -ti:3000` would
# also match clients with open connections (e.g. Claude Code via MCP).
PORT="${PORT:-3000}"
kill $(lsof -ti tcp:"$PORT" -sTCP:LISTEN) 2>/dev/null && echo "Server stopped." || echo "No server running on port $PORT."
