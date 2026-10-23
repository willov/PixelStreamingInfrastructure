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
#   STREAMER_HOST        address the streamer port listens on; the streamer has no login,
#                        so keep it on this machine ("" = all interfaces)      (default 127.0.0.1)
#   MAX_SESSION_SECONDS  drop a viewer after this long, 0 = never              (default 7260)
#   BACKEND_ICE_URL      backend route with the STUN/TURN servers, empty = none
#                        (default http://127.0.0.1:5000/movement_analysis/ice_servers)
#   BACKEND_KEY_FILE     file holding the backend's TURN access key            (default ~/backend_turn_access_key)
#   LOG_FOLDER           where the server writes its logs                      (default ~/.local/state/pixelstreaming/logs)
#   REVERSE_PROXY        1 when running behind nginx or ngrok                  (default 0)
#   UNREAL_START_CMD     together with UNREAL_STOP_CMD: run Unreal on demand, a fresh one for each
#   UNREAL_STOP_CMD      viewer, with a waiting line (e.g. "$HOME/start_tmux_sessions.sh restart unreal"
#                        and "... stop unreal"). Unset: Unreal is started by hand and stays up.
#
# Start the backend first: the server asks it for ICE servers when it starts, and a streamer that
# connects before the answer arrives is configured without TURN.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/SignallingWebServer"

PLAYER_PORT="${PLAYER_PORT:-8081}"
STREAMER_PORT="${STREAMER_PORT:-8888}"
STREAMER_HOST="${STREAMER_HOST-127.0.0.1}"
MAX_SESSION_SECONDS="${MAX_SESSION_SECONDS:-7260}"
BACKEND_ICE_URL="${BACKEND_ICE_URL-http://127.0.0.1:5000/movement_analysis/ice_servers}"
BACKEND_KEY_FILE="${BACKEND_KEY_FILE:-$HOME/backend_turn_access_key}"
LOG_FOLDER="${LOG_FOLDER:-$HOME/.local/state/pixelstreaming/logs}"
REVERSE_PROXY="${REVERSE_PROXY:-0}"
UNREAL_START_CMD="${UNREAL_START_CMD:-}"
UNREAL_STOP_CMD="${UNREAL_STOP_CMD:-}"

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
    [ -r "$BACKEND_KEY_FILE" ] || fail "no readable key file at $BACKEND_KEY_FILE. Create it with: echo '<BACKEND_TURN_ACCESS_KEY of the backend>' > $BACKEND_KEY_FILE && chmod 600 $BACKEND_KEY_FILE (or set BACKEND_ICE_URL= to run without backend ICE servers)."
    # The key must not be readable by other accounts.
    if [ -n "$(find "$BACKEND_KEY_FILE" -perm /077 2>/dev/null)" ]; then
        echo "start_server.sh: warning: $BACKEND_KEY_FILE is readable by others; run: chmod 600 $BACKEND_KEY_FILE" >&2
    fi
    ARGS+=(--backend_ice_url "$BACKEND_ICE_URL" --backend_ice_key_file "$BACKEND_KEY_FILE")
else
    echo "start_server.sh: BACKEND_ICE_URL is empty: no TURN credentials will be handed out." >&2
fi

[ -n "$STREAMER_HOST" ] && ARGS+=(--streamer_host "$STREAMER_HOST")
[ "$REVERSE_PROXY" = "1" ] && ARGS+=(--reverse-proxy)
if [ -n "$UNREAL_START_CMD" ] || [ -n "$UNREAL_STOP_CMD" ]; then
    [ -n "$UNREAL_START_CMD" ] && [ -n "$UNREAL_STOP_CMD" ] || fail "UNREAL_START_CMD and UNREAL_STOP_CMD go together."
    ARGS+=(--unreal_start_cmd "$UNREAL_START_CMD" --unreal_stop_cmd "$UNREAL_STOP_CMD")
fi

mkdir -p "$LOG_FOLDER"
echo "Signalling server: page and viewers on port $PLAYER_PORT, streamer on ${STREAMER_HOST:-all interfaces}:$STREAMER_PORT," \
    "viewer limit ${MAX_SESSION_SECONDS}s, ICE servers from ${BACKEND_ICE_URL:-(none)}"
echo "Logs: $LOG_FOLDER"

cd "$SERVER_DIR"
exec node dist/index.js "${ARGS[@]}" "$@"
