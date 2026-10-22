#!/usr/bin/env bash
# Runs the whole lab stack in one tmux session, one window per process:
#
#   ngrok       the public tunnel (ngrok start --all)
#   backend     the Backend container (podman-compose up local; run this script as the account that owns it)
#   signalling  the Pixel Streaming signalling server (scripts/start_server.sh)
#   pentapose   pentapose serve: Backend -> OSC for Unreal
#   unreal      the packaged MocapStream game, started once the signalling server accepts the streamer
#
#   scripts/start_stack.sh               start everything (or attach when it already runs)
#   scripts/start_stack.sh status        which windows run, and which have exited (with their exit code)
#   scripts/start_stack.sh restart NAME  restart one window, e.g. pentapose after a pull
#   scripts/start_stack.sh show [NAME]   print the command a window runs (all of them without a name)
#   scripts/start_stack.sh stop          Ctrl-C every window, then close the session
#   scripts/start_stack.sh attach        look at the session; detach with Ctrl-b d, the stack keeps running
#
# A window whose process exits stays open, showing the last output, until you restart it.
# Every path and command can be overridden through the environment (see below), for example
#   UNREAL_BIN=/other/MocapStream.sh scripts/start_stack.sh
# Build the signalling server and the Backend image by hand when they change; this script only runs them.

set -euo pipefail

SESSION="${SESSION:-dtvisualization}"
BASE="${BASE:-/mnt/storage/digital-twin}"
BACKEND_DIR="${BACKEND_DIR:-$BASE/Backend}"
PIXEL_DIR="${PIXEL_DIR:-$BASE/visualization/PixelStreamingInfrastructure}"
MOCAP_DIR="${MOCAP_DIR:-$BASE/visualization/mocapstreamintounreal}"
UNREAL_BIN="${UNREAL_BIN:-$MOCAP_DIR/Packaged/Linux/MocapStream.sh}"
UNREAL_MAP="${UNREAL_MAP:-/Game/Levels/RefSetup}"
STREAMER_PORT="${STREAMER_PORT:-8888}"
SERVE_PORT="${SERVE_PORT:-9000}"
OSC_PORT="${OSC_PORT:-8000}"
# The Backend container reaches pentapose serve from outside the host's loopback, so serve listens on every
# interface. It has no login yet: keep port $SERVE_PORT closed to the network (firewall) until it has one.
SERVE_HOST="${SERVE_HOST:-0.0.0.0}"

NGROK_CMD="${NGROK_CMD:-ngrok start --all}"
BACKEND_CMD="${BACKEND_CMD:-cd '$BACKEND_DIR' && podman-compose up local}"
SIGNALLING_CMD="${SIGNALLING_CMD:-cd '$PIXEL_DIR' && REVERSE_PROXY=1 scripts/start_server.sh}"
PENTAPOSE_CMD="${PENTAPOSE_CMD:-cd '$MOCAP_DIR/pentapose' && uv run --no-dev pentapose serve --listen-host $SERVE_HOST --listen-port $SERVE_PORT --osc-host 127.0.0.1 --osc-port $OSC_PORT --profile-name metahuman_default_profile --shoulder-offset-deg -90}"
UNREAL_CMD="${UNREAL_CMD:-}"
if [ -z "$UNREAL_CMD" ]; then
    UNREAL_CMD="echo 'unreal: waiting for the signalling server on port $STREAMER_PORT...'; \
for i in \$(seq 90); do (echo > /dev/tcp/127.0.0.1/$STREAMER_PORT) 2>/dev/null && break; sleep 1; done; \
if [ ! -x '$UNREAL_BIN' ]; then echo 'unreal: $UNREAL_BIN not found or not executable (package the project first)'; exit 1; fi; \
cd '$(dirname "$UNREAL_BIN")' && ./$(basename "$UNREAL_BIN") $UNREAL_MAP -RenderOffScreen -ResX=1280 -ResY=720 -ForceRes \
-ExecCmds='t.MaxFPS 30' -PixelStreamingURL=ws://127.0.0.1:$STREAMER_PORT -PixelStreamingEncoderCodec=H264 \
-PixelStreamingWebRTCFps=30 -unattended -log"
fi

