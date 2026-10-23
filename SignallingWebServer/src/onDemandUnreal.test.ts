import { OnDemandUnreal, AVATAR_NOT_RUNNING, queueMessage, queueKeyFromUrl } from './onDemandUnreal';

// A controller with a clock that only moves when the test says so, and start/stop commands that
// finish when the test says so.
function setup(overrides: Partial<ConstructorParameters<typeof OnDemandUnreal>[0]> = {}) {
    let now = 1_000_000;
    const calls: string[] = [];
    const pendingStops: Array<() => void> = [];
    const logs: string[] = [];
    const controller = new OnDemandUnreal({
        start: async () => {
            calls.push('start');
        },
        stop: () => {
            calls.push('stop');
            return new Promise<void>((resolve) => pendingStops.push(resolve));
        },
        now: () => now,
        log: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
        ...overrides
    });
    return {
        controller,
        calls,
        logs,
        advance(ms: number) {
            now += ms;
            controller.tick();
        },
        /** Lets a pending stop command finish. */
        async finishStop() {
            pendingStops.shift()?.();
            await Promise.resolve();
            await Promise.resolve();
        },
        /** Unreal registers its streamer. */
        ready() {
            controller.setStreamerReady(true);
        },
        /** A viewer arrives, waits for Unreal and takes its turn. */
        watch(playerId: string, key = playerId) {
            controller.viewerConnected(playerId, key);
        },
        subscribe(playerId: string) {
            expect(controller.canSubscribe(playerId)).toBeNull();
            controller.viewerSubscribed(playerId);
        }
    };
}

describe('starting', () => {
    it('is off until the first viewer arrives, then starts Unreal once', () => {
        const t = setup();
        t.controller.tick();
        expect(t.calls).toEqual([]);
        expect(t.controller.state).toBe('off');

        t.watch('p1');
        expect(t.calls).toEqual(['start']);
        expect(t.controller.state).toBe('starting');

        t.watch('p2'); // a second arrival does not start a second one
        t.advance(2000);
        expect(t.calls).toEqual(['start']);
    });

    it('refuses subscriptions until Unreal has registered', () => {
        const t = setup();
        t.watch('p1');
        expect(t.controller.canSubscribe('p1')).toBe(AVATAR_NOT_RUNNING);
        t.ready();
        expect(t.controller.state).toBe('running');
        expect(t.controller.canSubscribe('p1')).toBeNull();
    });

    it('adopts an Unreal that is already running instead of starting another', () => {
        const t = setup();
        t.controller.adoptRunning();
        t.watch('p1');
        expect(t.calls).toEqual([]);
        expect(t.controller.canSubscribe('p1')).toBeNull();
    });
});

describe('the waiting line', () => {
    it('lets only the first in line subscribe, and tells the others how many are ahead', () => {
        const t = setup();
        t.watch('a');
        t.watch('b');
        t.watch('c');
        t.ready();
        expect(t.controller.canSubscribe('a')).toBeNull();
        expect(t.controller.canSubscribe('b')).toBe(queueMessage(1));
        expect(t.controller.canSubscribe('c')).toBe(queueMessage(2));
    });

    it('counts the viewer being served as ahead of everyone', () => {
        const t = setup();
        t.watch('a');
        t.watch('b');
        t.ready();
        t.subscribe('a');
        expect(t.controller.canSubscribe('b')).toBe(queueMessage(1));
        t.watch('c');
        expect(t.controller.canSubscribe('c')).toBe(queueMessage(2));
    });

    it('keeps a viewer\'s place when its page reconnects with the same key', () => {
        const t = setup();
        t.watch('a1', 'A');
        t.watch('b1', 'B');
        t.ready();
        // B's page reconnects: a new connection, the same key
        t.controller.viewerDisconnected('b1');
        t.watch('b2', 'B');
        t.advance(5000);
        // A is still first, B second
        expect(t.controller.canSubscribe('a1')).toBeNull();
        expect(t.controller.canSubscribe('b2')).toBe(queueMessage(1));
        t.controller.viewerDisconnected('a1');
        t.watch('a2', 'A'); // A reconnects too, still ahead of B
        expect(t.controller.canSubscribe('a2')).toBeNull();
    });

    it('drops a viewer that left and did not come back', () => {
        const t = setup({ entryTtlMs: 15_000 });
        t.watch('a', 'A');
        t.watch('b', 'B');
        t.ready();
        t.controller.viewerDisconnected('a');
        t.advance(10_000);
        expect(t.controller.canSubscribe('b')).toBe(queueMessage(1)); // A may still come back
        t.advance(10_000);
        expect(t.controller.canSubscribe('b')).toBeNull(); // A is gone, B is first
    });

    it('offers the turn to the next when the first in line does not take it', () => {
        const t = setup({ turnTimeoutMs: 30_000 });
        t.watch('a', 'A');
        t.watch('b', 'B');
        t.ready();
        t.advance(1000); // the first tick after Unreal registered starts the clock for A
        t.advance(31_000);
        // A's page connection is still open (a tab in the background) but never subscribed
        expect(t.controller.canSubscribe('b')).toBeNull();
    });
});

