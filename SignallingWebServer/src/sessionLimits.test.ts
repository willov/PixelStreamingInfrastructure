import { PlayerRegistry } from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.8';
import { limitSessionLength, SESSION_LIMIT_CLOSE_CODE } from './sessionLimits';

function fakePlayer() {
    const disconnect = jest.fn();
    return { player: { playerId: '', protocol: { disconnect }, subscribedStreamer: null } as never, disconnect };
}

describe('limitSessionLength', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('disconnects a viewer that is still connected when the limit is reached', () => {
        const registry = new PlayerRegistry();
        limitSessionLength(registry, 7200);
        const { player, disconnect } = fakePlayer();
        registry.add(player);

        jest.advanceTimersByTime(7199 * 1000);
        expect(disconnect).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1000);
        expect(disconnect).toHaveBeenCalledWith(SESSION_LIMIT_CLOSE_CODE, 'session time limit reached');
    });

    it('leaves a viewer alone that disconnected before the limit', () => {
        const registry = new PlayerRegistry();
        limitSessionLength(registry, 60);
        const { player, disconnect } = fakePlayer();
        registry.add(player);
        registry.remove(player);

        jest.advanceTimersByTime(120 * 1000);
        expect(disconnect).not.toHaveBeenCalled();
    });

    it('counts every viewer from its own start', () => {
        const registry = new PlayerRegistry();
        limitSessionLength(registry, 100);
        const first = fakePlayer();
        const second = fakePlayer();
        registry.add(first.player);
        jest.advanceTimersByTime(60 * 1000);
        registry.add(second.player);

        jest.advanceTimersByTime(40 * 1000);     // 100 s since the first
        expect(first.disconnect).toHaveBeenCalledTimes(1);
        expect(second.disconnect).not.toHaveBeenCalled();
        jest.advanceTimersByTime(60 * 1000);
        expect(second.disconnect).toHaveBeenCalledTimes(1);
    });
});
