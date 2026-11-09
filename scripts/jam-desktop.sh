#!/usr/bin/env bash
# JAM as a desktop app: run the published image on this machine and open it in its own window.
#
#   ./scripts/jam-desktop.sh             run locally (uses ./.env if present, else in-memory demo mode)
#   ./scripts/jam-desktop.sh --update    pull the newest image first, then run
#   ./scripts/jam-desktop.sh --hosted    skip Docker: open the team's hosted JAM in an app window
#   ./scripts/jam-desktop.sh --stop      stop the local container
#
# No clone needed:
#   curl -fsSL https://raw.githubusercontent.com/chito-systems/jam/main/scripts/jam-desktop.sh | bash
#
# Env: JAM_IMAGE (default ghcr.io/chito-systems/jam:latest), JAM_PORT (8787), JAM_URL (hosted URL),
#      JAM_ENV_FILE (default ./.env).
set -euo pipefail

IMAGE="${JAM_IMAGE:-ghcr.io/chito-systems/jam:latest}"
PORT="${JAM_PORT:-8787}"
HOSTED_URL="${JAM_URL:-https://jam.cnh.radarhq.io}"
ENV_FILE="${JAM_ENV_FILE:-.env}"
NAME="jam-desktop"

# Opens a URL in a chromeless app window when a Chromium browser is installed, else the default browser.
open_window() {
  local url="$1"
  if [[ "$(uname)" == "Darwin" ]]; then
    for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
      if [[ -d "/Applications/${app}.app" ]]; then
        open -na "$app" --args --app="$url" --window-size=1440,900
        return
      fi
    done
    open "$url"
    return
  fi
  for bin in google-chrome chromium chromium-browser microsoft-edge brave-browser; do
    if command -v "$bin" >/dev/null 2>&1; then
      "$bin" --app="$url" --window-size=1440,900 >/dev/null 2>&1 &
      return
    fi
  done
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"; else echo "Open $url in your browser."; fi
}

case "${1:-}" in
  --hosted)
    open_window "$HOSTED_URL"
    exit 0
    ;;
  --stop)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "JAM stopped."
    exit 0
    ;;
esac

command -v docker >/dev/null 2>&1 || { echo "Docker is required for local mode. Install it, or run with --hosted." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start it and try again." >&2; exit 1; }

# The image is built for linux/amd64. Apple Silicon and other arm64 hosts run it under emulation.
platform=()
if [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then platform=(--platform linux/amd64); fi

if [[ "${1:-}" == "--update" ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Pulling $IMAGE ..."
  docker pull -q "${platform[@]}" "$IMAGE" >/dev/null
fi

# docker --env-file does not strip trailing comments or skip empty values, so clean a copy first.
clean_env="$(mktemp)"
trap 'rm -f "$clean_env"' EXIT
mode="memory"
if [[ -f "$ENV_FILE" ]]; then
  grep -E '^[A-Z0-9_]+=' "$ENV_FILE" \
    | sed -E 's/[[:space:]]+#.*$//' \
    | grep -vE '^(PORT|API_PORT|NODE_ENV|STORE|WEB_URL|WORKER_URL)=' \
    | grep -vE '^[A-Z0-9_]+=$' > "$clean_env" || true   # drop empty values only (keys can end in '=')
  if grep -q '^ELASTIC_URL=' "$clean_env"; then mode="elastic"; fi
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" "${platform[@]}" --env-file "$clean_env" -e STORE="$mode" -e PORT=8080 -p "127.0.0.1:${PORT}:8080" "$IMAGE" >/dev/null

url="http://localhost:${PORT}"
printf 'Starting JAM'
for _ in $(seq 1 90); do
  if curl -fsS -m 2 "$url/healthz" >/dev/null 2>&1; then
    version="$(curl -fsS -m 2 "$url/healthz" | sed -E 's/.*"version":"([^"]*)".*/\1/')"
    printf '\nJAM %s is running at %s (%s).\n' "$version" "$url" \
      "$([[ "$mode" == "elastic" ]] && echo "your Elasticsearch, from $ENV_FILE" || echo "in-memory demo mode: nothing is saved, voice needs OPENAI_API_KEY in $ENV_FILE")"
    open_window "$url"
    echo "Update: $0 --update   ·   Stop: $0 --stop"
    exit 0
  fi
  printf '.'
  sleep 1
done
printf '\nJAM did not come up. Last log lines:\n' >&2
docker logs --tail 20 "$NAME" >&2
exit 1
