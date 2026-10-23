// Runs Unreal on demand, one fresh instance per viewer, with a waiting line.
//
//   - a viewer arrives and Unreal is off: start it
//   - the viewer who was watching leaves: stop Unreal, so the next viewer never sees a used session
//   - viewers are waiting: start a fresh Unreal for the first in line as soon as the old one is gone
//   - nobody is waiting: stay off until the next arrival
//
// Starting and stopping are two commands that this server only runs (for example the tmux script's
// `restart unreal` and `stop unreal`), so the process, its log and its Ctrl-C handling stay where the
// operator already looks. The server learns that Unreal is up from the streamer registering with it.
//
// The waiting line is first come, first served. A viewer page that waits reconnects every few seconds, so
// its place is kept by a key the page sends (?queue=...), not by the connection, and a viewer that
// disappears loses its place after a short while. Only the first in line may subscribe to the streamer.
import { execFile } from 'child_process';
import { Logger, SignallingServer } from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.8';

export type UnrealState = 'off' | 'starting' | 'running' | 'stopping';

// The refusal messages the viewer page recognises (see lab.ts).
export const AVATAR_NOT_RUNNING = 'avatar not running';
export const queueMessage = (ahead: number) => `queue ${ahead}`;

export interface OnDemandOptions {
    /** Starts a fresh Unreal. Resolves when the command has run, not when Unreal has registered. */
    start: () => Promise<void>;
    /** Stops Unreal and resolves when it has gone. */
    stop: () => Promise<void>;
    /** A start that has not registered a streamer after this long counts as failed. */
    startTimeoutMs?: number;
    /** The least time between two starts, so a stream of arrivals cannot make Unreal flap. */
    minStartGapMs?: number;
    /** How long a viewer that disconnected keeps its place in line. */
    entryTtlMs?: number;
    /** How long the first in line has to take its turn before the next one is offered it. */
    turnTimeoutMs?: number;
    /** How long Unreal may run with nobody watching and nobody waiting. */
    idleStopMs?: number;
    now?: () => number;
    log?: { info(message: string): void; warn(message: string): void };
}

interface Entry {
    key: string;
    players: Set<string>;
    lastSeen: number;
}

export class OnDemandUnreal {
    state: UnrealState = 'off';

    private readonly opts: Required<Omit<OnDemandOptions, 'start' | 'stop'>> & Pick<OnDemandOptions, 'start' | 'stop'>;
    private entries = new Map<string, Entry>(); // the waiting line, in arrival order
    private keyOf = new Map<string, string>(); // player id -> line key
    private holder: { key: string; playerId: string } | null = null;
    private startedAt = 0;
    private lastStart = -Infinity;
    private failures = 0;
    private headKey: string | undefined;
    private headSince = 0;
    private idleSince: number | undefined;

    constructor(options: OnDemandOptions) {
        this.opts = {
            startTimeoutMs: 60_000,
            minStartGapMs: 10_000,
            entryTtlMs: 15_000,
            turnTimeoutMs: 30_000,
            idleStopMs: 10_000,
            now: Date.now,
            log: { info: () => undefined, warn: () => undefined },
            ...options
        };
    }

    // ---- what the signalling server tells us -------------------------------------------------------------

    viewerConnected(playerId: string, key?: string): void {
        const k = key || `player:${playerId}`;
        this.keyOf.set(playerId, k);
        const entry = this.entries.get(k) ?? { key: k, players: new Set<string>(), lastSeen: 0 };
        entry.players.add(playerId);
        entry.lastSeen = this.now();
        this.entries.set(k, entry);
        this.tick();
    }

    viewerDisconnected(playerId: string): void {
        const k = this.keyOf.get(playerId);
        this.keyOf.delete(playerId);
        if (k !== undefined) {
            const entry = this.entries.get(k);
            if (entry) {
                entry.players.delete(playerId);
                entry.lastSeen = this.now();
            }
        }
        if (this.holder?.playerId === playerId) {
            this.holderLeft();
        }
        this.tick();
    }

    viewerSubscribed(playerId: string): void {
        const k = this.keyOf.get(playerId) ?? `player:${playerId}`;
        this.holder = { key: k, playerId };
        this.entries.delete(k); // it has its turn: no longer in line
        this.headKey = undefined;
    }

