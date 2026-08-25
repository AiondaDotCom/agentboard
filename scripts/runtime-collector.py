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
    cutoff = time.time() - RECENT_SESSION_SECONDS
    files: list[Path] = []
    for path in root.rglob("*.jsonl"):
        try:
            if path.stat().st_mtime >= cutoff:
                files.append(path)
        except OSError:
            continue
    return files


def tail_records(path: Path) -> list[dict]:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 262_144))
            data = handle.read().decode("utf-8", errors="ignore")
    except OSError:
        return []
    if size > 262_144:
        data = data.split("\n", 1)[-1]
    records = []
    for line in data.splitlines():
        try:
            records.append(json.loads(line))
        except (ValueError, TypeError):
            continue
    return records


def codex_working() -> int:
    working = 0
    for path in recent_jsonl(Path.home() / ".codex" / "sessions"):
        state = None
        for record in tail_records(path):
            if record.get("type") != "event_msg":
                continue
            event = record.get("payload", {}).get("type")
            if event == "task_started":
                state = True
            elif event in ("task_complete", "turn_aborted"):
                state = False
        working += state is True
    return working


def claude_working() -> int:
    working = 0
    for path in recent_jsonl(Path.home() / ".claude" / "projects"):
        state = None
        for record in tail_records(path):
            record_type = record.get("type")
            if record_type == "user":
                state = True
            elif record_type == "assistant":
                stop_reason = record.get("message", {}).get("stop_reason")
                state = stop_reason != "end_turn"
        working += state is True
    return working


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
        headers={"Content-Type": "application/json", "X-Api-Key": api_key},
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