describe('what a waiting viewer is told', () => {
    it('only the first in line is told the avatar is not running; the others see their place', async () => {
        const t = setup({ minStartGapMs: 1000 });
        t.watch('a', 'A');
        t.watch('b', 'B');
        t.watch('c', 'C');
        t.ready();
        t.subscribe('a');
        t.advance(2000);
        t.controller.viewerUnsubscribed('a');
        t.controller.viewerDisconnected('a');
        expect(t.controller.state).toBe('stopping');
        // while Unreal is being replaced
        expect(t.controller.canSubscribe('b')).toBe(AVATAR_NOT_RUNNING);
        expect(t.controller.canSubscribe('c')).toBe(queueMessage(1));
        await t.finishStop();
        expect(t.controller.state).toBe('starting');
        expect(t.controller.canSubscribe('b')).toBe(AVATAR_NOT_RUNNING);
        expect(t.controller.canSubscribe('c')).toBe(queueMessage(1));
    });

    it('reports the place in line and the state to a page that asks', () => {
        const t = setup();
        t.watch('a', 'A');
        t.watch('b', 'B');
        expect(t.controller.status('A')).toEqual({ state: 'starting', ahead: 0 });
        expect(t.controller.status('B')).toEqual({ state: 'starting', ahead: 1 });
        t.ready();
        t.subscribe('a');
        expect(t.controller.status('B')).toEqual({ state: 'running', ahead: 1 }); // A is being served
        expect(t.controller.status('nobody')).toEqual({ state: 'running', ahead: null });
    });
});