    viewerUnsubscribed(playerId: string): void {
        if (this.holder?.playerId === playerId) {
            this.holderLeft();
            this.tick();
        }
    }

    /** Whether a streamer that can be subscribed to is registered. Call it whenever that may have changed. */
    setStreamerReady(ready: boolean): void {
        if (ready && this.state === 'starting') {
            this.state = 'running';
            this.failures = 0;
            this.opts.log.info('Unreal registered; the first in line can connect.');
        } else if (!ready && this.state === 'running') {
            // It went away on its own (a crash, or someone stopped it by hand).
            this.opts.log.warn('Unreal disconnected unexpectedly.');
            this.state = 'off';
        }
        this.tick();
    }

    /** At start-up: an Unreal that is already running is adopted instead of started a second time. */
    adoptRunning(): void {
        if (this.state === 'off') {
            this.state = 'running';
        }
    }

    /**
     * How many viewers are ahead of this one: the one being served and those in line before it.
     * 0 means first in line; null means it is not in line (it never connected, or lost its place).
     */
    aheadOf(key: string): number | null {
        const index = this.presentKeys().indexOf(key);
        return index === -1 ? null : index + (this.holder ? 1 : 0);
    }

    /** What a viewer page may ask for while it waits: the state of Unreal and its own place in line. */
    status(key: string): { state: UnrealState; ahead: number | null } {
        return { state: this.state, ahead: this.aheadOf(key) };
    }

    /**
     * The refusal for this player's attempt to subscribe, or null when it may subscribe. Only the first in line
     * is told that the avatar is not running; the others always see their place in line.
     */
    canSubscribe(playerId: string): string | null {
        if (this.holder?.playerId === playerId) {
            return null;
        }
        const ahead = this.aheadOf(this.keyOf.get(playerId) ?? '') ?? this.presentKeys().length + (this.holder ? 1 : 0);
        if (ahead > 0) {
            return queueMessage(ahead);
        }
        return this.state === 'running' ? null : AVATAR_NOT_RUNNING;
    }

    // ---- the state machine -------------------------------------------------------------------------------

    /** Call about once a second, and after every event (the methods above do). */
    tick(): void {
        const now = this.now();
        // Viewers that left and did not come back lose their place.
        for (const [key, entry] of this.entries) {
            if (entry.players.size === 0 && now - entry.lastSeen > this.opts.entryTtlMs) {
                this.entries.delete(key);
            }
        }
        const waiting = this.presentKeys();

        switch (this.state) {
            case 'off':
                if (waiting.length > 0 && now - this.lastStart >= this.startGap()) {
                    this.startNow();
                }
                break;
            case 'starting':
                if (now - this.startedAt > this.opts.startTimeoutMs) {
                    this.failures++;
                    this.opts.log.warn(`Unreal did not register within ${this.opts.startTimeoutMs / 1000} s; stopping it.`);
                    this.beginStop();
                }
                break;
            case 'running':
                this.tickRunning(now, waiting);
                break;
            case 'stopping':
                break;
        }
    }

    private tickRunning(now: number, waiting: string[]): void {
        if (this.holder) {
            this.headKey = undefined;
            this.idleSince = undefined;
            return;
        }
        if (waiting.length === 0) {
            this.headKey = undefined;
            this.idleSince ??= now;
            if (now - this.idleSince > this.opts.idleStopMs) {
                this.opts.log.info('Nobody is watching or waiting; stopping Unreal.');
                this.beginStop();
            }
            return;
        }
        this.idleSince = undefined;
        // The first in line must come and take its turn; one that does not (a tab in the background) is dropped.
        if (this.headKey !== waiting[0]) {
            this.headKey = waiting[0];
            this.headSince = now;
        } else if (now - this.headSince > this.opts.turnTimeoutMs) {
            this.opts.log.info('The first in line did not take its turn; offering it to the next one.');
            this.entries.delete(waiting[0]);
            this.headKey = undefined;
        }
    }

    private holderLeft(): void {
        this.opts.log.info('The viewer left; Unreal is stopped, the next one gets a fresh instance.');
        this.holder = null;
        this.headKey = undefined;
        if (this.state === 'running' || this.state === 'starting') {
            this.beginStop();
        }
    }

