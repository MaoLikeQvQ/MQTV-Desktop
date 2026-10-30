import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
import { connectPlayerWindow, openPlayerWindow, type PlayerRequest } from '@/platform/player-window';

function request(revision: number): PlayerRequest {
  return { revision, selection: { vod: { vod_id: revision, vod_name: `film-${revision}`, source: { key: 'a', name: 'source', api: 'https://example.invalid', type: 1, searchable: 1 } }, group: null, resource: 'test' } };
}
beforeEach(() => vi.clearAllMocks());

describe('single player window delivery', () => {
  it('ignores a stale ready response after a newer live selection arrives', async () => {
    let deliver!: (event: { payload: PlayerRequest }) => void;
    native.listen.mockImplementation(async (_name, callback) => { deliver = callback; return vi.fn(); });
    let ready!: (value: PlayerRequest) => void;
    native.invoke.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
    const receive = vi.fn();
    const dispose = connectPlayerWindow(receive, vi.fn());
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('player_window_ready'));
    deliver({ payload: request(2) });
    ready(request(1));
    await Promise.resolve();
    expect(receive.mock.calls.map(call => call[0].vod.vod_id)).toEqual([2]);
    deliver({ payload: request(2) });
    deliver({ payload: request(3) });
    expect(receive.mock.calls.map(call => call[0].vod.vod_id)).toEqual([2, 3]);
    dispose();
  });

  it('unregisters a late listener and never handshakes after unmount', async () => {
    let registered!: (unlisten: () => void) => void;
    native.listen.mockImplementation(() => new Promise(resolve => { registered = resolve; }));
    const receive = vi.fn();
    const unlisten = vi.fn();
    connectPlayerWindow(receive, vi.fn())();
    registered(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
    expect(native.invoke).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
  });

  it('reports initialization errors and passes choices through IPC rather than URL', async () => {
    native.listen.mockRejectedValueOnce(new Error('listen failed'));
    const error = vi.fn();
    connectPlayerWindow(vi.fn(), error);
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    native.invoke.mockResolvedValue(undefined);
    const selection = request(1).selection;
    await openPlayerWindow(selection);
    expect(native.invoke).toHaveBeenCalledWith('player_window_open', { selection });
  });
});
