// End-to-end test of the lab player (Frontend/implementations/typescript/src/lab.ts).
//
// Starts the signalling server with --max_players 1 and the lab page as homepage, serves the mock
// streamer (Extras/JSStreamer, a stand-in for Unreal) and drives real browsers:
//   1. a viewer gets the video and no UI
//   2. touch input reaches the streamer; the mouse is not captured (no pointer lock)
//   3. a second viewer waits while the first is connected, then takes over when it leaves
//   4. idle timeout: a touch during the countdown cancels it, idling ends the session, a tap rejoins
//
// Needs: `npm ci` and `npm run build` at the repo root first, and a Chromium (CHROMIUM=/path/to/chromium).
//   node Extras/lab-e2e/e2e.mjs
// Takes about a minute. Exits non-zero if a check fails.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
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
const server = spawn(
    process.execPath,
    [
        join(ROOT, 'SignallingWebServer', 'dist', 'index.js'),
        '--serve',
        '--http_root',
        join(ROOT, 'SignallingWebServer', 'www'),
        '--homepage',
        'lab.html',
        '--player_port',
        String(PLAYER_PORT),
        '--streamer_port',
        String(STREAMER_PORT),
        '--sfu_port',
        String(STREAMER_PORT + 1),
        '--max_players',
        '1',
        '--console_messages',
        'basic',
        '--log_folder',
        mkdtempSync(join(tmpdir(), 'lab-e2e-'))
    ],
    { stdio: 'ignore' }
);
for (let i = 0; i < 40; i++) {
    try {
        if ((await fetch(`http://127.0.0.1:${PLAYER_PORT}/`)).ok) break;
    } catch {
        /* not up yet */
    }
    await wait(250);
}

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
} finally {
    await browser.close();
    server.kill();
    mock.close();
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
