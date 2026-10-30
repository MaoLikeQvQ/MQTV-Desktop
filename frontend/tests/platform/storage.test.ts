import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDiscardingPendingStorage, installStorageCloseGuard } from '@/platform/storage';
const { current, invoke, listen, unlistenClose, unlistenExit } = vi.hoisted(() => ({
  current: { onCloseRequested: vi.fn(), close: vi.fn() }, invoke: vi.fn(), listen: vi.fn(), unlistenClose: vi.fn(), unlistenExit: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => current }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  current.onCloseRequested.mockResolvedValue(unlistenClose);
  current.close.mockResolvedValue(undefined);
  listen.mockResolvedValue(unlistenExit);
  invoke.mockResolvedValue(undefined);
});

describe('normal window close and application exit storage guard', () => {
  it('prevents pending close until writes have finished', async () => {
    let finish!: () => void;
    const flush = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await installStorageCloseGuard(() => true, flush, vi.fn());
    const event = { preventDefault: vi.fn() };
    const waiting = current.onCloseRequested.mock.calls[0][0](event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(current.close).not.toHaveBeenCalled();
    finish();
    await waiting;
    expect(current.close).toHaveBeenCalledTimes(1);
  });
  it('keeps the window open on save failure and reports listener setup failure', async () => {
    await installStorageCloseGuard(() => true, vi.fn().mockRejectedValue(new Error('disk')), vi.fn());
    const event = { preventDefault: vi.fn() };
    await current.onCloseRequested.mock.calls[0][0](event);
    expect(current.close).not.toHaveBeenCalled();
    current.onCloseRequested.mockRejectedValue(new Error('permission'));
    await expect(installStorageCloseGuard(() => true, vi.fn(), vi.fn())).rejects.toThrow('permission');
  });
  it('allows already durable state to close normally and exposes native close errors', async () => {
    await installStorageCloseGuard(() => false, vi.fn(), vi.fn());
    const event = { preventDefault: vi.fn() };
    await current.onCloseRequested.mock.calls[0][0](event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    const report = vi.fn();
    current.close.mockRejectedValueOnce(new Error('close'));
    await installStorageCloseGuard(() => true, vi.fn().mockResolvedValue(undefined), report);
    await current.onCloseRequested.mock.calls[1][0](event);
    expect(report).toHaveBeenCalled();
  });
  it('registers all listeners before enabling native exit protection and flushes before exiting', async () => {
    let finish!: () => void;
    const flush = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const cleanup = await installStorageCloseGuard(() => true, flush, vi.fn());
    expect(listen).toHaveBeenCalledWith('storage-exit-requested', expect.any(Function));
    expect(invoke).toHaveBeenCalledWith('storage_enable_exit_guard');
    expect(listen.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
    const waiting = listen.mock.calls[0][1]();
    expect(invoke).not.toHaveBeenCalledWith('storage_exit_ready');
    finish();
    await waiting;
    expect(invoke).toHaveBeenLastCalledWith('storage_exit_ready');
    cleanup();
    expect(unlistenClose).toHaveBeenCalled();
    expect(unlistenExit).toHaveBeenCalled();
  });
  it('does not exit after a failed flush, but explicit discard exits without flushing', async () => {
    const flush = vi.fn().mockRejectedValue(new Error('disk'));
    await installStorageCloseGuard(() => true, flush, vi.fn());
    await listen.mock.calls[0][1]();
    expect(invoke).not.toHaveBeenCalledWith('storage_exit_ready');
    await closeDiscardingPendingStorage();
    expect(invoke).toHaveBeenLastCalledWith('storage_exit');
    expect(flush).toHaveBeenCalledTimes(1);
  });
  it('cleans registered listeners if event registration or enabling protection fails', async () => {
    listen.mockRejectedValueOnce(new Error('listen'));
    await expect(installStorageCloseGuard(() => true, vi.fn(), vi.fn())).rejects.toThrow('listen');
    expect(unlistenClose).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith('storage_enable_exit_guard');
    invoke.mockRejectedValueOnce(new Error('enable'));
    await expect(installStorageCloseGuard(() => true, vi.fn(), vi.fn())).rejects.toThrow('enable');
    expect(unlistenClose).toHaveBeenCalledTimes(2);
    expect(unlistenExit).toHaveBeenCalledTimes(2);
  });
  it('freezes before exit flush and remains frozen once this window is ready', async () => {
    const freeze = vi.fn();
    const resume = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    await installStorageCloseGuard(() => false, flush, vi.fn(), { freeze, resume });
    await listen.mock.calls[0][1]();
    expect(freeze.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[0]);
    expect(invoke).toHaveBeenLastCalledWith('storage_exit_ready');
    expect(resume).not.toHaveBeenCalled();
  });
  it('unfreezes after failed flush or failed readiness acknowledgement', async () => {
    const freeze = vi.fn();
    const resume = vi.fn();
    const report = vi.fn();
    await installStorageCloseGuard(() => true, vi.fn().mockRejectedValue(new Error('full')), report, { freeze, resume });
    await listen.mock.calls[0][1]();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith('storage_exit_ready');
    await installStorageCloseGuard(() => false, vi.fn().mockResolvedValue(undefined), report, { freeze, resume });
    invoke.mockRejectedValueOnce(new Error('native'));
    await listen.mock.calls.filter(call => call[0] === 'storage-exit-requested')[1][1]();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalled();
  });

  it('releases an already ready window when another window cancels exit', async () => {
    const freeze = vi.fn();
    const resume = vi.fn();
    await installStorageCloseGuard(() => false, vi.fn().mockResolvedValue(undefined), vi.fn(), { freeze, resume });
    await listen.mock.calls.find(call => call[0] === 'storage-exit-requested')![1]();
    expect(resume).not.toHaveBeenCalled();
    listen.mock.calls.find(call => call[0] === 'storage-exit-cancelled')![1]();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('captures final progress before deciding whether close needs a flush and prevents reentrant dispatch', async () => {
    let pending = false;
    window.dispatchEvent = vi.fn(() => { pending = true; return true; });
    const flush = vi.fn().mockImplementation(async () => { pending = false; });
    await installStorageCloseGuard(() => pending, flush, vi.fn());
    const close = current.onCloseRequested.mock.calls[0][0];
    const event = { preventDefault: vi.fn() };
    current.close.mockImplementationOnce(async () => { await close(event); });
    await close(event);
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
    expect((window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls[0][0].type).toBe('mqtv-before-close');
    expect(flush).toHaveBeenCalledTimes(1);
    expect(current.close).toHaveBeenCalledTimes(1);
  });

  it('captures progress before freezing exit and can retry after cancellation', async () => {
    const order: string[] = [];
    window.dispatchEvent = vi.fn(() => { order.push('progress'); return true; });
    const freeze = vi.fn(() => { order.push('freeze'); });
    const resume = vi.fn();
    const flush = vi.fn().mockRejectedValueOnce(new Error('full')).mockResolvedValue(undefined);
    await installStorageCloseGuard(() => true, flush, vi.fn(), { freeze, resume });
    const requested = listen.mock.calls.find(call => call[0] === 'storage-exit-requested')![1];
    await requested();
    expect(order).toEqual(['progress', 'freeze']);
    expect(invoke).toHaveBeenLastCalledWith('storage_exit_cancel');
    listen.mock.calls.find(call => call[0] === 'storage-exit-cancelled')![1]();
    await requested();
    expect(invoke).toHaveBeenLastCalledWith('storage_exit_ready');
    expect(order).toEqual(['progress', 'freeze', 'progress', 'freeze']);
    expect(resume).toHaveBeenCalled();
  });

  it('cleans exit and close listeners if the cancellation listener cannot register', async () => {
    listen.mockResolvedValueOnce(unlistenExit).mockRejectedValueOnce(new Error('cancel-listen'));
    await expect(installStorageCloseGuard(() => false, vi.fn(), vi.fn())).rejects.toThrow('cancel-listen');
    expect(unlistenExit).toHaveBeenCalledTimes(1);
    expect(unlistenClose).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith('storage_enable_exit_guard');
  });

});