    private startGap(): number {
        const backoff = this.failures > 0 ? Math.min(60_000, 5_000 * 2 ** (this.failures - 1)) : 0;
        return Math.max(this.opts.minStartGapMs, backoff);
    }

    private startNow(): void {
        this.state = 'starting';
        this.startedAt = this.lastStart = this.now();
        this.opts.log.info('Starting Unreal.');
        this.opts.start().catch((error) => {
            this.failures++;
            this.opts.log.warn(`The start command failed: ${String(error)}`);
            if (this.state === 'starting') {
                this.state = 'off';
            }
        });
    }

    private beginStop(): void {
        if (this.state === 'stopping') {
            return;
        }
        this.state = 'stopping';
        this.opts
            .stop()
            .catch((error) => this.opts.log.warn(`The stop command failed: ${String(error)}`))
            .finally(() => {
                this.state = 'off';
                this.tick();
            });
    }

    private presentKeys(): string[] {
        const now = this.now();
        return [...this.entries.values()]
            .filter((entry) => entry.players.size > 0 || now - entry.lastSeen <= this.opts.entryTtlMs)
            .map((entry) => entry.key);
    }

    private now(): number {
        return this.opts.now();
    }
}

// ---- wiring to the signalling server and to the commands -------------------------------------------------

/** The line key a viewer page sends in its WebSocket address (?queue=...), if any. */
export function queueKeyFromUrl(url: string | undefined): string | undefined {
    if (!url) {
        return undefined;
    }
    try {
        const key = new URL(url, 'http://localhost').searchParams.get('queue');
        return key && key.length <= 100 ? key : undefined;
    } catch {
        return undefined;
    }
}

function runCommand(command: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile('bash', ['-c', command], { timeout: timeoutMs }, (error, stdout, stderr) => {
            const output = `${stdout}${stderr}`.trim();
            if (output) {
                Logger.info(`[${command}] ${output}`);
            }
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

export interface OnDemandConfig {
    startCommand: string;
    stopCommand: string;
    startTimeoutSeconds: number;
    minStartGapSeconds: number;
    turnTimeoutSeconds: number;
}

/** Creates the controller. Pass its `canSubscribe` to the server's config, then `attach` it to the server. */
export function createOnDemandUnreal(config: OnDemandConfig): OnDemandUnreal {
    return new OnDemandUnreal({
        start: () => runCommand(config.startCommand, 60_000),
        stop: () => runCommand(config.stopCommand, 60_000),
        startTimeoutMs: config.startTimeoutSeconds * 1000,
        minStartGapMs: config.minStartGapSeconds * 1000,
        turnTimeoutMs: config.turnTimeoutSeconds * 1000,
        log: { info: (m) => Logger.info(m), warn: (m) => Logger.warn(m) }
    });
}

export function attachOnDemandUnreal(server: SignallingServer, controller: OnDemandUnreal): void {
    const ready = () => server.streamerRegistry.streamers.some((streamer) => streamer.streaming);

    server.playerRegistry.on('added', (playerId: string) => {
        const url = server.playerRegistry.get(playerId)?.request?.url;
        controller.viewerConnected(playerId, queueKeyFromUrl(url));
    });
    server.playerRegistry.on('removed', (playerId: string) => controller.viewerDisconnected(playerId));

    server.streamerRegistry.on('added', (streamerId: string) => {
        const streamer = server.streamerRegistry.find(streamerId);
        streamer?.on('subscribed', (playerId: string) => controller.viewerSubscribed(playerId));
        streamer?.on('unsubscribed', (playerId: string) => controller.viewerUnsubscribed(playerId));
        // A streamer can be subscribed to once it has identified itself, which renames it.
        streamer?.on('id_changed', () => controller.setStreamerReady(ready()));
    });
    server.streamerRegistry.on('removed', () => controller.setStreamerReady(ready()));

    if (ready()) {
        controller.adoptRunning();
    }
    // The state machine also runs on a clock: entries expire, turns time out, idle Unreal stops.
    setInterval(() => {
        controller.setStreamerReady(ready());
    }, 1000).unref();
}
