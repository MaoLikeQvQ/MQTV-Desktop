import { describe, expect, it, vi } from 'vitest';
import { loadResource, readResourceCache, RESOURCE_TTL, resolveResourceUrl, DEFAULT_RESOURCE_URL } from '@/domain/resources/resource-cache';
const feed = { version: 'v1', count: 0, sites: [] };
function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
describe('default resource refresh', () => {
  it('migrates the local default while preserving custom addresses', () => {
    expect(resolveResourceUrl(null)).toBe(DEFAULT_RESOURCE_URL);
    expect(resolveResourceUrl(DEFAULT_RESOURCE_URL)).toBe(DEFAULT_RESOURCE_URL);
    expect(resolveResourceUrl('http://127.0.0.1:3101/api/resources')).toBe(DEFAULT_RESOURCE_URL);
    expect(resolveResourceUrl('http://localhost:3101/api/resources')).toBe(DEFAULT_RESOURCE_URL);
    expect(resolveResourceUrl('https://custom.example/api/resources')).toBe('https://custom.example/api/resources');
  });
  it('reuses default cache across same-day switching until seven days', async () => {
    const store = storage(); const fetcher = vi.fn().mockResolvedValue(feed); const now = 1000000;
    await loadResource(store, 'default', true, fetcher, now);
    await loadResource(store, 'custom', false, fetcher, now + 1000);
    expect((await loadResource(store, 'default', true, fetcher, now + 2000)).updatedAt).toBe(now);
    await loadResource(store, 'default', true, fetcher, now + RESOURCE_TTL - 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await loadResource(store, 'default', true, fetcher, now + RESOURCE_TTL);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('retains the cache and timestamp when refresh fails', async () => {
    const store = storage(); const now = 1000000;
    await loadResource(store, 'default', true, async () => feed, now);
    await expect(loadResource(store, 'default', true, async () => { throw Error('offline'); }, now + RESOURCE_TTL)).rejects.toThrow('offline');
    expect(readResourceCache(store, 'default')?.updatedAt).toBe(now);
  });
  it('keeps addresses separate and rejects malformed feeds', async () => {
    const store = storage();
    await expect(loadResource(store, 'default', true, async () => ({}))).rejects.toThrow();
    expect(readResourceCache(store, 'default')).toBeNull();
    const fetcher = vi.fn().mockResolvedValue(feed);
    await loadResource(store, 'another', true, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
