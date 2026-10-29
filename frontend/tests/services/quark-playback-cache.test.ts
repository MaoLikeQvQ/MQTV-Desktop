import { beforeEach, expect, it, vi } from 'vitest';
const { readQuarkInfo, scanQuarkEpisodes } = vi.hoisted(() => ({ readQuarkInfo: vi.fn(), scanQuarkEpisodes: vi.fn() }));
vi.mock('@/services/quark-episodes', () => ({ scanQuarkEpisodes }));
vi.mock('@/api/quark', () => ({ readQuarkInfo }));
const share = 'https://pan.quark.cn/s/test';
const episode = { id: 'file', name: '01.mp4', parent: '0', page: 1 };
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
  readQuarkInfo.mockReset();
  scanQuarkEpisodes.mockReset();
});
it('restores detail and complete episodes after module restart without requesting the source', async () => {
  readQuarkInfo.mockResolvedValue({ shares: [share], synopsis: '简介' });
  const cache = await import('@/services/quark-playback-cache');
  await cache.loadQuarkInfo('https://source.test/film');
  cache.saveQuarkEpisodeCache(share, [episode]);
  vi.resetModules();
  const restarted = await import('@/services/quark-playback-cache');
  expect(await restarted.loadQuarkInfo('https://source.test/film')).toEqual({ shares: [share], synopsis: '简介' });
  expect(restarted.readQuarkEpisodeCache(share)).toEqual([episode]);
  expect(readQuarkInfo).toHaveBeenCalledTimes(1);
});
it('refreshes explicitly while retaining cached data when a source refresh fails', async () => {
  const cache = await import('@/services/quark-playback-cache');
  readQuarkInfo.mockResolvedValue({ shares: [share], synopsis: 'old' });
  await cache.loadQuarkInfo('film');
  readQuarkInfo.mockRejectedValueOnce(new Error('offline'));
  await expect(cache.loadQuarkInfo('film', true)).rejects.toThrow('offline');
  expect((await cache.loadQuarkInfo('film')).synopsis).toBe('old');
  readQuarkInfo.mockResolvedValue({ shares: [share], synopsis: 'new' });
  expect((await cache.loadQuarkInfo('film', true)).synopsis).toBe('new');
});
it('isolates different shares and reports unavailable storage instead of silently discarding data', async () => {
  const cache = await import('@/services/quark-playback-cache');
  cache.saveQuarkEpisodeCache(share, [episode]);
  expect(cache.readQuarkEpisodeCache(share + 'other')).toBeNull();
  vi.stubGlobal('localStorage', { getItem: () => '{', setItem: () => { throw new Error('full'); } });
  expect(() => cache.readQuarkEpisodeCache(share)).toThrow('读取');
  expect(() => cache.saveQuarkEpisodeCache(share, [episode])).toThrow('保存失败');
});

it('does not rewrite unchanged background results and replaces only completed changed lists', async () => {
  const cache = await import('@/services/quark-playback-cache');
  cache.saveQuarkEpisodeCache(share, [episode]);
  const write = vi.spyOn(localStorage, 'setItem');
  scanQuarkEpisodes.mockImplementation(async (_share, _signal, emit) => emit(episode));
  expect(await cache.refreshQuarkEpisodes(share, new AbortController().signal)).toBeNull();
  expect(write).not.toHaveBeenCalled();
  const added = { ...episode, id: 'new', name: '02.mp4' };
  scanQuarkEpisodes.mockImplementation(async (_share, _signal, emit) => { emit(episode); emit(added); });
  expect(await cache.refreshQuarkEpisodes(share, new AbortController().signal)).toEqual([episode, added]);
  expect(cache.readQuarkEpisodeCache(share)).toEqual([episode, added]);
  expect(write).toHaveBeenCalledTimes(1);
});
it('retains the old complete directory on background failure or cancellation', async () => {
  const cache = await import('@/services/quark-playback-cache');
  cache.saveQuarkEpisodeCache(share, [episode]);
  scanQuarkEpisodes.mockRejectedValueOnce(new Error('offline'));
  await expect(cache.refreshQuarkEpisodes(share, new AbortController().signal)).rejects.toThrow('offline');
  const controller = new AbortController();
  scanQuarkEpisodes.mockImplementation(async (_share, _signal, emit) => { emit({ ...episode, id: 'new' }); controller.abort(); });
  expect(await cache.refreshQuarkEpisodes(share, controller.signal)).toBeNull();
  expect(cache.readQuarkEpisodeCache(share)).toEqual([episode]);
});
it('does not rewrite unchanged detail and ignores detail arriving after cancellation', async () => {
  const cache = await import('@/services/quark-playback-cache');
  readQuarkInfo.mockResolvedValue({ shares: [share], synopsis: 'old' });
  await cache.loadQuarkInfo('film');
  const write = vi.spyOn(localStorage, 'setItem');
  await cache.loadQuarkInfo('film', true);
  expect(write).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  readQuarkInfo.mockResolvedValue({ shares: [share], synopsis: 'new' });
  await cache.loadQuarkInfo('film', true, controller.signal);
  expect(cache.readQuarkInfoCache('film')?.synopsis).toBe('old');
});
it('fills missing episodes and updates metadata without removing or reordering cached episodes', async () => {
  const cache = await import('@/services/quark-playback-cache');
  const retained = { ...episode, id: 'retained', name: '02.mp4' };
  cache.saveQuarkEpisodeCache(share, [episode, retained]);
  const updated = { ...episode, name: '01 4K.mp4' };
  const added = { ...episode, id: 'new', name: '03.mp4' };
  scanQuarkEpisodes.mockImplementation(async (_share, _signal, emit) => { emit(added); emit(updated); });
  expect(await cache.refreshQuarkEpisodes(share, new AbortController().signal)).toEqual([updated, retained, added]);
  expect(cache.readQuarkEpisodeCache(share)).toEqual([updated, retained, added]);
});
it('supplements cached share lines without dropping existing lines or replacing synopsis with an empty response', async () => {
  const cache = await import('@/services/quark-playback-cache');
  readQuarkInfo.mockResolvedValue({ shares: [share], synopsis: '已有简介' });
  await cache.loadQuarkInfo('film');
  readQuarkInfo.mockResolvedValue({ shares: [share + 'new'], synopsis: '' });
  expect(await cache.loadQuarkInfo('film', true)).toEqual({ shares: [share, share + 'new'], synopsis: '已有简介' });
});
