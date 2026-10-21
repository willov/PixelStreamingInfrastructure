// A hard limit on how long one viewer may stay connected.
//
// The viewer page ends a session itself (idle timeout, time limit) and says so, but a modified or
// broken client can ignore that and hold the only place of a --max_players 1 streamer for as long as
// it likes. This is the backstop: the server drops any viewer connection that reaches the limit.
import { Logger, PlayerRegistry } from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.8';

// WebSocket close codes 4000-4999 are free for applications to use.
export const SESSION_LIMIT_CLOSE_CODE = 4000;

/**
 * Disconnects every viewer `maxSeconds` after it connected. A viewer that is waiting for a free place
 * reconnects every few seconds and so never gets near the limit; only a viewer that holds a connection
 * for the whole time is affected.
 */
export function limitSessionLength(registry: PlayerRegistry, maxSeconds: number): void {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    registry.on('added', (playerId: string) => {
        const timer = setTimeout(() => {
            timers.delete(playerId);
            const player = registry.get(playerId);
            if (!player) {
                return;
            }
            Logger.info(`Player ${playerId} reached the session limit of ${maxSeconds} s; disconnecting it.`);
            player.protocol.disconnect(SESSION_LIMIT_CLOSE_CODE, 'session time limit reached');
        }, maxSeconds * 1000);
        // Never keep the process alive for this.
        timer.unref?.();
        timers.set(playerId, timer);
    });

    registry.on('removed', (playerId: string) => {
        const timer = timers.get(playerId);
        if (timer !== undefined) {
            clearTimeout(timer);
            timers.delete(playerId);
        }
    });
}
