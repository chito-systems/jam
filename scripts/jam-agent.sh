#!/usr/bin/env bash
# Start a Claude Code session that is connected to JAM under its own name, so the
# workspace can tell which agent is which.
#
#   ./scripts/jam-agent.sh cam-opus-1              # backend agent working for cam
#   ./scripts/jam-agent.sh jake-sonnet-2 frontend  # frontend agent working for jake
#   ./scripts/jam-agent.sh cam-opus-2 backend -- --model opus   # extra args go to claude
#
# Name convention: <human>-<model>-<n>. JAM reads the part before the first dash as
# the person the agent works for. Env: JAM_URL (default the hosted JAM), JAM_TEAM (hh).
set -euo pipefail

name="${1:?usage: jam-agent.sh <human>-<model>-<n> [backend|frontend] [-- claude args]}"
side="${2:-backend}"
[[ "$side" == "backend" || "$side" == "frontend" ]] || { echo "side must be backend or frontend" >&2; exit 1; }
[[ "$name" =~ ^[a-z0-9][a-z0-9-]{1,50}$ ]] || { echo "name must be lowercase letters, digits and dashes, e.g. cam-opus-1" >&2; exit 1; }
shift; [[ $# -gt 0 ]] && shift
[[ "${1:-}" == "--" ]] && shift

url="${JAM_URL:-https://jam.cnh.radarhq.io}/mcp?team_id=${JAM_TEAM:-hh}&who=${name}&side=${side}"
config="$(mktemp -t jam-agent.XXXXXX).json"
trap 'rm -f "$config"' EXIT
printf '{"mcpServers":{"jam":{"type":"http","url":"%s"}}}\n' "$url" > "$config"

echo "Starting Claude Code as agent:${name} (${side}) on JAM. First thing to ask it: \"call whoami, then task_next\"."
claude --mcp-config "$config" "$@"
