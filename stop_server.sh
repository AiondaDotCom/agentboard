#!/usr/bin/env bash
# Only kill the process LISTENING on port 3000 – a plain `lsof -ti:3000` would
# also match clients with open connections (e.g. Claude Code via MCP).
kill $(lsof -ti tcp:3000 -sTCP:LISTEN) 2>/dev/null && echo "Server stopped." || echo "No server running on port 3000."
