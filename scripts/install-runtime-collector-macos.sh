#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 AGENTBOARD_URL RUNTIME_API_KEY" >&2
  exit 2
fi

agentboard_url=$1
runtime_api_key=$2
if [[ ! "$agentboard_url" =~ ^https?://[^[:space:]\']+$ ]]; then
  echo "AGENTBOARD_URL must be an HTTP(S) URL without whitespace" >&2
  exit 2
fi
if [[ ! "$runtime_api_key" =~ ^runtime-[A-Za-z0-9-]+$ ]]; then
  echo "RUNTIME_API_KEY has an invalid format" >&2
  exit 2
fi

source_dir=$(cd "$(dirname "$0")" && pwd)
install_dir="$HOME/Library/Application Support/Agentboard/runtime-collector"
config_dir="$HOME/.config/agentboard"
log_dir="$HOME/Library/Logs/Agentboard"
launch_agents_dir="$HOME/Library/LaunchAgents"
plist="$launch_agents_dir/com.aionda.agentboard-runtime.plist"

mkdir -p "$install_dir" "$config_dir" "$log_dir" "$launch_agents_dir"
install -m 755 "$source_dir/runtime-collector.py" "$install_dir/runtime-collector.py"
install -m 755 "$source_dir/run-runtime-collector.sh" "$install_dir/run-runtime-collector.sh"

umask 077
printf "AGENTBOARD_URL='%s'\nAGENTBOARD_RUNTIME_API_KEY='%s'\n" \
  "$agentboard_url" "$runtime_api_key" > "$config_dir/runtime-collector.env"

sed \
  -e "s|__COLLECTOR_LAUNCHER__|$install_dir/run-runtime-collector.sh|g" \
  -e "s|__LOG_DIR__|$log_dir|g" \
  "$source_dir/com.aionda.agentboard-runtime.plist" > "$plist"

domain="gui/$(id -u)"
launchctl bootout "$domain" "$plist" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
launchctl kickstart -k "$domain/com.aionda.agentboard-runtime"

echo "Installed and started com.aionda.agentboard-runtime"
launchctl print "$domain/com.aionda.agentboard-runtime" | head -30
