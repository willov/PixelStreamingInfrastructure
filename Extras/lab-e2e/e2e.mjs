// End-to-end test of the lab player (Frontend/implementations/typescript/src/lab.ts).
//
// Starts the signalling server with --max_players 1 and the lab page as homepage, serves the mock
// streamer (Extras/JSStreamer, a stand-in for Unreal) and drives real browsers:
//   1. a viewer gets the video and no UI
//   2. touch input reaches the streamer; the mouse is not captured (no pointer lock)
//   3. a second viewer waits while the first is connected, then takes over when it leaves
//   4. idle timeout: a touch during the countdown cancels it, idling ends the session, a tap rejoins
//   5. time limit: the page ends the session with a message and a tap rejoins; the server drops a
//      client that ignores the limit (--max_session_seconds)
//
// Needs: `npm ci` and `npm run build` at the repo root first, and a Chromium (CHROMIUM=/path/to/chromium).
//   node Extras/lab-e2e/e2e.mjs
// Takes about a minute. Exits non-zero if a check fails.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAYER_PORT = Number(process.env.PLAYER_PORT || 18080);
const STREAMER_PORT = Number(process.env.STREAMER_PORT || 18888);
const MOCK_PORT = Number(process.env.MOCK_PORT || 14000);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const JSSTREAMER_DIST = join(ROOT, 'Extras', 'JSStreamer', 'dist');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

if (!existsSync(join(ROOT, 'SignallingWebServer', 'www', 'lab.html'))) {
    console.error('lab.html is not built: run `npm ci` and `npm run build` at the repo root first.');
    process.exit(2);
}

