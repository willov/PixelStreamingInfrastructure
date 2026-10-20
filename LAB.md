# Lab additions (UE5.8 branch)

This branch is Epic's `UE5.8` with two additions. Nothing in Epic's code is changed, so merging newer
`UE5.8` commits from `upstream` should not conflict.

## `lab` player: a UI-less page for the avatar

`Frontend/implementations/typescript/src/lab.html` and `lab.ts`. It shows only the video:

- no UI (a plain status text appears only while connecting, waiting or after a timeout)
- touch input is forwarded to the application
- the mouse is not captured (hovering mouse mode, no pointer lock)
- idle timeout: after `AFKTimeout` seconds without input (default 120) a 10 s countdown starts
  (the library's minimum); a touch during it cancels it, otherwise the stream is dropped and the page
  says so. A tap joins again.
- when the streamer is full the page waits and retries every 3 s, so the next viewer takes over
  when the current one leaves

All settings can be overridden with URL parameters, e.g. `/?AFKTimeout=60&retry=5`.

### One viewer at a time

Run the signalling server with `--max_players 1`. A second viewer is refused with `subscribeFailed`
("Streamer ... is full"), which the page turns into the waiting message and keeps retrying.
This is a limit, not an ordered queue: when the slot frees, whichever waiting page retries first
gets it. An ordered queue with positions would need to live in the Backend, which knows the sessions.

## Build and run

```bash
npm ci --ignore-scripts     # --ignore-scripts: only the SFU's mediasoup needs a native worker, which we do not use
npm run build               # builds the lab page into SignallingWebServer/www

cd SignallingWebServer
node dist/index.js --serve --http_root "$PWD/www" --homepage lab.html \
    --max_players 1 --player_port 80 --streamer_port 8888
```

`config.json` still has Epic's Windows default for `http_root`, so pass it explicitly as above.
Behind a reverse proxy such as ngrok or nginx add `--reverse-proxy`. Node 22 (`NODE_VERSION`).

## TURN

The 5.8 signalling server issues time-limited TURN credentials itself, for coturn's
`use-auth-secret` mode: `--turn_secret_file <file>` (matching `static-auth-secret` in turnserver.conf)
and `--turn_ttl <seconds>` (default 86400, for players; streamers get a long-lived one). Put the TURN
server in `--peer_options` / `--peer_options_file`, e.g.
`{"iceServers":[{"urls":["stun:host:3478","turn:host:3478"]}]}`.
Cloudflare TURN does not use this scheme (its credentials come from its own API), so it cannot be
used with `--turn_secret`; use coturn, or static credentials in `--peer_options_file`.

## Test

`node Extras/lab-e2e/e2e.mjs` (after the build; `CHROMIUM=/path/to/chromium` if it is not `/usr/bin/chromium`).
It starts the signalling server with `--max_players 1`, serves Epic's mock streamer
(`Extras/JSStreamer`, a stand-in for Unreal) and drives real browsers through: video without UI, touch
forwarded, mouse not captured, a second viewer waiting and taking over, and the idle timeout.
Not covered: a real Unreal streamer, TURN, and playback over a real network.
