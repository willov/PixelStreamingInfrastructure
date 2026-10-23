// UI-less Pixel Streaming player: only the video, no controls.
//  - touch input is forwarded to the application
//  - the mouse is not captured (hovering mouse mode, no pointer lock)
//  - the stream is dropped after a period without input (idle timeout, 10 minutes by default)
//  - a session ends after a time limit (2 hours by default), so nobody holds the only place for ever
//  - the page always says what it is doing: connecting, waiting for the avatar to start, waiting for its turn, waiting for a free
//    place, or reconnecting after the stream was lost. It keeps trying every few seconds and never gives up, so
//    Unreal can be (re)started while the page is open
//  - when the streamer is full (the signalling server runs with --max_players 1) the page
//    waits and retries, so a second viewer takes over when the first one leaves
//  - the mouse only acts while the left button is held (drag to turn the camera); hovering does nothing
//    (?mouse=off ignores the mouse completely, ?mouse=all forwards everything as Epic's player does)
// All settings can be overridden with URL parameters, for example ?AFKTimeout=300&maxSession=3600&retry=5
// (maxSession=0 turns the time limit off; giveUp=N stops waiting for a stream after N seconds, default 900,
// 0 never stops). ?debug=1 shows how the connection was made in a corner badge
// (relay = through TURN, srflx or host = direct), for a viewer who cannot open the browser's WebRTC page. The signalling server's --max_session_seconds enforces the
// limit for clients that ignore this page.

import { Config, PixelStreaming, Logger, LogLevel } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.8';

const DEFAULT_IDLE_TIMEOUT_SECS = 600; // 10 minutes without input, plus the 10 s countdown
const DEFAULT_MAX_SESSION_SECS = 2 * 60 * 60;
const DEFAULT_RETRY_SECS = 3;
const DEFAULT_GIVE_UP_SECS = 15 * 60; // stop waiting for a stream after this long

