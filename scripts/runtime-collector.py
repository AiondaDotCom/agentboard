#!/usr/bin/env python3
"""Low-overhead Codex, Claude Code, OpenCode, and Cursor activity collector."""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen

SCAN_SECONDS = 10
HEARTBEAT_SECONDS = 60
RECENT_SESSION_SECONDS = 600
DISCOVERY_SECONDS = 30

_file_cache: dict[Path, tuple[float, list[Path]]] = {}
_state_cache: dict[Path, tuple[int, bool]] = {}


# Executable basename -> agent kind. Cursor's CLI installs its launcher as
# ~/.local/bin/agent, so its process is named "agent" rather than "cursor".
PROCESS_KINDS = {
    "codex": "codex",
    "claude": "claude",
    "opencode": "opencode",
    "agent": "cursor",
    "cursor-agent": "cursor",
}


def process_counts() -> dict[str, int]:
    """Return running Codex/Claude Code/OpenCode/Cursor CLI process counts."""
    result = subprocess.run(
        ["ps", "-axo", "command="],
        check=False,
        capture_output=True,
        text=True,
    )
    running = {"codex": 0, "claude": 0, "opencode": 0, "cursor": 0}
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if not parts:
            continue
        kind = PROCESS_KINDS.get(Path(parts[0]).name.lower())
        if kind is None:
            continue
        running[kind] += 1
    return running


