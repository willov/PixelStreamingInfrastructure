// ICE servers (STUN and TURN) taken from a backend, instead of a TURN server configured here.
//
// The backend creates the TURN credentials (for example from Cloudflare) and hands them to this
// server over HTTP. This server keeps a cached copy, refreshes it in the background and gives it to
// every connecting peer through IServerConfig.peerOptionsProvider. That provider is synchronous, so
// it can only return what is already cached; fetching happens on a timer.
//
// A streamer receives its ICE servers once, when it connects, and cannot be given new ones while it
// stays connected, so its credentials last as long as the backend's lease for them. Reconnecting
// the streamer before that lease ends is not done here.
import { Logger, IPeerOptionsRequest, PeerOptionsProvider } from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.8';

export interface IBackendIceServersOptions {
    // Full URL of the backend route, e.g. http://127.0.0.1:5000/movement_analysis/ice_servers
    url: string;
    // Sent as `Authorization: Bearer <apiKey>`.
    apiKey: string;
    // How long to wait for the backend before giving up on one attempt.
    requestTimeoutMs?: number;
    // Injectable for tests.
    fetchFn?: typeof fetch;
    now?: () => number;
}

interface IBackendResponse {
    ice_servers?: unknown;
    turn?: unknown;
    expires_in_seconds?: unknown;
}

const DEFAULT_TIMEOUT_MS = 10_000;
// Retry after a failed fetch.
const RETRY_MS = 60_000;
// Refresh every hour at most, or sooner when the credentials are getting close to their end.
const MAX_REFRESH_MS = 60 * 60 * 1000;
const MIN_REFRESH_MS = 60_000;
// Stop handing out credentials this long before they expire, so a peer is not given ones that die
// while it is still connecting.
const EXPIRY_MARGIN_MS = 60_000;

export class BackendIceServers {
    private readonly options: IBackendIceServersOptions;
    private readonly fetchFn: typeof fetch;
    private readonly now: () => number;
    private iceServers: Record<string, unknown>[] | null = null;
    private expiresAt = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private stopped = false;
    private peersWithoutIceServers = 0;

    constructor(options: IBackendIceServersOptions) {
        this.options = options;
        this.fetchFn = options.fetchFn ?? fetch;
        this.now = options.now ?? Date.now;
    }

    /**
     * Fetches the ICE servers once, then keeps refreshing them. Never throws: a backend that is
     * not up yet is retried, and peers get the static options until it answers.
     */
    start(): Promise<void> {
        return this.refresh();
    }

    stop(): void {
        this.stopped = true;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    /** Milliseconds until the cached credentials stop being handed out; 0 when there are none. */
    msUntilExpiry(): number {
        return this.iceServers === null ? 0 : Math.max(0, this.expiresAt - EXPIRY_MARGIN_MS - this.now());
    }

    /**
     * One fetch from the backend, then schedules the next one. Exposed for tests.
     */
    async refresh(): Promise<void> {
        let delayMs = RETRY_MS;
        try {
            const fetched = await this.fetchFromBackend();
            const hadServers = this.iceServers !== null;
            this.iceServers = fetched.iceServers;
            this.expiresAt = this.now() + fetched.expiresInSeconds * 1000;
            delayMs = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, (fetched.expiresInSeconds * 1000) / 4));
            Logger.info(
                `Fetched ${fetched.iceServers.length} ICE server entries from the backend, valid for ${fetched.expiresInSeconds} s.` +
                    (fetched.turn ? '' : ' The backend has no TURN configured: STUN only.')
            );
            if (!hadServers && this.peersWithoutIceServers > 0) {
                Logger.warn(
                    `${this.peersWithoutIceServers} peer(s) connected before the first ICE servers arrived and ` +
                        'were configured without them. A streamer keeps its configuration until it reconnects.'
                );
            }
        } catch (error) {
            Logger.warn(
                `Could not fetch ICE servers from the backend (${error instanceof Error ? error.message : String(error)}); ` +
                    `retrying in ${RETRY_MS / 1000} s.`
            );
        }
        if (!this.stopped) {
            this.timer = setTimeout(() => void this.refresh(), delayMs);
            // Do not keep the process alive just for this timer.
            this.timer.unref?.();
        }
    }

    /**
     * A provider for IServerConfig.peerOptionsProvider. Every peer gets a copy of the static peer
     * options with the backend's ICE servers added after any configured there. While nothing valid is
     * cached the static options are returned unchanged.
     */
    createProvider(staticPeerOptions: unknown): PeerOptionsProvider {
        return (request: IPeerOptionsRequest): unknown => {
            // `peer_options` defaults to the empty string; a provider's result is sent as given.
            const base: Record<string, unknown> =
                typeof staticPeerOptions === 'object' && staticPeerOptions !== null
                    ? (structuredClone(staticPeerOptions) as Record<string, unknown>)
                    : {};

            if (this.iceServers === null || this.now() >= this.expiresAt - EXPIRY_MARGIN_MS) {
                this.peersWithoutIceServers++;
                Logger.warn(
                    `No valid ICE servers from the backend for ${request.peerType} ${request.peerId}; ` +
                        'sending the static peer options.'
                );
                return base;
            }

            const configured = Array.isArray(base['iceServers']) ? (base['iceServers'] as unknown[]) : [];
            base['iceServers'] = [...configured, ...structuredClone(this.iceServers)];
            return base;
        };
    }

    private async fetchFromBackend(): Promise<{
        iceServers: Record<string, unknown>[];
        turn: boolean;
        expiresInSeconds: number;
    }> {
        const response = await this.fetchFn(this.options.url, {
            headers: { Authorization: `Bearer ${this.options.apiKey}` },
            signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS)
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const body = (await response.json()) as IBackendResponse;
        const entries = body.ice_servers;
        if (!Array.isArray(entries) || entries.length === 0) {
            throw new Error('the response has no ice_servers');
        }
        const iceServers = entries.filter(
            (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null
        );
        // STUN only carries no expiry: use a day, the same as the TURN lease, and refresh hourly.
        const expiresInSeconds =
            typeof body.expires_in_seconds === 'number' && body.expires_in_seconds > 0
                ? body.expires_in_seconds
                : 24 * 60 * 60;
        return { iceServers, turn: body.turn === true, expiresInSeconds };
    }
}
