#!/usr/bin/env python3
"""Low-overhead Codex/Claude activity collector for Agentboard."""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
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


def process_counts() -> tuple[int, int]:
    """Return running Codex/Claude CLI process counts."""
    result = subprocess.run(
        ["ps", "-axo", "command="],
        check=False,
        capture_output=True,
        text=True,
    )
    running = {"codex": 0, "claude": 0}
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if not parts:
            continue
        executable = Path(parts[0]).name.lower()
        kind = executable if executable in running else None
        if kind is None:
            continue
        running[kind] += 1
    return running["codex"], running["claude"]


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


def status() -> dict[str, int | str]:
    codex, claude = process_counts()
    working_codex = min(codex, codex_working())
    working_claude = min(claude, claude_working())
    return {
        "host": socket.gethostname().split(".")[0],
        "workingCodex": working_codex,
        "workingClaude": working_claude,
        "idleCodex": max(0, codex - working_codex),
        "idleClaude": max(0, claude - working_claude),
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
