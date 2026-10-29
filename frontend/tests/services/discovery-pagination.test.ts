import { describe, expect, it, vi } from 'vitest';
import { createDiscoveryPagination } from '@/services/discovery-pagination';

const item = (id: string) => ({ id, title: id });

describe('discovery pagination', () => {
  it('coalesces repeated triggers and appends results while a page is still loading', async () => {
    let resolve!: (value: { items: ReturnType<typeof item>[] }) => void;
    let progress!: (value: { items: ReturnType<typeof item>[] }) => void;
    const loader = vi.fn((_page, changed) => {
      progress = changed;
      return new Promise<{ items: ReturnType<typeof item>[] }>(done => { resolve = done; });
    });
    const pager = createDiscoveryPagination([item('a')], loader, vi.fn());
    const pending = pager.load();
    await pager.load();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0][0]).toBe(1);
    progress({ items: [item('a'), item('b')] });
    expect(pager.read().items).toEqual([item('b')]);
    expect(pager.read().loading).toBe(true);
    resolve({ items: [item('a'), item('b'), item('c')] });
    await pending;
    expect(pager.read().items).toEqual([item('b'), item('c')]);
  });
  it('retains partial data after failure, requires explicit retry and retries the same cursor', async () => {
    const loader = vi.fn(async (_page, progress) => {
      progress({ items: [item('b')] });
      if (loader.mock.calls.length === 1) throw Error('HTTP 503');
      return { items: [item('b'), item('c')] };
    });
    const pager = createDiscoveryPagination([item('a')], loader, vi.fn());
    await pager.load();
    expect(pager.read().items).toEqual([item('b')]);
    expect(pager.read().error).toContain('HTTP 503');
    await pager.load();
    expect(loader).toHaveBeenCalledTimes(1);
    await pager.load(true);
    expect(loader.mock.calls.map(call => call[0])).toEqual([1, 1]);
    expect(pager.read().items).toEqual([item('b'), item('c')]);
    expect(pager.read().hasMore).toBe(true);
  });
  it.each([{ items: [] }, { items: [item('a')] }])('stops on empty or duplicate-only pages', async ({ items }) => {
    const loader = vi.fn(async () => ({ items }));
    const pager = createDiscoveryPagination([item('a')], loader, vi.fn());
    await pager.load();
    await pager.load();
    expect(pager.read().hasMore).toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it('ignores responses after leaving the page', async () => {
    let resolve!: (value: { items: ReturnType<typeof item>[] }) => void;
    const changed = vi.fn();
    const pager = createDiscoveryPagination([], () => new Promise(done => { resolve = done; }), changed);
    const pending = pager.load();
    pager.dispose();
    const calls = changed.mock.calls.length;
    resolve({ items: [item('stale')] });
    await pending;
    expect(changed).toHaveBeenCalledTimes(calls);
  });
});
