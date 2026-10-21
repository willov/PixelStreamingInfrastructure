// Checks that a running signalling server hands out TURN credentials to peers.
//
//   node Extras/lab-e2e/ice-check.mjs ws://127.0.0.1:8081                      # a viewer (player port)
//   node Extras/lab-e2e/ice-check.mjs ws://127.0.0.1:8081 ws://127.0.0.1:8888  # and a streamer (streamer port)
//
// Connects like a viewer (and optionally a streamer), reads the `config` message the server sends and
// reports the ICE servers in it: the URLs and whether a username and credential are present. The
// credentials themselves are never printed. Exits non-zero when a peer gets no TURN server with
// credentials. Needs Node 22 (built-in WebSocket).
//
// Note: the streamer check opens an extra, unnamed streamer connection for a moment. Do not run it
// while you are relying on a real streamer being the only one connected.

const [playerUrl, streamerUrl] = process.argv.slice(2);
if (!playerUrl) {
    console.error('usage: node ice-check.mjs <player ws url> [<streamer ws url>]');
    process.exit(2);
}

function readConfig(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
            ws.close();
            reject(new Error(`no config message from ${url} within 5 s`));
        }, 5000);
        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'config') {
                clearTimeout(timer);
                ws.close();
                resolve(message);
            }
        };
        ws.onerror = () => {
            clearTimeout(timer);
            reject(new Error(`could not connect to ${url}`));
        };
    });
}

let failed = false;
for (const [label, url] of [
    ['viewer', playerUrl],
    ['streamer', streamerUrl]
]) {
    if (!url) continue;
    try {
        const config = await readConfig(url);
        const servers = config.peerConnectionOptions?.iceServers ?? [];
        const turn = servers.filter((s) => [].concat(s.urls ?? s.url ?? []).some((u) => /^turns?:/i.test(u)));
        const ok = turn.length > 0 && turn.every((s) => s.username && s.credential);
        console.log(
            `${ok ? 'PASS' : 'FAIL'}  ${label} gets ${servers.length} ICE server entries, ${turn.length} with TURN`
        );
        for (const s of servers) {
            console.log(
                `        ${JSON.stringify([].concat(s.urls ?? s.url))}  username: ${!!s.username}  credential: ${!!s.credential}`
            );
        }
        if (!ok) failed = true;
    } catch (error) {
        console.log(`FAIL  ${label}: ${error.message}`);
        failed = true;
    }
}
process.exit(failed ? 1 : 0);
