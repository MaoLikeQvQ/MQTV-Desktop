import { describe, expect, it, vi } from 'vitest';
import { createApplicationStorage } from '@/services/storage';

function legacy(entries: Record<string, string>) {
  const keys = Object.keys(entries);
  return { length: keys.length, key: (index: number) => keys[index] ?? null, getItem: (key: string) => entries[key] ?? null,
    setItem: vi.fn(), removeItem: vi.fn() };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('SQLite application storage', () => {
  it('imports only application keys, prefers the native snapshot and preserves legacy data', async () => {
    const old = legacy({ 'mqtv-feed': 'old', unrelated: 'private' });
    const migrate = vi.fn().mockResolvedValue({ 'mqtv-feed': 'new', 'mqtv-search-scores-v1': '{}' });
    const storage = createApplicationStorage({ snapshot: vi.fn().mockResolvedValue({}), migrate, apply: vi.fn() });
    expect(() => storage.getItem('mqtv-feed')).toThrow('初始化');
    await storage.initialize(old);
    expect(migrate).toHaveBeenCalledWith({ 'mqtv-feed': 'old' });
    expect(storage.getItem('mqtv-feed')).toBe('new');
    expect(old.removeItem).not.toHaveBeenCalled();
  });

  it('does not become readable when snapshot or migration fails', async () => {
    const migrate = vi.fn().mockRejectedValue(new Error('disk full'));
    const storage = createApplicationStorage({ snapshot: vi.fn().mockResolvedValue({}), migrate, apply: vi.fn() });
    await expect(storage.initialize(legacy({ 'mqtv-feed': 'old' }))).rejects.toThrow('disk full');
    expect(() => storage.getItem('mqtv-feed')).toThrow('初始化');
  });

  it('serializes writes, retains newer values and flush waits for every transaction', async () => {
    const first = deferred();
    const second = deferred();
    const apply = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const storage = createApplicationStorage({ snapshot: vi.fn().mockResolvedValue({}), migrate: vi.fn().mockResolvedValue({}), apply });
    await storage.initialize(legacy({}));
    storage.setItem('mqtv-a', 'first');
    storage.setItems({ 'mqtv-a': 'new', 'mqtv-b': 'together' });
    expect(apply).toHaveBeenCalledTimes(1);
    const flushed = vi.fn();
    const waiting = storage.flush().then(flushed);
    first.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(apply).toHaveBeenNthCalledWith(2, { 'mqtv-a': 'new', 'mqtv-b': 'together' });
    expect(flushed).not.toHaveBeenCalled();
    second.resolve();
    await waiting;
    expect(storage.hasPending()).toBe(false);
    expect(storage.getItem('mqtv-a')).toBe('new');
  });

  it('keeps failed changes pending, exposes a persistent error and retries the transaction explicitly', async () => {
    const apply = vi.fn().mockRejectedValueOnce(new Error('full')).mockResolvedValue(undefined);
    const storage = createApplicationStorage({ snapshot: vi.fn().mockResolvedValue({}), migrate: vi.fn().mockResolvedValue({ 'mqtv-old': 'yes' }), apply });
    await storage.initialize(legacy({}));
    const changed = vi.fn();
    storage.subscribe(changed);
    storage.setItems({ 'mqtv-old': null, 'mqtv-new': 'new' });
    await expect(storage.flush()).rejects.toThrow('尚未保存');
    expect(storage.hasPending()).toBe(true);
    expect(storage.getError()).toBeInstanceOf(Error);
    expect(changed).toHaveBeenCalled();
    expect(() => storage.setItem('mqtv-third', 'blocked')).toThrow('保存失败');
    await storage.retry();
    expect(apply).toHaveBeenLastCalledWith({ 'mqtv-old': null, 'mqtv-new': 'new' });
    expect(storage.hasPending()).toBe(false);
    expect(storage.getError()).toBeNull();
  });
  it('player initialization reads only SQLite and never marks legacy import complete', async () => {
    const migrate = vi.fn();
    const storage = createApplicationStorage({ snapshot: vi.fn().mockResolvedValue({ 'mqtv-history': 'existing' }), migrate, apply: vi.fn() });
    await storage.initialize();
    expect(storage.getItem('mqtv-history')).toBe('existing');
    expect(migrate).not.toHaveBeenCalled();
  });

  it('buffers startup events and synchronizes other windows including deletions', async () => {
    const snapshot = deferred();
    const storage = createApplicationStorage({ snapshot: () => snapshot.promise.then(() => ({ 'mqtv-history': 'old' })), migrate: vi.fn(), apply: vi.fn() });
    const changed = vi.fn();
    storage.subscribe(changed);
    const initialized = storage.initialize();
    storage.receiveChanges({ 'mqtv-history': 'new', unrelated: 'ignored' });
    snapshot.resolve();
    await initialized;
    expect(storage.getItem('mqtv-history')).toBe('new');
    expect(storage.getItem('unrelated')).toBeNull();
    storage.receiveChanges({ 'mqtv-history': null });
    expect(storage.getItem('mqtv-history')).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(storage.hasPending()).toBe(false);
  });

  it('keeps local pending edits visible but applies the latest committed event after acknowledgement', async () => {
    const writing = deferred();
    const storage = createApplicationStorage({ snapshot: vi.fn().mockResolvedValue({}), migrate: vi.fn(), apply: () => writing.promise });
    await storage.initialize();
    storage.setItem('mqtv-history', 'local');
    storage.receiveChanges({ 'mqtv-history': 'older-commit', 'mqtv-other': 'remote' });
    expect(storage.getItem('mqtv-history')).toBe('local');
    expect(storage.getItem('mqtv-other')).toBe('remote');
    // 原生在同一把锁内依序提交并广播，后到事件代表最终持久化值。
    storage.receiveChanges({ 'mqtv-history': 'local' });
    storage.receiveChanges({ 'mqtv-history': 'newer-remote-commit' });
    writing.resolve();
    await storage.flush();
    expect(storage.getItem('mqtv-history')).toBe('newer-remote-commit');
  });

  it('freezes new writes while existing transactions flush and permits recovery after a failure', async () => {
    const writing = deferred();
    const apply = vi.fn().mockReturnValueOnce(writing.promise).mockResolvedValue(undefined);
    const storage = createApplicationStorage({ snapshot: vi.fn().mockResolvedValue({}), migrate: vi.fn(), apply });
    await storage.initialize();
    storage.setItem('mqtv-history', 'saved-before-exit');
    storage.freezeWrites();
    expect(storage.isFrozen()).toBe(true);
    expect(() => storage.setItem('mqtv-new', 'blocked')).toThrow('正在退出');
    expect(storage.getItem('mqtv-new')).toBeNull();
    const flushing = storage.flush();
    writing.reject(new Error('full'));
    await expect(flushing).rejects.toThrow('尚未保存');
    storage.resumeWrites();
    expect(storage.isFrozen()).toBe(false);
    await storage.retry();
    storage.setItem('mqtv-new', 'allowed');
    await storage.flush();
    expect(storage.getItem('mqtv-new')).toBe('allowed');
    storage.freezeWrites();
    await storage.flush();
    expect(() => storage.removeItem('mqtv-history')).toThrow('正在退出');
    expect(storage.hasPending()).toBe(false);
  });

  it('orders non-coalescible operations with ordinary writes and flush includes them', async () => {
    const first = deferred();
    const operation = deferred();
    const events: string[] = [];
    const apply = vi.fn(async (entries: Record<string, string | null>) => {
      events.push(Object.values(entries)[0]!);
      if (events.length === 1) await first.promise;
    });
    const storage = createApplicationStorage({ snapshot: vi.fn().mockResolvedValue({}), migrate: vi.fn(), apply });
    await storage.initialize();
    storage.setItem('mqtv-setting', 'first');
    storage.enqueueOperation(async () => { events.push('history'); await operation.promise; });
    storage.setItem('mqtv-setting', 'last');
    const done = vi.fn();
    const waiting = storage.flush().then(done);
    first.resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(events).toEqual(['first', 'history']);
    expect(storage.hasPending()).toBe(true);
    expect(done).not.toHaveBeenCalled();
    operation.resolve();
    await waiting;
    expect(events).toEqual(['first', 'history', 'last']);
    expect(storage.hasPending()).toBe(false);
  });

  it('retains a failed operation at the head for explicit retry without skipping later writes', async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error('full')).mockResolvedValue(undefined);
    const apply = vi.fn().mockResolvedValue(undefined);
    const storage = createApplicationStorage({ snapshot: vi.fn().mockResolvedValue({}), migrate: vi.fn(), apply });
    await storage.initialize();
    storage.enqueueOperation(operation);
    storage.setItem('mqtv-setting', 'after-history');
    await expect(storage.flush()).rejects.toThrow('尚未保存');
    expect(storage.hasPending()).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    await storage.retry();
    expect(operation).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith({ 'mqtv-setting': 'after-history' });
    expect(storage.hasPending()).toBe(false);
  });

});
