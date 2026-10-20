// UI-less Pixel Streaming player: only the video, no controls.
//  - touch input is forwarded to the application
//  - the mouse is not captured (hovering mouse mode, no pointer lock)
//  - the stream is dropped after a period without input (idle timeout)
//  - when the streamer is full (the signalling server runs with --max_players 1) the page
//    waits and retries, so a second viewer takes over when the first one leaves
// All settings can be overridden with URL parameters, for example ?AFKTimeout=120&retry=5.

import { Config, PixelStreaming, Logger, LogLevel } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.8';

const DEFAULT_IDLE_TIMEOUT_SECS = 120; // plus the 10 s countdown
const DEFAULT_RETRY_SECS = 3;

document.body.onload = function () {
    Logger.InitLogging(LogLevel.Warning, true);

    const config = new Config({
        useUrlParams: true,
        initialSettings: {
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

    const retrySecs = Number(new URLSearchParams(window.location.search).get('retry')) || DEFAULT_RETRY_SECS;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

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
        stopRetrying();
        stream.disconnect();
        show('The session ended after a period of inactivity. Tap to join again.', () => {
            hide();
            stream.connect();
        });
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
    });

    // For tests and debugging, as in Epic's reference page.
    (window as unknown as { pixelStreaming: PixelStreaming }).pixelStreaming = stream;
};
