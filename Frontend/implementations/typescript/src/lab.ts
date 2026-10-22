// UI-less Pixel Streaming player: only the video, no controls.
//  - touch input is forwarded to the application
//  - the mouse is not captured (hovering mouse mode, no pointer lock)
//  - the stream is dropped after a period without input (idle timeout, 10 minutes by default)
//  - a session ends after a time limit (2 hours by default), so nobody holds the only place for ever
//  - when the streamer is full (the signalling server runs with --max_players 1) the page
//    waits and retries, so a second viewer takes over when the first one leaves
//  - the mouse only acts while the left button is held (drag to turn the camera); hovering does nothing
//    (?mouse=off ignores the mouse completely, ?mouse=all forwards everything as Epic's player does)
// All settings can be overridden with URL parameters, for example ?AFKTimeout=300&maxSession=3600&retry=5
// (maxSession=0 turns the time limit off). ?debug=1 shows how the connection was made in a corner badge
// (relay = through TURN, srflx or host = direct), for a viewer who cannot open the browser's WebRTC page. The signalling server's --max_session_seconds enforces the
// limit for clients that ignore this page.

import { Config, PixelStreaming, Logger, LogLevel } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.8';

const DEFAULT_IDLE_TIMEOUT_SECS = 600; // 10 minutes without input, plus the 10 s countdown
const DEFAULT_MAX_SESSION_SECS = 2 * 60 * 60;
const DEFAULT_RETRY_SECS = 3;

document.body.onload = function () {
    Logger.InitLogging(LogLevel.Warning, true);

    // The library's default signalling address is the host only. Behind a reverse proxy that serves
    // this page under a path such as /stream/, the WebSocket has to go to the same path, so build the
    // address from the page's own directory. ?ss=... in the URL still overrides it.
    const signallingUrl =
        (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
        window.location.host +
        window.location.pathname.replace(/[^/]*$/, '');

    const config = new Config({
        useUrlParams: true,
        initialSettings: {
            ss: signallingUrl,
            AutoConnect: true,
            AutoPlayVideo: true,
            StartVideoMuted: true,
            WaitForStreamer: true,
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
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;

    const show = (text: string, onTap?: () => void) => {
        status.textContent = text;
        status.className = 'visible';
        status.onclick = onTap ?? null;
    };
    const hide = () => {
        status.className = '';
        status.onclick = null;
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
        stopRetrying();
        stopSessionTimer();
        stream.disconnect();
        show(message, () => {
            hide();
            stream.connect();
        });
    };

    // The streamer is full: another viewer holds the slot. Keep asking until it is free.
    stream.addEventListener('subscribeFailed', () => {
        show('Someone else is using the avatar. Waiting for a free place...');
        stopRetrying();
        retryTimer = setTimeout(() => stream.reconnect(), retrySecs * 1000);
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

    // The streamer answered: the connection is being set up, then the video arrives.
    stream.addEventListener('webRtcConnecting', () => show('Connecting...'));
    stream.addEventListener('videoInitialized', () => {
        stopRetrying();
        hide();
        // The time limit starts when the video does, not when the page loaded.
        if (maxSessionSecs > 0 && sessionTimer === undefined) {
            sessionTimer = setTimeout(
                () => endSession('The session reached its time limit. Tap to join again.'),
                maxSessionSecs * 1000
            );
        }
    });
    // The connection dropped (by us, the server or the network): the next one gets a fresh time limit.
    stream.addEventListener('webRtcDisconnected', stopSessionTimer);

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