// Static server for the mock streamer page.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.webm': 'video/webm' };
const mock = createServer((req, res) => {
    const file = join(JSSTREAMER_DIST, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(JSSTREAMER_DIST) || !existsSync(file)) {
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
}).listen(MOCK_PORT, '127.0.0.1');

// The signalling server, as it would run in production: one viewer at a time, lab page as homepage.
const startServer = async (playerPort, streamerPort, extraArgs = [], readyHeaders = {}) => {
    const child = spawn(
        process.execPath,
        [
            join(ROOT, 'SignallingWebServer', 'dist', 'index.js'),
            '--serve',
            '--http_root',
            join(ROOT, 'SignallingWebServer', 'www'),
            '--homepage',
            'lab.html',
            '--player_port',
            String(playerPort),
            '--streamer_port',
            String(streamerPort),
            '--sfu_port',
            String(streamerPort + 1),
            '--max_players',
            '1',
            '--console_messages',
            'basic',
            '--log_folder',
            mkdtempSync(join(tmpdir(), 'lab-e2e-')),
            ...extraArgs
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    child.output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => (child.output += data));
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${playerPort}/`, { headers: readyHeaders })).ok) break;
        } catch {
            /* not up yet */
        }
        await wait(250);
    }
    return child;
};
const server = await startServer(PLAYER_PORT, STREAMER_PORT);
let limitedServer;

const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']
});
try {
    // The mock streamer stands in for Unreal.
    const streamerPage = await (await browser.newContext()).newPage();
    const inputs = [];
    streamerPage.on('console', (m) => {
        if (m.text().startsWith('Data channel msg')) inputs.push(m.text());
    });
    await streamerPage.goto(`http://127.0.0.1:${MOCK_PORT}/?SignallingURL=ws://127.0.0.1:${STREAMER_PORT}`);
    await wait(1500);
    await streamerPage.evaluate(() => window.startStreaming());
    await wait(2000);

    const viewer = async (query = '') => {
        const ctx = await browser.newContext({ viewport: { width: 400, height: 700 }, hasTouch: true });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => {
            console.log('PAGE ERROR:', e.message);
            failures++;
        });
        await page.goto(`http://127.0.0.1:${PLAYER_PORT}/${query}`);
        return { ctx, page };
    };
    const state = (page) =>
        page.evaluate(() => {
            const s = document.getElementById('status');
            const v = document.querySelector('video');
            return {
                status: s.className === 'visible' ? s.textContent : '',
                playing: !!v && v.readyState >= 2 && v.videoWidth > 0 && !v.paused,
                locked: !!document.pointerLockElement
            };
        });

    // 1. video, no UI
    const A = await viewer('?AFKTimeout=8');
    await wait(5000);
    let s = await state(A.page);
    check('viewer gets the video', s.playing);
    check('no UI text while playing', s.status === '');

    // 2. touch forwarded, mouse not captured
    inputs.length = 0;
    await A.page.touchscreen.tap(200, 350);
    await wait(400);
    const touchMessages = inputs.length;
    await A.page.mouse.click(200, 350);
    await wait(400);
    check('touch reaches the application', touchMessages > 0, `(${touchMessages} messages)`);
    check('mouse is not captured', !(await state(A.page)).locked);

    // 3. the second viewer waits, then takes over
    const B = await viewer();
    await wait(3000);
    s = await state(B.page);
    check(
        'second viewer waits while the slot is taken',
        !s.playing && /free place/.test(s.status),
        JSON.stringify(s.status)
    );
    await A.ctx.close();
    await wait(6000);
    s = await state(B.page);
    check('second viewer takes over when the first leaves', s.playing && s.status === '');
    await B.ctx.close();
    await wait(1500);

    // 4. idle timeout
    const C = await viewer('?AFKTimeout=5');
    await wait(4000);
    check('viewer connected before the idle test', (await state(C.page)).playing);
    await wait(5500); // idle past the timeout: the countdown starts
    await C.page.touchscreen.tap(100, 100); // a touch cancels it
    await wait(11000);
    s = await state(C.page);
    check('a touch during the countdown keeps the session', s.playing && s.status === '');
    await wait(5500 + 11000); // idle through timeout and countdown
    s = await state(C.page);
    check('idle session ends with a message', /inactivity/.test(s.status), JSON.stringify(s.status));
    await C.page.touchscreen.tap(200, 300);
    await wait(5000);
    s = await state(C.page);
    check('a tap joins again', s.playing && s.status === '');

    await C.ctx.close(); // free the only place for the next viewer
    await wait(1500);

    // 5a. time limit in the page
    const D = await viewer('?maxSession=6');
    await wait(4000);
    check('viewer connected before the time limit test', (await state(D.page)).playing);
    await wait(5000);
    s = await state(D.page);
    check(
        'the page ends the session at the time limit',
        /time limit/.test(s.status),
        JSON.stringify(s.status)
    );
    await D.page.touchscreen.tap(200, 300);
    await wait(5000);
    s = await state(D.page);
    check('a tap joins again after the time limit', s.playing && s.status === '');
    await D.ctx.close();

    // 5b. the server drops a client that ignores the limit
    limitedServer = await startServer(PLAYER_PORT + 10, STREAMER_PORT + 10, ['--max_session_seconds', '3']);
    const closeCode = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PLAYER_PORT + 10}`);
        const timer = setTimeout(() => resolve('still connected'), 8000);
        ws.onclose = (event) => {
            clearTimeout(timer);
            resolve(event.code);
        };
    });
    check(
        'the server drops a client at --max_session_seconds',
        closeCode === 4000,
        `(close code ${closeCode})`
    );

    // 6. behind a reverse proxy that serves the page under /stream/ (as nginx does on a shared domain)
    const PROXY_PORT = PLAYER_PORT + 20;
    const strip = (url) => url.slice('/stream'.length);
    const proxy = createServer((req, res) => {
        if (!req.url.startsWith('/stream/')) {
            res.writeHead(404).end();
            return;
        }
        const upstream = request(
            {
                host: '127.0.0.1',
                port: PLAYER_PORT,
                path: strip(req.url),
                method: req.method,
                headers: req.headers
            },
            (answer) => {
                res.writeHead(answer.statusCode, answer.headers);
                answer.pipe(res);
            }
        );
        req.pipe(upstream);
    }).on('upgrade', (req, socket) => {
        const upstream = request({
            host: '127.0.0.1',
            port: PLAYER_PORT,
            path: strip(req.url),
            headers: req.headers
        });
        upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
            let head = 'HTTP/1.1 101 Switching Protocols\r\n';
            for (let i = 0; i < answer.rawHeaders.length; i += 2)
                head += `${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}\r\n`;
            socket.write(`${head}\r\n`);
            if (upstreamHead.length) socket.write(upstreamHead);
            upstreamSocket.pipe(socket);
            socket.pipe(upstreamSocket);
        });
        upstream.on('error', () => socket.destroy());
        upstream.end();
    });
    await new Promise((resolve) => proxy.listen(PROXY_PORT, '127.0.0.1', resolve));
    try {
        const ctx = await browser.newContext({ viewport: { width: 400, height: 700 } });
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${PROXY_PORT}/stream/`);
        await wait(6000);
        const signalling = await page.evaluate(() => window.pixelStreaming.config.getTextSettingValue('ss'));
        s = await state(page);
        check(
            'the page connects its WebSocket under the same path',
            new URL(signalling.replace(/^ws/, 'http')).pathname === '/stream/' && /[?&]queue=[^&]+/.test(signalling),
            `(${signalling})`
        );
        check('the video plays through a /stream/ proxy', s.playing && s.status === '');
        // ?debug=1 shows how the video travels; without it nothing is shown.
        const plainBadge = await page.evaluate(() => document.getElementById('debug').className);
        check('no connection badge without ?debug=1', plainBadge === '', `(${JSON.stringify(plainBadge)})`);
        // The same page again (the streamer takes one viewer, so a second page would have to wait).
        await page.goto(`http://127.0.0.1:${PROXY_PORT}/stream/?debug=1`);
        await wait(6000);
        const badge = await page.evaluate(() => document.getElementById('debug').textContent);
        check('?debug=1 names the connection type', /^(host|srflx|prflx|relay)/.test(badge), `(${badge})`);

        // Mouse: hovering must not reach the library's handlers, a left-button drag must, ?mouse=all passes everything.
        const mouseEvents = async (query) => {
            await page.goto(`http://127.0.0.1:${PROXY_PORT}/stream/${query}`);
            await wait(4000);
            await page.evaluate(() => {
                const seen = (window.__mouse = { move: 0, down: 0, wheel: 0, right: 0 });
                const parent = document.getElementById('videoParentElement');
                parent.addEventListener('mousemove', () => seen.move++);
                parent.addEventListener('mousedown', (e) => (e.button === 0 ? seen.down++ : seen.right++));
                parent.addEventListener('wheel', () => seen.wheel++);
            });
            await page.mouse.move(100, 100);
            await page.mouse.move(150, 150);
            const hover = await page.evaluate(() => window.__mouse.move);
            await page.mouse.down();
            await page.mouse.move(200, 200);
            await page.mouse.up();
            await page.mouse.down({ button: 'right' });
            await page.mouse.up({ button: 'right' });
            await page.mouse.wheel(0, 100);
            const after = await page.evaluate(() => window.__mouse);
            return { hover, ...after };
        };
        let m = await mouseEvents('');
        check('mouse: hovering is not forwarded', m.hover === 0, `(${m.hover} moves)`);
        check('mouse: a left-button drag is forwarded', m.down === 1 && m.move >= 1, `(down ${m.down}, moves ${m.move})`);
        check('mouse: right button and wheel are not forwarded', m.right === 0 && m.wheel === 0);
        m = await mouseEvents('?mouse=off');
        check('?mouse=off forwards nothing', m.move === 0 && m.down === 0);
        m = await mouseEvents('?mouse=all');
        check('?mouse=all forwards hovering, right button and wheel', m.hover >= 1 && m.right === 1 && m.wheel >= 1,
            `(hover ${m.hover}, right ${m.right}, wheel ${m.wheel})`);
        await ctx.close();

        // 7. --reverse-proxy: the proxy's X-Forwarded-For header must not be reported as a misconfiguration
        // The rate limiter only validates headers on the first request it sees, so that one carries the header.
        const forwarded = async (extraArgs) => {
            const child = await startServer(PLAYER_PORT + 30, STREAMER_PORT + 30, extraArgs, {
                'X-Forwarded-For': '203.0.113.7'
            });
            await wait(1000);
            child.kill();
            return child.output.includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR');
        };
        check(
            'without --reverse-proxy the forwarded header is reported (so the next check can fail)',
            await forwarded([])
        );
        check('with --reverse-proxy it is not', !(await forwarded(['--reverse-proxy'])));

        // 8. The streamer port has no login: --streamer_host keeps it on this machine.
        const lanAddress = Object.values(networkInterfaces())
            .flat()
            .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
        const reachable = (host, port) =>
            new Promise((resolve) => {
                const socket = createConnection({ host, port }, () => (socket.destroy(), resolve(true)));
                socket.on('error', () => resolve(false));
            });
        if (!lanAddress) {
            console.log('SKIP  streamer port binding (no non-loopback address on this machine)');
        } else {
            const open = await startServer(PLAYER_PORT + 40, STREAMER_PORT + 40);
            const local = await startServer(PLAYER_PORT + 50, STREAMER_PORT + 50, ['--streamer_host', '127.0.0.1']);
            const openOnLan = await reachable(lanAddress, STREAMER_PORT + 40);
            const localOnLan = await reachable(lanAddress, STREAMER_PORT + 50);
            const localOnLoopback = await reachable('127.0.0.1', STREAMER_PORT + 50);
            open.kill();
            local.kill();
            check('streamer port is reachable on the network without --streamer_host', openOnLan, `(${lanAddress})`);
            check('--streamer_host 127.0.0.1 refuses connections from the network', !localOnLan, `(${lanAddress})`);
            check('--streamer_host 127.0.0.1 still accepts the local streamer', localOnLoopback);
        }

        // 9. No streamer, a streamer that stops, a streamer that comes back: the page says what is going on and
        // recovers by itself. (The library alone gives up after three tries and leaves a blank page.)
        const recoveryServer = await startServer(PLAYER_PORT + 60, STREAMER_PORT + 60);
        try {
            const startStreamer = async () => {
                const page = await (await browser.newContext()).newPage();
                await page.goto(`http://127.0.0.1:${MOCK_PORT}/?SignallingURL=ws://127.0.0.1:${STREAMER_PORT + 60}`);
                await wait(1500);
                await page.evaluate(() => window.startStreaming());
                return page;
            };
            const viewerCtx = await browser.newContext({ viewport: { width: 400, height: 700 } });
            const page = await viewerCtx.newPage();
            page.on('pageerror', (e) => {
                console.log('PAGE ERROR:', e.message);
                failures++;
            });
            await page.goto(`http://127.0.0.1:${PLAYER_PORT + 60}/?retry=1`);
            await wait(300);
            let st = await state(page);
            check('the page says something from the first moment', st.status !== '', JSON.stringify(st.status));
            await wait(14000); // longer than the library's own attempts last
            st = await state(page);
            check('no streamer: it says it is waiting, long after the library would have given up',
                /Waiting for the avatar/.test(st.status) && !st.playing, JSON.stringify(st.status));

            let streamer = await startStreamer();
            await wait(7000);
            st = await state(page);
            check('the streamer starts later: the page connects by itself', st.playing && st.status === '', JSON.stringify(st.status));

            await streamer.close();
            await wait(4000);
            st = await state(page);
            // (The frozen last frame stays in the video element, so only the message is checked.)
            check('the streamer stops: it says so instead of a blank page',
                /Waiting for the avatar|Connection lost/.test(st.status), JSON.stringify(st.status));

            streamer = await startStreamer();
            await wait(9000);
            st = await state(page);
            check('the streamer comes back: the same page plays again', st.playing && st.status === '', JSON.stringify(st.status));
            await streamer.close();
            await viewerCtx.close();

            // A page that has waited too long stops, so a forgotten tab does not take the only place later.
            const tired = await (await browser.newContext({ viewport: { width: 400, height: 700 } })).newPage();
            await tired.goto(`http://127.0.0.1:${PLAYER_PORT + 60}/?retry=1&giveUp=4`);
            await wait(8000);
            st = await state(tired);
            check('waiting for a stream has a limit', /Unable to connect.*reload/.test(st.status), JSON.stringify(st.status));
            streamer = await startStreamer();
            await wait(6000);
            st = await state(tired);
            check('after giving up it does not connect by itself', !st.playing && /Unable to connect/.test(st.status), JSON.stringify(st.status));
            await tired.click('#status');
            await wait(7000);
            st = await state(tired);
            check('a tap on the message also tries again', st.playing && st.status === '', JSON.stringify(st.status));
            await streamer.close();
        } finally {
            recoveryServer.kill();
        }

        // 10. Unreal on demand with a waiting line. The "Unreal" is a mock streamer that a control server opens
        // and closes when the signalling server runs its start and stop commands.
        const CTRL_PORT = PLAYER_PORT + 90;
        const ctrlLog = [];
        let unreal = null;
        const ctrl = createServer(async (req, res) => {
            if (req.url === '/start') {
                ctrlLog.push('start');
                res.end('ok');
                const page = await (await browser.newContext()).newPage();
                unreal = page;
                await page.goto(`http://127.0.0.1:${MOCK_PORT}/?SignallingURL=ws://127.0.0.1:${STREAMER_PORT + 70}`);
                await wait(1500);
                await page.evaluate(() => window.startStreaming()).catch(() => {});
            } else if (req.url === '/stop') {
                ctrlLog.push('stop');
                const page = unreal;
                unreal = null;
                await page?.close().catch(() => {});
                res.end('ok');
            } else {
                res.writeHead(404).end();
            }
        }).listen(CTRL_PORT, '127.0.0.1');
        const lineServer = await startServer(PLAYER_PORT + 70, STREAMER_PORT + 70, [
            '--unreal_start_cmd', `curl -fsS http://127.0.0.1:${CTRL_PORT}/start`,
            '--unreal_stop_cmd', `curl -fsS http://127.0.0.1:${CTRL_PORT}/stop`,
            '--unreal_min_start_gap', '1',
            '--unreal_turn_timeout', '20'
        ]);
        const openViewer = async (name) => {
            const ctx = await browser.newContext({ viewport: { width: 400, height: 700 } });
            const page = await ctx.newPage();
            page.on('pageerror', (e) => {
                console.log(`PAGE ERROR (${name}):`, e.message);
                failures++;
            });
            await page.goto(`http://127.0.0.1:${PLAYER_PORT + 70}/?retry=1`);
            return { ctx, page };
        };
        // Waits until a page satisfies a condition, polling; returns the last state.
        const until = async (page, test, ms = 30000) => {
            const end = Date.now() + ms;
            let st = await state(page);
            while (!test(st) && Date.now() < end) {
                await wait(500);
                st = await state(page);
            }
            return st;
        };
        try {
            check('nobody has asked yet: Unreal is not started', ctrlLog.length === 0);
            const A = await openViewer('A');
            let st = await until(A.page, (x) => x.playing && x.status === '');
            check('first viewer: Unreal is started and the video plays', st.playing && ctrlLog.join() === 'start', `${ctrlLog.join()} ${JSON.stringify(st.status)}`);

            const B = await openViewer('B');
            await wait(1500);
            const C = await openViewer('C');
            await wait(4000);
            const stB = await state(B.page);
            const stC = await state(C.page);
            check('second viewer is told one person is ahead', /1 person ahead/.test(stB.status), JSON.stringify(stB.status));
            check('third viewer is told two people are ahead', /2 people ahead/.test(stC.status), JSON.stringify(stC.status));
            check('waiting did not start a second Unreal', ctrlLog.join() === 'start');

            await A.ctx.close(); // the first viewer leaves
            // While Unreal is replaced, the viewer behind the next one must keep seeing its place in line
            // ("1 person ahead"), not "Waiting for the avatar": only the first in line is told that.
            const seenByC = new Set();
            const seenByB = new Set();
            const sampleEnd = Date.now() + 40000;
            st = await state(B.page);
            while (!(st.playing && st.status === '') && Date.now() < sampleEnd) {
                seenByC.add((await state(C.page)).status);
                seenByB.add(st.status);
                await wait(150);
                st = await state(B.page);
            }
            check('while Unreal is replaced the third viewer never sees "Waiting for the avatar"',
                ![...seenByC].some((text) => /Waiting for the avatar/.test(text)) && seenByC.size > 0,
                JSON.stringify([...seenByC]));
            check('and the first in line is told that the avatar is starting',
                [...seenByB].some((text) => /Waiting for the avatar/.test(text)), JSON.stringify([...seenByB]));
            check('then Unreal is restarted and the second in line gets it', st.playing && ctrlLog.join() === 'start,stop,start', `${ctrlLog.join()} ${JSON.stringify(st.status)}`);
            const stC2 = await until(C.page, (x) => /1 person ahead/.test(x.status), 10000);
            check('the third moves up', /1 person ahead/.test(stC2.status), JSON.stringify(stC2.status));

            await B.ctx.close();
            st = await until(C.page, (x) => x.playing && x.status === '', 40000);
            check('and the third gets a fresh one in turn', st.playing && ctrlLog.join() === 'start,stop,start,stop,start', `${ctrlLog.join()} ${JSON.stringify(st.status)}`);

            await C.ctx.close(); // the last viewer leaves: Unreal stops and stays off
            await wait(8000);
            check('nobody left: Unreal is stopped and stays off', ctrlLog.join() === 'start,stop,start,stop,start,stop', ctrlLog.join());
        } finally {
            lineServer.kill();
            ctrl.close();
            await unreal?.close().catch(() => {});
        }
    } finally {
        proxy.close();
    }
} finally {
    await browser.close();
    server.kill();
    limitedServer?.kill();
    mock.close();
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
