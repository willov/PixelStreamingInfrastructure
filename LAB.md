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

Two ways to give peers TURN credentials. Use one.

### From the backend (no TURN setup on this server)

```bash
echo "<movement analysis API key>" > /path/to/backend_key && chmod 600 /path/to/backend_key
node dist/index.js ... --backend_ice_url http://127.0.0.1:5000/movement_analysis/ice_servers \
    --backend_ice_key_file /path/to/backend_key        # or BACKEND_API_KEY in the environment
```

The signalling server asks the backend (`GET /movement_analysis/ice_servers`, Bearer key, server to server)
for the ICE servers it already creates from Cloudflare, keeps a cached copy, refreshes it every hour
(sooner if the credentials are close to expiring), and gives it to every viewer and to the Unreal
streamer in their `config` message, after any `--peer_options` servers. While nothing is cached, or the
cached credentials are about to expire, peers get only the static `--peer_options`, with a warning in
the log. Cannot be combined with `--turn_secret`.

The backend's lease for this route is 24 hours (`TURN_PEER_LEASE_TTL`, at most 48 h), longer than the
4 hours it uses for session responses. **A streamer receives its ICE servers once, when it connects, and
the protocol cannot replace them**, so its TURN credentials stop working when the lease ends unless
the streamer reconnects. Reconnecting it before then is not implemented yet. Viewers always get fresh ones.
Peers that connect before the first answer arrives from the backend are configured without TURN, so
start the backend first.

### With a coturn server

The 5.8 signalling server issues time-limited TURN credentials itself, for coturn's `use-auth-secret`
mode: `--turn_secret_file <file>` (matching `static-auth-secret` in turnserver.conf) and
`--turn_ttl <seconds>` (default 86400, for players; streamers get a long-lived one). Put the TURN server in
`--peer_options` / `--peer_options_file`, e.g. `{"iceServers":[{"urls":["stun:host:3478","turn:host:3478"]}]}`.
Cloudflare TURN does not use this scheme (its credentials come from its own API), so it cannot be
used with `--turn_secret`.

## Test

`node Extras/lab-e2e/e2e.mjs` (after the build; `CHROMIUM=/path/to/chromium` if it is not `/usr/bin/chromium`).
It starts the signalling server with `--max_players 1`, serves Epic's mock streamer
(`Extras/JSStreamer`, a stand-in for Unreal) and drives real browsers through: video without UI, touch
forwarded, mouse not captured, a second viewer waiting and taking over, and the idle timeout.
Not covered: a real Unreal streamer, and playback over a real network. The backend ICE servers are
covered by `SignallingWebServer/src/backendIceServers.test.ts` (`npm test` there).
