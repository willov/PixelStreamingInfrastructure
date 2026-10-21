#!/usr/bin/env bash
# Starts the signalling server with the lab player (see LAB.md).
#
#   scripts/start_server.sh                      # defaults below
#   PLAYER_PORT=80 scripts/start_server.sh       # change a setting through the environment
#   scripts/start_server.sh --log_level_console debug     # anything else goes straight to the server
#
# Settings (environment variables):
#   PLAYER_PORT          port for the page and the viewers' WebSocket          (default 8081)
#   STREAMER_PORT        port the Unreal streamer connects to                  (default 8888)
#   MAX_SESSION_SECONDS  drop a viewer after this long, 0 = never              (default 7260)
#   BACKEND_ICE_URL      backend route with the STUN/TURN servers, empty = none
#                        (default http://127.0.0.1:5000/movement_analysis/ice_servers)
#   BACKEND_KEY_FILE     file holding the backend API key                      (default ~/backend_key)
#   LOG_FOLDER           where the server writes its logs                      (default ~/.local/state/pixelstreaming/logs)
#   REVERSE_PROXY        1 when running behind nginx or ngrok                  (default 0)
#
# Start the backend first: the server asks it for ICE servers when it starts, and a streamer that
# connects before the answer arrives is configured without TURN.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/SignallingWebServer"

PLAYER_PORT="${PLAYER_PORT:-8081}"
STREAMER_PORT="${STREAMER_PORT:-8888}"
MAX_SESSION_SECONDS="${MAX_SESSION_SECONDS:-7260}"
BACKEND_ICE_URL="${BACKEND_ICE_URL-http://127.0.0.1:5000/movement_analysis/ice_servers}"
BACKEND_KEY_FILE="${BACKEND_KEY_FILE:-$HOME/backend_key}"
LOG_FOLDER="${LOG_FOLDER:-$HOME/.local/state/pixelstreaming/logs}"
REVERSE_PROXY="${REVERSE_PROXY:-0}"

fail() {
    echo "start_server.sh: $*" >&2
    exit 1
}

command -v node >/dev/null 2>&1 || fail "node is not installed or not on PATH (this repo needs Node 22)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node $(node --version) is too old, this repo needs Node 22 (see NODE_VERSION)."

[ -f "$SERVER_DIR/dist/index.js" ] && [ -f "$SERVER_DIR/www/lab.html" ] ||
    fail "not built yet. Run: cd $ROOT && npm ci --ignore-scripts && npm run build"

ARGS=(
    --serve
    --http_root "$SERVER_DIR/www"
    --homepage lab.html
    --max_players 1
    --player_port "$PLAYER_PORT"
    --streamer_port "$STREAMER_PORT"
    --max_session_seconds "$MAX_SESSION_SECONDS"
    --log_folder "$LOG_FOLDER"
)

if [ -n "$BACKEND_ICE_URL" ]; then
    [ -r "$BACKEND_KEY_FILE" ] || fail "no readable key file at $BACKEND_KEY_FILE. Create it with: echo '<movement analysis API key>' > $BACKEND_KEY_FILE && chmod 600 $BACKEND_KEY_FILE (or set BACKEND_ICE_URL= to run without backend ICE servers)."
    # The key must not be readable by other accounts.
    if [ -n "$(find "$BACKEND_KEY_FILE" -perm /077 2>/dev/null)" ]; then
        echo "start_server.sh: warning: $BACKEND_KEY_FILE is readable by others; run: chmod 600 $BACKEND_KEY_FILE" >&2
    fi
    ARGS+=(--backend_ice_url "$BACKEND_ICE_URL" --backend_ice_key_file "$BACKEND_KEY_FILE")
else
    echo "start_server.sh: BACKEND_ICE_URL is empty: no TURN credentials will be handed out." >&2
fi

[ "$REVERSE_PROXY" = "1" ] && ARGS+=(--reverse-proxy)

mkdir -p "$LOG_FOLDER"
echo "Signalling server: page and viewers on port $PLAYER_PORT, streamer on $STREAMER_PORT," \
    "viewer limit ${MAX_SESSION_SECONDS}s, ICE servers from ${BACKEND_ICE_URL:-(none)}"
echo "Logs: $LOG_FOLDER"

cd "$SERVER_DIR"
exec node dist/index.js "${ARGS[@]}" "$@"
