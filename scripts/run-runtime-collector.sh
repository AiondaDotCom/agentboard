#!/usr/bin/env bash
set -euo pipefail

config_file="${AGENTBOARD_RUNTIME_CONFIG:-$HOME/.config/agentboard/runtime-collector.env}"
if [[ ! -r "$config_file" ]]; then
  echo "Missing collector config: $config_file" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$config_file"
set +a

exec /usr/bin/env python3 "$(cd "$(dirname "$0")" && pwd)/runtime-collector.py"