document.body.onload = function () {
    Logger.InitLogging(LogLevel.Warning, true);

    // The library's default signalling address is the host only. Behind a reverse proxy that serves
    // this page under a path such as /stream/, the WebSocket has to go to the same path, so build the
    // address from the page's own directory. ?ss=... in the URL still overrides it.
    // The page keeps its place in the waiting line (when the server runs Unreal on demand) through a key it
    // sends with every connection: waiting means reconnecting every few seconds, and the connection is not
    // what identifies the viewer. crypto.randomUUID only exists on secure pages, so there is a fallback.
    const queueKey =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const signallingUrl =
        (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
        window.location.host +
        window.location.pathname.replace(/[^/]*$/, '') +
        `?queue=${queueKey}`;

    const config = new Config({
        useUrlParams: true,
        initialSettings: {
            ss: signallingUrl,
            AutoConnect: true,
            AutoPlayVideo: true,
            StartVideoMuted: true,
            WaitForStreamer: true,
            // The library gives up after a few attempts to find a streamer and leaves a blank page. The page
            // below retries on its own instead, so the library's attempts are off.
            MaxReconnectAttempts: 0,
            // Do not capture the mouse: no pointer lock, the cursor stays visible and free.
            HoveringMouse: true,
            // Forward touches as touches (not as emulated mouse clicks).
            TouchInput: true,
            FakeMouseWithTouches: false,
            // Disconnect after a period without input: AFKTimeout seconds idle, then a
            // countdown (at least 10 s, the library's minimum) that any touch cancels.
            TimeoutIfIdle: true,
            AFKTimeout: DEFAULT_IDLE_TIMEOUT_SECS,
            AFKCountdown: 10
        }
    });

    const stream = new PixelStreaming(config, {
        videoElementParent: document.getElementById('videoParentElement') as HTMLElement
    });
    const status = document.getElementById('status') as HTMLElement;

    const params = new URLSearchParams(window.location.search);
    const seconds = (name: string, fallback: number): number => {
        const value = params.get(name);
        const parsed = value === null || value === '' ? NaN : Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    const retrySecs = Number(params.get('retry')) || DEFAULT_RETRY_SECS;
    const maxSessionSecs = seconds('maxSession', DEFAULT_MAX_SESSION_SECS);
    const giveUpSecs = seconds('giveUp', DEFAULT_GIVE_UP_SECS);
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let ending = false; // true after the page ended the session itself (idle, time limit): no automatic retry
    let waitingSince: number | undefined; // when the current wait for a stream began

    let describeToken = 0; // a late answer about the place in line must not overwrite something newer
    const show = (text: string, onTap?: () => void) => {
        describeToken++;
        status.textContent = text;
        status.className = 'visible';
        status.onclick = onTap ?? null;
    };
    const hide = () => {
        describeToken++;
        status.className = '';
        status.onclick = null;
    };
    const queueText = (ahead: number) =>
        `Waiting for your turn: ${ahead === 1 ? '1 person' : `${ahead} people`} ahead of you.`;
    // While Unreal restarts there is no streamer to subscribe to, so the WebSocket cannot tell a waiting page where
    // it stands. Ask the server. Only the first in line is told that the avatar is starting.
    const queueUrl = new URL('queue', window.location.href).toString();
    const showWaiting = async (fallback: string) => {
        const mine = ++describeToken;
        let text = fallback;
        try {
            const answer = await fetch(`${queueUrl}?key=${encodeURIComponent(queueKey)}`, { cache: 'no-store' });
            const { ahead } = (await answer.json()) as { ahead: number | null };
            if (typeof ahead === 'number' && ahead > 0) {
                text = queueText(ahead);
            }
        } catch {
            // no answer: the fallback will do
        }
        if (mine === describeToken && !ending) {
            status.textContent = text;
            status.className = 'visible';
            status.onclick = null;
        }
    };
    const stopRetrying = () => {
        if (retryTimer !== undefined) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
        }
    };
    const stopSessionTimer = () => {
        if (sessionTimer !== undefined) {
            clearTimeout(sessionTimer);
            sessionTimer = undefined;
        }
    };
    // Leave the stream so the next viewer can take the place, and say why. A tap joins again.
    const endSession = (message: string) => {
        ending = true;
        stopRetrying();
        stopSessionTimer();
        stream.disconnect();
        show(message, () => {
            ending = false;
            waitingSince = undefined;
            show('Connecting...');
            stream.connect();
        });
    };

    // Without a stream there is nothing to see, so say why, and ask again in a few seconds. The page never gives
    // up: a streamer that starts later is picked up by the next attempt.
    let selfReconnect = false; // our own reconnect() closes an open connection first: that disconnect is not news
    const reconnectNow = () => {
        retryTimer = undefined;
        if (ending) return;
        selfReconnect = true;
        setTimeout(() => (selfReconnect = false), 1500);
        stream.reconnect();
        // Safety net: when no event follows that would schedule the next attempt, try again.
        retryTimer = setTimeout(reconnectNow, 8000);
    };
    const retryLater = (message: string) => {
        if (ending) return;
        waitingSince ??= Date.now();
        // A tab nobody looks at must not wait for ever: it would take the only place the moment Unreal starts.
        if (giveUpSecs > 0 && Date.now() - waitingSince > giveUpSecs * 1000) {
            endSession('Unable to connect to the avatar. Please reload the page and try again.');
            return;
        }
        stopRetrying();
        retryTimer = setTimeout(reconnectNow, retrySecs * 1000);
        if (status.className !== 'visible') show('Connecting...');
        void showWaiting(message);
    };

    // The signalling server is reachable but there is no streamer to watch (Unreal is not running yet).
    stream.addEventListener('streamerListMessage', ({ data }) => {
        if (!data.autoSelectedStreamerId) retryLater('Waiting for the avatar to start...');
    });

    // The streamer is full (another viewer holds the slot) or has just gone away.
    stream.addEventListener('subscribeFailed', ({ data }) => {
        const inLine = /^queue (\d+)/.exec(data.message);
        if (inLine) {
            retryLater(queueText(Number(inLine[1])));
        } else if (/is full/.test(data.message)) {
            retryLater('Someone else is using the avatar. Waiting for a free place...');
        } else {
            retryLater('Waiting for the avatar to start...');
        }
    });

    // The connection ended: the streamer stopped or restarted, or the server or the network went away.
    // (The page's own endSession sets `ending`, so an idle timeout stays ended until a tap.)
    stream.addEventListener('webRtcDisconnected', () => {
        if (selfReconnect) {
            selfReconnect = false;
            return;
        }
        stopSessionTimer();
        retryLater('Connection lost. Reconnecting...');
    });

    // Idle warning: there is no overlay, so the first touch or click cancels the countdown.
    stream.addEventListener('afkWarningActivate', ({ data }) => {
        const cancel = () => data.dismissAfk();
        document.addEventListener('pointerdown', cancel, { once: true, capture: true });
    });

    // Idle for too long: leave the stream so the next viewer can take the slot.
    stream.addEventListener('afkTimedOut', () => {
        endSession('The session ended after a period of inactivity. Tap to join again.');
    });

    // Browsers may refuse autoplay: ask for a tap, which also starts the video.
    stream.addEventListener('playStreamRejected', () => {
        show('Tap to start', () => {
            hide();
            stream.play();
        });
    });

    // From the first moment: the page is loading and the signalling server is being reached.
    show('Connecting...');

    // The streamer answered: the connection is being set up, then the video arrives.
    stream.addEventListener('webRtcConnecting', () => show('Connecting...'));
    stream.addEventListener('videoInitialized', () => {
        stopRetrying();
        waitingSince = undefined;
        hide();
        // The time limit starts when the video does, not when the page loaded.
        if (maxSessionSecs > 0 && sessionTimer === undefined) {
            sessionTimer = setTimeout(
                () => endSession('The session reached its time limit. Tap to join again.'),
                maxSessionSecs * 1000
            );
        }
    });

    // Mouse: the application treats mouse movement as turning the camera, so a mouse merely hovering
    // over the video would spin it. Filter the events before the library's own handlers see them.
    const mouseMode = params.get('mouse') ?? 'drag';
    if (mouseMode !== 'all') {
        const drag = mouseMode !== 'off';
        const block = (event: Event) => event.stopImmediatePropagation();
        const leftButtonOnly = (event: Event) => {
            if (!(drag && (event as MouseEvent).button === 0)) block(event);
        };
        window.addEventListener('mousedown', leftButtonOnly, true);
        window.addEventListener('mouseup', leftButtonOnly, true);
        // buttons is the state now: a drag that began on the page and left it still counts.
        window.addEventListener('mousemove', (event) => { if (!(drag && (event.buttons & 1))) block(event); }, true);
        for (const type of ['wheel', 'dblclick', 'auxclick']) window.addEventListener(type, block, true);
        window.addEventListener('contextmenu', (event) => { event.preventDefault(); block(event); }, true);
    }

    // ?debug=1: say how the video travels. The library polls the connection once a second.
    if (params.get('debug') === '1') {
        const badge = document.getElementById('debug') as HTMLElement;
        stream.addEventListener('statsReceived', ({ data }) => {
            const stats = data.aggregatedStats;
            const pair = stats.getActiveCandidatePair();
            if (!pair) return;
            const local = stats.localCandidates.find((c) => c.id === pair.localCandidateId);
            const remote = stats.remoteCandidates.find((c) => c.id === pair.remoteCandidateId);
            if (!local) return;
            // relayProtocol says how the client reaches the TURN server (udp, tcp or tls).
            const via = local.candidateType === 'relay' ? `relay (${local.relayProtocol})` : local.candidateType;
            badge.textContent = `${via}${remote ? ` / ${remote.candidateType}` : ''}`;
            badge.className = 'visible';
        });
    }

    // For tests and debugging, as in Epic's reference page.
    (window as unknown as { pixelStreaming: PixelStreaming }).pixelStreaming = stream;
};