def recent_jsonl(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    now = time.time()
    cached = _file_cache.get(root)
    if cached is not None and now < cached[0]:
        return [path for path in cached[1] if is_recent(path, now)]
    cutoff = now - RECENT_SESSION_SECONDS
    files: list[Path] = []
    for path in root.rglob("*.jsonl"):
        try:
            if path.stat().st_mtime >= cutoff:
                files.append(path)
        except OSError:
            continue
    _file_cache[root] = (now + DISCOVERY_SECONDS, files)
    return files


def is_recent(path: Path, now: float) -> bool:
    try:
        return path.stat().st_mtime >= now - RECENT_SESSION_SECONDS
    except OSError:
        return False


def records_since(path: Path, offset: int) -> tuple[list[dict], int]:
    try:
        with path.open("rb") as handle:
            handle.seek(offset)
            raw = handle.read()
    except OSError:
        return [], offset
    complete_length = len(raw)
    if raw and not raw.endswith(b"\n"):
        last_newline = raw.rfind(b"\n")
        complete_length = last_newline + 1
        raw = raw[:complete_length]
    records = []
    for line in raw.decode("utf-8", errors="ignore").splitlines():
        try:
            records.append(json.loads(line))
        except (ValueError, TypeError):
            continue
    return records, offset + complete_length


def cached_state(path: Path, kind: str) -> bool:
    try:
        stat = path.stat()
    except OSError:
        return False
    cached = _state_cache.get(path, (0, False))
    offset, state = cached if cached[0] <= stat.st_size else (0, False)
    if offset == stat.st_size:
        return state
    records, offset = records_since(path, offset)
    if kind == "codex":
        for record in records:
            if record.get("type") != "event_msg":
                continue
            event = record.get("payload", {}).get("type")
            if event == "task_started":
                state = True
            elif event in ("task_complete", "turn_aborted"):
                state = False
    elif kind == "cursor":
        for record in records:
            if record.get("type") == "turn_ended":
                state = False
                continue
            role = record.get("role")
            if role == "user":
                state = True
            elif role == "assistant":
                # Mid-turn assistant messages always carry tool calls; the
                # closing message of a turn is text only.
                content = record.get("message", {}).get("content")
                state = isinstance(content, list) and any(
                    isinstance(part, dict) and part.get("type") == "tool_use"
                    for part in content
                )
    else:
        for record in records:
            record_type = record.get("type")
            if record_type == "user":
                state = True
            elif record_type == "assistant":
                state = record.get("message", {}).get("stop_reason") != "end_turn"

    _state_cache[path] = (offset, state)
    return state


def codex_working() -> int:
    return sum(cached_state(path, "codex") for path in recent_jsonl(Path.home() / ".codex" / "sessions"))


def claude_working() -> int:
    return sum(cached_state(path, "claude") for path in recent_jsonl(Path.home() / ".claude" / "projects"))


def opencode_working() -> int:
    """Count active OpenCode sessions, including child/sub-agent sessions."""
    database = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
    if not database.is_file():
        return 0
    cutoff_ms = int((time.time() - RECENT_SESSION_SECONDS) * 1000)
    try:
        connection = sqlite3.connect(
            f"file:{database}?mode=ro",
            uri=True,
            timeout=1,
        )
        try:
            row = connection.execute(
                """
                SELECT COUNT(*)
                FROM session AS session
                JOIN message AS message
                  ON message.id = (
                    SELECT latest.id
                    FROM message AS latest
                    WHERE latest.session_id = session.id
                    ORDER BY latest.time_created DESC, latest.id DESC
                    LIMIT 1
                  )
                WHERE session.time_updated >= ?
                  AND (
                    json_extract(message.data, '$.role') = 'user'
                    OR (
                      json_extract(message.data, '$.role') = 'assistant'
                      AND json_extract(message.data, '$.time.completed') IS NULL
                    )
                  )
                """,
                (cutoff_ms,),
            ).fetchone()
            return int(row[0]) if row is not None else 0
        finally:
            connection.close()
    except (OSError, sqlite3.Error, ValueError):
        return 0


def cursor_working() -> int:
    """Count Cursor CLI sessions that are mid-turn."""
    return sum(cached_state(path, "cursor") for path in recent_jsonl(Path.home() / ".cursor" / "projects"))


def status() -> dict[str, int | str]:
    running = process_counts()
    # Subagents can share their parent CLI process. Count active session turns
    # instead of capping them at the number of OS processes.
    # The process count remains a liveness guard against stale unfinished logs.
    working = {
        "codex": codex_working() if running["codex"] > 0 else 0,
        "claude": claude_working() if running["claude"] > 0 else 0,
        "opencode": opencode_working() if running["opencode"] > 0 else 0,
        "cursor": cursor_working() if running["cursor"] > 0 else 0,
    }
    return {
        "host": socket.gethostname().split(".")[0],
        "workingCodex": working["codex"],
        "workingClaude": working["claude"],
        "workingOpenCode": working["opencode"],
        "workingCursor": working["cursor"],
        "idleCodex": max(0, running["codex"] - working["codex"]),
        "idleClaude": max(0, running["claude"] - working["claude"]),
        "idleOpenCode": max(0, running["opencode"] - working["opencode"]),
        "idleCursor": max(0, running["cursor"] - working["cursor"]),
    }


def send(api_url: str, api_key: str, payload: dict[str, int | str]) -> None:
    request = Request(
        api_url.rstrip("/") + "/api/runtime",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Agentboard-Runtime-Collector/1.0",
            "X-Api-Key": api_key,
        },
        method="POST",
    )
    with urlopen(request, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError(f"Agentboard returned HTTP {response.status}")


def main() -> int:
    api_url = os.environ.get("AGENTBOARD_URL", "http://127.0.0.1:3000")
    api_key = os.environ.get("AGENTBOARD_RUNTIME_API_KEY", "")
    if not api_key:
        print("AGENTBOARD_RUNTIME_API_KEY is required", file=sys.stderr)
        return 2

    previous = None
    last_sent = 0.0
    while True:
        current = status()
        now = time.monotonic()
        if current != previous or now - last_sent >= HEARTBEAT_SECONDS:
            try:
                send(api_url, api_key, current)
                previous = current
                last_sent = now
            except (URLError, HTTPError, OSError, RuntimeError) as error:
                print(f"runtime heartbeat failed: {error}", file=sys.stderr)
        time.sleep(SCAN_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