WINDOWS=(ngrok backend signalling pentapose unreal)
command_for() {
    case "$1" in
        ngrok) echo "$NGROK_CMD" ;;
        backend) echo "$BACKEND_CMD" ;;
        signalling) echo "$SIGNALLING_CMD" ;;
        pentapose) echo "$PENTAPOSE_CMD" ;;
        unreal) echo "$UNREAL_CMD" ;;
    esac
}

fail() { echo "start_stack.sh: $*" >&2; exit 1; }
command -v tmux >/dev/null || fail "tmux is not installed."
running() { tmux has-session -t "=$SESSION" 2>/dev/null; }

attach() {
    if [ ! -t 1 ]; then return 0; fi
    if [ -n "${TMUX:-}" ]; then
        echo "Already inside tmux: switch with  tmux switch-client -t $SESSION"
    else
        exec tmux attach-session -t "=$SESSION"
    fi
}

start() {
    if running; then
        echo "The session '$SESSION' already runs (stop it first to start again, status shows the windows)."
        attach
        return
    fi
    local first=1 name
    for name in "${WINDOWS[@]}"; do
        if [ "$first" = 1 ]; then
            tmux new-session -d -s "$SESSION" -n "$name" bash -c "$(command_for "$name")"
            first=0
        else
            tmux new-window -d -t "$SESSION:" -n "$name" bash -c "$(command_for "$name")"
        fi
        # A process that exits leaves its window open, so the reason can be read.
        tmux set-option -w -t "$SESSION:=$name" remain-on-exit on
    done
    echo "Started '$SESSION': ${WINDOWS[*]}"
    echo "Look at it with: $0 attach   (detach with Ctrl-b d, it keeps running)"
    attach
}

status() {
    running || { echo "The session '$SESSION' is not running."; return 1; }
    local name line
    for name in "${WINDOWS[@]}"; do
        line="$(tmux list-panes -t "=$SESSION:=$name" -F '#{pane_dead} #{pane_dead_status}' 2>/dev/null | head -1 || true)"
        case "$line" in
            "") printf '  %-11s missing\n' "$name" ;;
            0*) printf '  %-11s running\n' "$name" ;;
            *) printf '  %-11s EXITED (code %s)\n' "$name" "${line#1 }" ;;
        esac
    done
}

restart() {
    local target="${1:-}" name found=0
    [ -n "$target" ] || fail "restart needs a window name: ${WINDOWS[*]}"
    for name in "${WINDOWS[@]}"; do [ "$name" = "$target" ] && found=1; done
    [ "$found" = 1 ] || fail "unknown window '$target' (${WINDOWS[*]})"
    running || fail "the session '$SESSION' is not running."
    tmux respawn-window -k -t "=$SESSION:=$target"
    echo "Restarted $target"
}

show() {
    local name
    for name in ${1:-${WINDOWS[*]}}; do printf '%s:\n  %s\n' "$name" "$(command_for "$name")"; done
}

stop() {
    running || { echo "The session '$SESSION' is not running."; return 0; }
    local name
    for name in "${WINDOWS[@]}"; do tmux send-keys -t "=$SESSION:=$name" C-c 2>/dev/null || true; done
    sleep "${STOP_WAIT:-3}"
    tmux kill-session -t "=$SESSION"
    echo "Stopped '$SESSION'."
}

case "${1:-start}" in
    start) start ;;
    status) status ;;
    restart) restart "${2:-}" ;;
    show) show "${2:-}" ;;
    stop) stop ;;
    attach) running || fail "the session '$SESSION' is not running."; attach ;;
    *) fail "unknown command '$1' (start, status, restart NAME, show, stop, attach)" ;;
esac
