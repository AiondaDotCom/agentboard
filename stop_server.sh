#!/usr/bin/env bash
kill $(lsof -ti:3000) 2>/dev/null && echo "Server stopped." || echo "No server running on port 3000."
