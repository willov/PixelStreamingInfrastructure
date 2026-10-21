# Lab additions (UE5.8 branch)

This branch is Epic's `UE5.8` with two additions. Nothing in Epic's code is changed, so merging newer
`UE5.8` commits from `upstream` should not conflict.

## `lab` player: a UI-less page for the avatar

`Frontend/implementations/typescript/src/lab.html` and `lab.ts`. It shows only the video:

- no UI (a plain status text appears only while connecting, waiting or after a timeout)
- touch input is forwarded to the application
- the mouse is not captured (hovering mouse mode, no pointer lock)
- idle timeout: after `AFKTimeout` seconds without input (default **600**, 10 minutes) a 10 s countdown starts
  (the library's minimum); a touch during it cancels it, otherwise the stream is dropped and the page
  says so. A tap joins again.
- time limit: a session ends after `maxSession` seconds (default **7200**, 2 hours, counted from when the
  video starts), with a message; a tap joins again. `maxSession=0` turns it off.
- when the streamer is full the page waits and retries every 3 s, so the next viewer takes over
  when the current one leaves

All settings can be overridden with URL parameters, e.g. `/?AFKTimeout=300&maxSession=3600&retry=5`.

### One viewer at a time

Run the signalling server with `--max_players 1` and `--max_session_seconds 7260`. The second one drops any
viewer connection after that many seconds (close code 4000): a backstop for clients that ignore the page's own
limits, so nobody can hold the only place for ever. Set it a little above the page's `maxSession` (7200 s), so the
page ends the session cleanly first. A second viewer is refused with `subscribeFailed`
("Streamer ... is full"), which the page turns into the waiting message and keeps retrying.
This is a limit, not an ordered queue: when the slot frees, whichever waiting page retries first
gets it. An ordered queue with positions would need to live in the Backend, which knows the sessions.

## Build and run

```bash
npm ci --ignore-scripts     # --ignore-scripts: only the SFU's mediasoup needs a native worker, which we do not use
npm run build               # builds the lab page and the server into SignallingWebServer/

scripts/start_server.sh     # starts the server with the lab page; settings below
```

`scripts/start_server.sh` checks that Node 22 is installed, that the build exists and that the backend key file is
there, then starts the server with `--max_players 1`, a viewer time limit and the ICE servers from the backend.
Settings are environment variables, e.g. `PLAYER_PORT=80 scripts/start_server.sh`; anything else on the command
line goes to the server. The defaults and all variables are listed at the top of the script
(`PLAYER_PORT` 8081, `STREAMER_PORT` 8888, `MAX_SESSION_SECONDS` 7260, `BACKEND_ICE_URL`, `BACKEND_KEY_FILE`
`~/backend_turn_access_key`, `LOG_FOLDER`, `REVERSE_PROXY=1` behind nginx or ngrok). Start the backend first.

To run the server by hand instead, the script's command is:

```bash
cd SignallingWebServer
node dist/index.js --serve --http_root "$PWD/www" --homepage lab.html --max_players 1 \
    --max_session_seconds 7260 --player_port 8081 --streamer_port 8888 \
    --backend_ice_url http://127.0.0.1:5000/movement_analysis/ice_servers --backend_ice_key_file ~/backend_turn_access_key
```

`config.json` still has Epic's Windows default for `http_root`, so it is always passed explicitly. Node 22 (`NODE_VERSION`).

## Behind nginx, under a path (one tunnel)

Two ports, two jobs: the **player port** (`PLAYER_PORT`, 8081) serves the page and the viewers' WebSocket; the
**streamer port** (`STREAMER_PORT`, 8888) is a WebSocket-only port for Unreal, which connects to it directly on the
same machine. A browser pointed at the streamer port gets `426 Upgrade Required`. nginx must forward to the player port.

To serve the page under `/stream/` on a domain that other things share, add this to the existing `server` block
(the page builds its WebSocket address from its own path, so no `?ss=` is needed):

```nginx
location = /stream { return 301 /stream/; }
location /stream/ {
    proxy_pass http://127.0.0.1:8081/;          # the trailing slash strips /stream/
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;     # the signalling connection is a WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 7300s;                   # longer than the viewer time limit
}
```

Start the server with `REVERSE_PROXY=1 scripts/start_server.sh`. The viewer address is then
`https://<domain>/stream/` (with the trailing slash), which is what `pentapose serve --pixel-stream-url` should be given.
The end-to-end test covers this with a small prefix proxy; this exact block was also tried against nginx 1.30.

## TURN

Two ways to give peers TURN credentials. Use one.

### From the backend (no TURN setup on this server)

```bash
echo "<the backend's BACKEND_TURN_ACCESS_KEY>" > ~/backend_turn_access_key && chmod 600 ~/backend_turn_access_key
node dist/index.js ... --backend_ice_url http://127.0.0.1:5000/movement_analysis/ice_servers \
    --backend_ice_key_file ~/backend_turn_access_key        # or BACKEND_API_KEY in the environment
```

The signalling server asks the backend (`GET /movement_analysis/ice_servers`, Bearer key, server to server)
for the ICE servers it already creates from Cloudflare (with its own key, `BACKEND_TURN_ACCESS_KEY`, not the movement analysis key), keeps a cached copy, refreshes it every hour
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
forwarded, mouse not captured, a second viewer waiting and taking over, the idle timeout, the time limit,
and the server dropping a client at `--max_session_seconds`.
Not covered: a real Unreal streamer, and playback over a real network. The backend ICE servers are
covered by `SignallingWebServer/src/backendIceServers.test.ts` (`npm test` there).

`node Extras/lab-e2e/ice-check.mjs ws://127.0.0.1:8081 [ws://127.0.0.1:8888]` checks a running server: it connects as a
viewer (and optionally a streamer), reads the `config` message and reports whether the ICE servers include TURN with
credentials (never printing them). Exits non-zero if not. Needs only Node 22, no browser.
