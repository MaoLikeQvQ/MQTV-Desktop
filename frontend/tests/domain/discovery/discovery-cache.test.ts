import { describe, expect, it, vi } from 'vitest';
import { createCoverCache, createDiscoveryCache, DISCOVERY_TTL } from '@/domain/discovery/discovery-cache';

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
const response = { items: [{ id: '1', title: '电影', cover: 'https://example.com/1.jpg', rating: '8.0' }] };
const now = 1000000;

describe('discovery content cache', () => {
  it('checks the one-hour boundary at startup and keeps each running session stable', async () => {
    const store = storage(); const cache = createDiscoveryCache(store, now);
    const fetcher = vi.fn().mockResolvedValue(response);
    await cache.load('recommended', fetcher, now);
    await cache.load('movie:热门', fetcher, now + 1000);
    await cache.load('recommended', fetcher, now + DISCOVERY_TTL * 3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const withinHour = createDiscoveryCache(store, now + DISCOVERY_TTL);
    expect(withinHour.needsRefresh('recommended')).toBe(false);
    // Even a first visit several hours into this session reuses what was fresh at startup.
    await withinHour.load('recommended', fetcher, now + DISCOVERY_TTL * 4);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const nextStart = createDiscoveryCache(store, now + DISCOVERY_TTL + 1);
    expect(nextStart.needsRefresh('recommended')).toBe(true);
    await nextStart.load('recommended', fetcher, now + DISCOVERY_TTL + 1);
    await nextStart.load('recommended', fetcher, now + DISCOVERY_TTL * 5);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('shares simultaneous requests, including a remount before completion', async () => {
    const cache = createDiscoveryCache(storage(), now); const fetcher = vi.fn().mockResolvedValue(response);
    const first = cache.load('home', fetcher, now);
    const second = cache.load('home', fetcher, now);
    expect(first).toBe(second);
    await first;
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('preserves expired content and retries only when explicitly requested or restarted', async () => {
    const store = storage();
    await createDiscoveryCache(store, now).load('home', async () => response, now);
    const cache = createDiscoveryCache(store, now + DISCOVERY_TTL + 1);
    const fetcher = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce({ items: [] });
    await expect(cache.load('home', fetcher, now + DISCOVERY_TTL + 1)).rejects.toThrow('offline');
    expect(cache.read('home')).toEqual({ items: response.items, updatedAt: now });
    await expect(cache.load('home', fetcher, now + DISCOVERY_TTL + 2)).rejects.toThrow('offline');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cache.needsRefresh('home')).toBe(false);
    cache.retryFailed();
    expect(cache.needsRefresh('home')).toBe(true);
    await cache.load('home', fetcher, now + DISCOVERY_TTL + 3);
    expect(cache.read('home')?.items).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed responses without overwriting the previous list', async () => {
    const store = storage();
    await createDiscoveryCache(store, now).load('home', async () => response, now);
    const cache = createDiscoveryCache(store, now + DISCOVERY_TTL + 1);
    await expect(cache.load('home', async () => ({}), now + DISCOVERY_TTL + 1)).rejects.toThrow('推荐内容格式异常');
    expect(cache.read('home')?.items).toEqual(response.items);
  });
  it('treats corrupt storage as a miss and still works when storage is full', async () => {
    const cache = createDiscoveryCache({ getItem: () => '{invalid', setItem: () => { throw Error('quota'); } });
    expect(cache.read('home')).toBeNull();
    const fetcher = vi.fn().mockResolvedValue(response);
    await cache.load('home', fetcher, now);
    await cache.load('home', fetcher, now + 1);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('discovery cover cache', () => {
  it('shares in-flight downloads and reuses downloaded bytes across card mounts', async () => {
    const load = createCoverCache(); const fetcher = vi.fn().mockResolvedValue([1, 2, 3]);
    const first = load('poster', fetcher);
    expect(load('poster', fetcher)).toBe(first);
    const blob = await first;
    expect(await load('poster', fetcher)).toBe(blob);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('retries failures and evicts the least recently used cover at the limit', async () => {
    const load = createCoverCache(2);
    const fetcher = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue([1]);
    await expect(load('a', fetcher)).rejects.toThrow('offline');
    await load('a', fetcher);
    await load('b', fetcher);
    await load('a', fetcher);
    await load('c', fetcher);
    await load('a', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(4);
    await load('b', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});

describe('persistent cover backing', () => {
  it('reuses downloaded blobs after a new application cache is created', async () => {
    const saved = new Map<string, Blob>();
    const backing = { read: async (url: string) => saved.get(url) ?? null, write: async (url: string, blob: Blob) => { saved.set(url, blob); } };
    const fetcher = vi.fn().mockResolvedValue([1, 2, 3]);
    await createCoverCache(120, backing)('poster', fetcher);
    const nextRun = createCoverCache(120, backing);
    expect((await nextRun('poster', fetcher)).size).toBe(3);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('falls back to a network load if disk reads fail and keeps memory if disk writes fail', async () => {
    const backing = { read: async () => { throw Error('unavailable'); }, write: async () => { throw Error('full'); } };
    const fetcher = vi.fn().mockResolvedValue([1]);
    const load = createCoverCache(120, backing);
    await load('poster', fetcher); await load('poster', fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not persist empty or failed image downloads', async () => {
    const backing = { read: async () => null, write: vi.fn() };
    const load = createCoverCache(120, backing);
    await expect(load('poster', async () => [])).rejects.toThrow('图片内容为空');
    await expect(load('poster', async () => { throw Error('offline'); })).rejects.toThrow('offline');
    expect(backing.write).not.toHaveBeenCalled();
  });
});
