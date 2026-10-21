import { BackendIceServers } from './backendIceServers';

const REQUEST = { peerType: 'player' as const, peerId: 'p1' };
const STREAMER = { peerType: 'streamer' as const, peerId: 's1' };
const BACKEND_SERVERS = [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }
];

function backendResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeFetch(...answers: Array<Response | Error>) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    let i = 0;
    const fn = jest.fn((url: string, init?: RequestInit) => {
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        const answer = answers[Math.min(i++, answers.length - 1)];
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone());
    });
    return { fn: fn as unknown as typeof fetch, calls, mock: fn };
}

function iceServersOf(options: unknown): Record<string, unknown>[] {
    return (options as { iceServers: Record<string, unknown>[] }).iceServers;
}

describe('BackendIceServers', () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;

    beforeEach(() => {
        clock = 1_700_000_000_000;
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    function create(...answers: Array<Response | Error>) {
        const f = makeFetch(...answers);
        const ice = new BackendIceServers({ url: 'http://backend/ice', apiKey: 'secret', fetchFn: f.fn, now });
        return { ice, ...f };
    }

    it('asks the backend with the API key as a bearer token', async () => {
        const { ice, calls } = create(backendResponse({ ice_servers: BACKEND_SERVERS, turn: true, expires_in_seconds: 86400 }));
        await ice.start();
        ice.stop();
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('http://backend/ice');
        expect(calls[0].headers['Authorization']).toBe('Bearer secret');
    });

    it('gives every peer the backend servers after the statically configured ones', async () => {
        const { ice } = create(backendResponse({ ice_servers: BACKEND_SERVERS, turn: true, expires_in_seconds: 86400 }));
        await ice.start();
        ice.stop();
        const provider = ice.createProvider({ iceServers: [{ urls: ['stun:static.example:3478'] }], other: 1 });

        for (const request of [REQUEST, STREAMER]) {
            const options = provider(request) as Record<string, unknown>;
            expect(iceServersOf(options)).toEqual([{ urls: ['stun:static.example:3478'] }, ...BACKEND_SERVERS]);
            expect(options['other']).toBe(1);
        }
    });

    it('never lets one peer change what the next one receives', async () => {
        const { ice } = create(backendResponse({ ice_servers: BACKEND_SERVERS, turn: true, expires_in_seconds: 86400 }));
        await ice.start();
        ice.stop();
        const provider = ice.createProvider('');   // peer_options defaults to the empty string

        iceServersOf(provider(REQUEST))[1]['credential'] = 'tampered';
        expect(iceServersOf(provider(REQUEST))[1]['credential']).toBe('c');
    });

    it('sends the static options until the first answer, and says so when it arrives', async () => {
        const { ice } = create(
            new Error('connection refused'),
            backendResponse({ ice_servers: BACKEND_SERVERS, turn: true, expires_in_seconds: 86400 })
        );
        const provider = ice.createProvider({ iceServers: [{ urls: ['stun:static.example:3478'] }] });

        await ice.start();                       // fails: the backend is not up yet
        expect(iceServersOf(provider(STREAMER))).toEqual([{ urls: ['stun:static.example:3478'] }]);

        await jest.advanceTimersByTimeAsync(60_000);   // the retry
        ice.stop();
        expect(iceServersOf(provider(REQUEST))).toEqual([{ urls: ['stun:static.example:3478'] }, ...BACKEND_SERVERS]);
    });

    it('stops handing out credentials shortly before they expire', async () => {
        const { ice } = create(backendResponse({ ice_servers: BACKEND_SERVERS, turn: true, expires_in_seconds: 600 }));
        await ice.start();
        ice.stop();
        const provider = ice.createProvider({});

        clock += 500_000;   // 100 s left: still fine
        expect(iceServersOf(provider(REQUEST))).toHaveLength(2);
        clock += 45_000;    // 55 s left: inside the 60 s margin
        expect((provider(REQUEST) as Record<string, unknown>)['iceServers']).toBeUndefined();
    });

    it('refreshes hourly for a long lease, and sooner for a short one', async () => {
        const long = create(backendResponse({ ice_servers: BACKEND_SERVERS, turn: true, expires_in_seconds: 86400 }));
        await long.ice.start();
        await jest.advanceTimersByTimeAsync(59 * 60 * 1000);
        expect(long.mock).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
        expect(long.mock).toHaveBeenCalledTimes(2);
        long.ice.stop();

        const short = create(backendResponse({ ice_servers: BACKEND_SERVERS, turn: true, expires_in_seconds: 400 }));
        await short.ice.start();
        await jest.advanceTimersByTimeAsync(101_000);   // a quarter of 400 s
        expect(short.mock).toHaveBeenCalledTimes(2);
        short.ice.stop();
    });

    it('keeps the cached servers when a refresh fails, and retries after a minute', async () => {
        const { ice, mock } = create(
            backendResponse({ ice_servers: BACKEND_SERVERS, turn: true, expires_in_seconds: 86400 }),
            backendResponse({}, 500),
            backendResponse({ ice_servers: BACKEND_SERVERS, turn: true, expires_in_seconds: 86400 })
        );
        const provider = ice.createProvider({});
        await ice.start();
        await jest.advanceTimersByTimeAsync(60 * 60 * 1000);      // refresh -> HTTP 500
        expect(mock).toHaveBeenCalledTimes(2);
        expect(iceServersOf(provider(REQUEST))).toHaveLength(2);   // still serving the cached copy

        await jest.advanceTimersByTimeAsync(60_000);               // retry
        expect(mock).toHaveBeenCalledTimes(3);
        ice.stop();
    });

    it('rejects an answer without ICE servers', async () => {
        const { ice } = create(backendResponse({ ice_servers: [], turn: false }));
        await ice.start();
        ice.stop();
        expect(ice.msUntilExpiry()).toBe(0);
    });

    it('reports STUN only answers without breaking', async () => {
        const { ice } = create(backendResponse({ ice_servers: [BACKEND_SERVERS[0]], turn: false, expires_in_seconds: null }));
        await ice.start();
        ice.stop();
        expect(iceServersOf(ice.createProvider({})(REQUEST))).toEqual([BACKEND_SERVERS[0]]);
    });
});
