import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKEND_URL, DEFAULT_RESOURCE_URL, DOUBAN_URL } from '@/config/services';
import { requestJson } from '@/utils/request';
import { fetchImageBytes } from '@/api/images';
import { buildRequestUrl, serviceOrigin } from '@/utils/url';
import { discoveryContent } from '@/services/discovery';
import { animeSources } from '@/services/discovery';
import { searchMedia, readMediaDetail } from '@/api/media';
import { checkAppUpdate } from '@/services/update';
import { createDiscoveryCache } from '@/domain/discovery/discovery-cache';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });

describe('shared JSON transport', () => {
  it('resolves backend paths, encodes parameters and preserves custom source queries', async () => {
    invoke.mockResolvedValue({ list: [] });
    await requestJson('/api/example', { params: { tag: '日本 动画&新', page: 0, enabled: false, ignored: undefined } });
    const url = new URL(invoke.mock.calls[0][1].url);
    expect(url.origin).toBe(BACKEND_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({ tag: '日本 动画&新', page: '0', enabled: 'false' });
    await searchMedia('https://source.example/api?token=a%2Bb&ac=old', ' 测试 ');
    const search = new URL(invoke.mock.calls[1][1].url);
    expect(search.origin).toBe('https://source.example');
    expect(Object.fromEntries(search.searchParams)).toEqual({ token: 'a+b', ac: 'videolist', wd: '测试', pg: '1' });
    await readMediaDetail('https://source.example/api', 'id&other=1');
    expect(new URL(invoke.mock.calls[2][1].url).searchParams.get('ids')).toBe('id&other=1');
  });
  it.each(['file:///tmp/a', 'javascript:alert(1)', 'https://user:password@example.test/api', 'https://example.test/api#fragment'])('rejects invalid URLs before native dispatch: %s', async address => {
    await expect(requestJson(address)).rejects.toBeInstanceOf(Error);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('normalizes native failures and leaves retry decisions to callers', async () => {
    invoke.mockRejectedValue('HTTP 503');
    await expect(requestJson('/api/resources')).rejects.toThrow('HTTP 503');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('validates public service origins', () => {
    expect(serviceOrigin(' https://example.test:8443/ ', 'TEST')).toBe('https://example.test:8443');
    for (const value of [undefined, '', 'file:///tmp', 'https://user@example.test', 'https://example.test/path', 'https://example.test/?token=1']) {
      expect(() => serviceOrigin(value, 'TEST')).toThrow('TEST');
    }
    expect(buildRequestUrl('/api/resources', {}, BACKEND_URL)).toBe(DEFAULT_RESOURCE_URL);
  });
});

describe('business requests and cache integration', () => {
  it('uses configured discovery and anime services', async () => {
    invoke.mockResolvedValue({ subjects: [] });
    const request = discoveryContent('movie', '热门');
    await request.load();
    expect(invoke).toHaveBeenCalledWith('fetch_json', { url: request.key });
    expect(new URL(request.key).origin).toBe(DOUBAN_URL);
    expect(new URL(request.key).pathname).toBe('/j/search_subjects');
    expect(new URL(animeSources.japan.key).origin).toBe(DOUBAN_URL);
    expect(Object.keys(animeSources)).toEqual(['japan', 'china']);
    invoke.mockResolvedValueOnce({ subjects: [{ id: 1, title: '动画' }] });
    expect((await animeSources.japan.load()).items[0].title).toBe('动画');
  });
  it('merges overseas regions in order, deduplicates and fails visibly on partial errors', async () => {
    invoke.mockImplementation(async (_command, { url }) => {
      const country = new URL(url).searchParams.get('countries');
      return { data: [{ id: 'shared', title: '共同影片' }, { id: country, title: country }] };
    });
    const result = await discoveryContent('recommended', 'douban_show_global').load();
    expect(result.items.map(item => item.title)).toEqual(['共同影片', '美国', '英国', '日本', '韩国']);
    expect(invoke).toHaveBeenCalledTimes(4);
    for (const call of invoke.mock.calls) {
      const url = new URL(call[1].url);
      expect(url.origin).toBe(DOUBAN_URL);
      expect(url.searchParams.get('tags')).toBe('综艺');
    }
    invoke.mockRejectedValueOnce('HTTP 418');
    await expect(discoveryContent('recommended', 'douban_show_global').load()).rejects.toThrow('HTTP 418');
  });
  it('shows the real weekly ranking before covers arrive and preserves rank while matching exact IDs', async () => {
    const coverResolvers: ((value: unknown) => void)[] = [];
    invoke.mockImplementation((command: string) => command === 'douban_weekly'
      ? Promise.resolve({ subjects: [{ id: '42', title: '同名影片' }, { id: '7', title: '第二名' }] })
      : new Promise(resolve => { coverResolvers.push(resolve); }));
    const progress = vi.fn();
    const request = discoveryContent('recommended', 'douban_movie_weekly');
    const loading = request.load(progress);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(new URL(request.key).pathname).toBe('/chart');
    expect(invoke.mock.calls[0]).toEqual(['douban_weekly', { url: request.key }]);
    expect(progress.mock.calls[0][0].items.map((item: { title: string }) => item.title)).toEqual(['同名影片', '第二名']);
    // Release both cover requests independently while keeping the ranking stable.
    coverResolvers[1]([{ id: '7', img: 'https://img9.doubanio.com/second.jpg' }]);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(2));
    expect(progress.mock.calls[1][0].items[1].cover).toBe('https://img9.doubanio.com/second.jpg');
    coverResolvers[0]([{ id: '99', img: 'https://img9.doubanio.com/wrong.jpg' }, { id: '42', img: 'https://img9.doubanio.com/right.jpg' }]);
    const result = await loading;
    expect(result.items.map(item => item.id)).toEqual(['douban:42', 'douban:7']);
    expect(result.items[0].cover).toBe('https://img9.doubanio.com/right.jpg');
  });
  it('starts concurrent regions in display order and publishes a later response without waiting for the first', async () => {
    const resolvers: ((value: unknown) => void)[] = [];
    invoke.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve); }));
    const progress = vi.fn();
    const loading = discoveryContent('recommended', 'douban_tv_global').load(progress);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(invoke.mock.calls.map(call => new URL(call[1].url).searchParams.get('countries'))).toEqual(['美国', '英国', '日本', '韩国']);
    expect(progress).not.toHaveBeenCalled();
    resolvers[1]({ data: [{ id: 2, title: '先返回的影片' }] });
    await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(1));
    expect(progress.mock.calls[0][0].items[0].title).toBe('先返回的影片');
    resolvers[0]({ data: [{ id: 1, title: '后返回的影片' }] });
    resolvers[2]({ data: [] });
    resolvers[3]({ data: [] });
    const result = await loading;
    expect(progress).toHaveBeenCalledTimes(4);
    expect(result.items.map(item => item.title)).toEqual(['后返回的影片', '先返回的影片']);
  });
  it('continues later regions after failure and keeps published results out of persistent cache', async () => {
    invoke.mockRejectedValueOnce('HTTP 418').mockResolvedValue({ data: [{ id: 1, title: '可用影片' }] });
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const cache = createDiscoveryCache(storage);
    const request = discoveryContent('recommended', 'douban_tv_global');
    const progress = vi.fn();
    await expect(cache.load(request.key, () => request.load(progress))).rejects.toThrow('HTTP 418');
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(progress.mock.calls[progress.mock.calls.length - 1]?.[0].items[0].title).toBe('可用影片');
    expect(cache.read(request.key)).toBeNull();
  });
  it.each([
    ['movie', '热门', '/j/search_subjects', '热门'],
    ['recommended', 'douban_tv_chinese', '/j/search_subjects', '国产剧'],
    ['recommended', 'douban_show_chinese', '/j/new_search_subjects', '综艺,中国大陆'],
    ['movie', '经典', '/j/search_subjects', '经典'],
    ['movie', '最新', '/j/search_subjects', '热门'],
    ['tv', '韩剧', '/j/search_subjects', '韩剧'],
    ['variety', '综艺', '/j/new_search_subjects', '综艺'],
  ] as const)('loads %s %s directly from Douban and normalizes its response', async (channel, filter, path, tag) => {
    invoke.mockResolvedValue({ subjects: [{ id: 123, title: '影片', rate: '8.5' }] });
    const request = discoveryContent(channel, filter);
    expect((await request.load()).items[0]).toMatchObject({ id: 'douban:123', title: '影片', rating: '8.5' });
    const url = new URL(request.key);
    expect(url.origin).toBe(DOUBAN_URL);
    expect(url.pathname).toBe(path);
    expect(url.searchParams.get('tag') ?? url.searchParams.get('tags')).toBe(tag);
    if (filter === '最新') expect(url.searchParams.get('sort')).toBe('time');
  });
  it('keeps request keys stable and reuses discovery data across a restart within one hour', async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    invoke.mockResolvedValue({ subjects: [{ id: '1', title: '缓存影片' }] });
    const request = discoveryContent('movie', '热门');
    await createDiscoveryCache(storage, 1000).load(request.key, () => request.load(), 1000);
    const restarted = createDiscoveryCache(storage, 2000);
    expect(restarted.needsRefresh(request.key)).toBe(false);
    expect((await restarted.load(request.key, () => request.load())).items[0].title).toBe('缓存影片');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('uses the endpoint-specific next-page offsets without dropping merged regional results', async () => {
    invoke.mockImplementation(async () => ({ data: Array.from({ length: 20 }, (_, i) => ({ id: String(invoke.mock.calls.length) + ':' + i, title: '影片' + i })) }));
    const overseas = await discoveryContent('recommended', 'douban_tv_global', 1).load();
    expect(overseas.items).toHaveLength(80);
    for (const call of invoke.mock.calls) expect(new URL(call[1].url).searchParams.get('start')).toBe('20');
    invoke.mockClear();
    invoke.mockResolvedValue({ subjects: [] });
    await discoveryContent('movie', '热门', 2).load();
    expect(new URL(invoke.mock.calls[0][1].url).searchParams.get('page_start')).toBe('60');
  });
  it('validates update responses through the business API', async () => {
    invoke.mockResolvedValue({ updateAvailable: false });
    expect(await checkAppUpdate({ platform: 'macos', arch: 'arm64', osVersion: '26.0', packageName: 'com.maolike.mqtv.desktop', versionCode: 1, versionName: '0.1.0' })).toEqual({ updateAvailable: false });
    expect(new URL(invoke.mock.calls[0][1].url).origin).toBe(BACKEND_URL);
  });
  it('preserves native cover routing and image bytes', async () => {
    invoke.mockResolvedValue([1, 2, 3]);
    expect(await fetchImageBytes('https://img9.doubanio.com/a.jpg')).toEqual([1, 2, 3]);
    expect(invoke).toHaveBeenLastCalledWith('fetch_cover', { url: 'https://img9.doubanio.com/a.jpg', direct: false });
    await fetchImageBytes('https://lain.bgm.tv/a.jpg');
    expect(invoke).toHaveBeenLastCalledWith('fetch_cover', { url: 'https://lain.bgm.tv/a.jpg', direct: true });
    await fetchImageBytes('https://other.example/a.jpg');
    expect(invoke).toHaveBeenLastCalledWith('fetch_image', { url: 'https://other.example/a.jpg' });
  });
});