describe('a fresh Unreal for every viewer', () => {
    it('stops Unreal when the viewer leaves, and stays off when nobody is waiting', async () => {
        const t = setup();
        t.watch('a');
        t.ready();
        t.subscribe('a');
        t.controller.viewerUnsubscribed('a');
        t.controller.viewerDisconnected('a');
        expect(t.controller.state).toBe('stopping');
        expect(t.calls).toEqual(['start', 'stop']);
        await t.finishStop();
        expect(t.controller.state).toBe('off');
        t.advance(60_000);
        expect(t.calls).toEqual(['start', 'stop']); // nobody is waiting: no new start
    });

    it('starts a fresh one for the next in line as soon as the old one is gone', async () => {
        const t = setup({ minStartGapMs: 1000 });
        t.watch('a');
        t.watch('b');
        t.ready();
        t.subscribe('a');
        t.advance(5000);
        t.controller.viewerUnsubscribed('a');
        t.controller.viewerDisconnected('a');
        expect(t.calls).toEqual(['start', 'stop']);
        // B is refused while the old Unreal shuts down
        expect(t.controller.canSubscribe('b')).toBe(AVATAR_NOT_RUNNING);
        await t.finishStop();
        expect(t.calls).toEqual(['start', 'stop', 'start']);
        expect(t.controller.state).toBe('starting');
        t.ready();
        expect(t.controller.canSubscribe('b')).toBeNull();
    });

    it('starts again for a later arrival after being idle', async () => {
        const t = setup({ minStartGapMs: 1000 });
        t.watch('a');
        t.ready();
        t.subscribe('a');
        t.controller.viewerUnsubscribed('a');
        t.controller.viewerDisconnected('a');
        await t.finishStop();
        t.advance(60_000);
        t.watch('b');
        expect(t.calls).toEqual(['start', 'stop', 'start']);
    });

    it('waits for the minimum gap before starting again, even when someone is waiting', async () => {
        const t = setup({ minStartGapMs: 10_000 });
        t.watch('a');
        t.watch('b');
        t.ready();
        t.subscribe('a');
        t.advance(1000); // A leaves 1 s after Unreal started
        t.controller.viewerUnsubscribed('a');
        t.controller.viewerDisconnected('a');
        await t.finishStop();
        expect(t.calls).toEqual(['start', 'stop']); // too soon
        t.advance(9000);
        expect(t.calls).toEqual(['start', 'stop', 'start']);
    });

    it('stops Unreal that runs with nobody watching or waiting', async () => {
        const t = setup({ idleStopMs: 10_000, entryTtlMs: 5000 });
        t.watch('a');
        t.ready();
        t.controller.viewerDisconnected('a'); // gave up before its turn
        t.advance(6000); // its place expires
        expect(t.controller.state).toBe('running');
        t.advance(11_000);
        expect(t.calls).toEqual(['start', 'stop']);
        await t.finishStop();
        expect(t.controller.state).toBe('off');
    });
});

describe('when things go wrong', () => {
    it('starts again after a crash when someone is waiting', () => {
        const t = setup({ minStartGapMs: 1000 });
        t.watch('a');
        t.ready();
        t.advance(5000);
        t.controller.setStreamerReady(false); // Unreal vanished
        expect(t.calls).toEqual(['start', 'start']);
    });

    it('does not start again after a crash when nobody is waiting', () => {
        const t = setup({ minStartGapMs: 1000, entryTtlMs: 1000 });
        t.watch('a');
        t.ready();
        t.controller.viewerDisconnected('a');
        t.advance(2000);
        t.controller.setStreamerReady(false);
        t.advance(60_000);
        expect(t.calls).toEqual(['start']);
    });

    it('gives up on a start that never registers, stops it, and tries again for the one still waiting', async () => {
        const t = setup({ startTimeoutMs: 60_000, minStartGapMs: 1000 });
        t.watch('a');
        t.advance(61_000);
        expect(t.controller.state).toBe('stopping');
        await t.finishStop();
        expect(t.logs.some((l) => l.startsWith('WARN') && /did not register/.test(l))).toBe(true);
        // the timeout was the wait: the next attempt follows at once
        expect(t.calls).toEqual(['start', 'stop', 'start']);
    });

    it('survives a start command that fails', async () => {
        const t = setup({
            start: () => Promise.reject(new Error('tmux is not running')),
            minStartGapMs: 1000
        });
        t.watch('a');
        await Promise.resolve();
        await Promise.resolve();
        expect(t.controller.state).toBe('off');
        expect(t.logs.some((l) => /start command failed/.test(l))).toBe(true);
        t.advance(10_000); // retried later, with a back-off
        expect(t.controller.state).toBe('starting');
    });
});

describe('queueKeyFromUrl', () => {
    it('reads the key from the WebSocket address', () => {
        expect(queueKeyFromUrl('/stream/?queue=abc-123')).toBe('abc-123');
        expect(queueKeyFromUrl('/?foo=1&queue=k')).toBe('k');
    });
    it('ignores a missing, empty or absurdly long key', () => {
        expect(queueKeyFromUrl(undefined)).toBeUndefined();
        expect(queueKeyFromUrl('/')).toBeUndefined();
        expect(queueKeyFromUrl('/?queue=')).toBeUndefined();
        expect(queueKeyFromUrl(`/?queue=${'x'.repeat(200)}`)).toBeUndefined();
    });
});
