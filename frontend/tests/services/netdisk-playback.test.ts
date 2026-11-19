import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  readNetdiskInfo: vi.fn(), readUcSettings: vi.fn(), playUcEpisode: vi.fn(), playQuarkEpisode: vi.fn(),
  readQuarkInfoCache: vi.fn(), scanUcEpisodes: vi.fn(), scanQuarkEpisodes: vi.fn(), readQuarkEpisodeCache: vi.fn(),
  saveQuarkEpisodeCache: vi.fn(), refreshQuarkEpisodes: vi.fn(),
  values: new Map<string, string>(),
}));
vi.mock('@/api/uc', () => ({ readNetdiskInfo: mocks.readNetdiskInfo, readUcSettings: mocks.readUcSettings, playUcEpisode: mocks.playUcEpisode }));
vi.mock('@/api/quark', () => ({ playQuarkEpisode: mocks.playQuarkEpisode }));
vi.mock('@/services/uc-episodes', () => ({ scanUcEpisodes: mocks.scanUcEpisodes }));
vi.mock('@/services/quark-episodes', () => ({ scanQuarkEpisodes: mocks.scanQuarkEpisodes }));
vi.mock('@/services/quark-playback-cache', () => ({ readQuarkInfoCache: mocks.readQuarkInfoCache, readQuarkEpisodeCache: mocks.readQuarkEpisodeCache, saveQuarkEpisodeCache: mocks.saveQuarkEpisodeCache, refreshQuarkEpisodes: mocks.refreshQuarkEpisodes }));
vi.mock('@/services/storage', () => ({ applicationStorage: { getItem: (key: string) => mocks.values.get(key) ?? null, setItem: (key: string, value: string) => mocks.values.set(key, value) } }));
import { loadNetdiskInfo, readNetdiskInfoCache, netdiskPlayback } from '@/services/netdisk-playback';
const uc = 'https://drive.uc.cn/s/a?pwd=1234', quark = 'https://pan.quark.cn/s/a';
const episode = { id: 'file', name: '01.mp4', parent: '0', page: 1 };
beforeEach(() => {
  vi.clearAllMocks(); mocks.values.clear();
  mocks.readQuarkInfoCache.mockReturnValue(null);
  mocks.readUcSettings.mockResolvedValue({ cached: true, accountId: 'account-a' });
  mocks.playUcEpisode.mockResolvedValue({ url: 'http://127.0.0.1/uc/media' });
  mocks.playQuarkEpisode.mockResolvedValue({ url: 'http://127.0.0.1/quark/media' });
  mocks.readQuarkEpisodeCache.mockReturnValue([episode]);
});
it('loads mixed public shares once, rejects other hosts, preserves synopsis and ignores cancelled writes', async () => {
  mocks.readNetdiskInfo.mockResolvedValue({ shares: [uc, quark, uc, 'https://pan.baidu.com/s/a'], synopsis: '简介' });
  expect(await loadNetdiskInfo('film')).toEqual({ shares: [uc, quark], synopsis: '简介' });
  expect(await loadNetdiskInfo('film')).toEqual(readNetdiskInfoCache('film'));
  expect(mocks.readNetdiskInfo).toHaveBeenCalledTimes(1);
  mocks.readNetdiskInfo.mockResolvedValue({ shares: [quark], synopsis: '' });
  expect(await loadNetdiskInfo('film', true)).toEqual({ shares: [quark], synopsis: '简介' });
  const controller = new AbortController(); controller.abort();
  mocks.readNetdiskInfo.mockResolvedValue({ shares: [uc], synopsis: 'new' });
  await loadNetdiskInfo('film', true, controller.signal);
  expect(readNetdiskInfoCache('film')).toEqual({ shares: [quark], synopsis: '简介' });
});
it('isolates UC directory caches by account and keeps the legacy Quark cache contract', async () => {
  const first = await netdiskPlayback(uc);
  await first.saveCache([episode]);
  expect(first.readCache()).toEqual([episode]);
  mocks.readUcSettings.mockResolvedValue({ cached: true, accountId: 'account-b' });
  const second = await netdiskPlayback(uc);
  expect(second.readCache()).toBeNull();
  await expect(first.saveCache([episode])).rejects.toThrow('账号已变化');
  mocks.readUcSettings.mockResolvedValue({ cached: true, accountId: 'account-a' });
  expect((await netdiskPlayback(uc)).readCache()).toEqual([episode]);
  const legacy = await netdiskPlayback(quark);
  expect(legacy.readCache(true)).toEqual([episode]);
  expect(mocks.readQuarkEpisodeCache).toHaveBeenCalledWith(quark, true);
  await legacy.saveCache([episode]);
  expect(mocks.saveQuarkEpisodeCache).toHaveBeenCalledWith(quark, [episode]);
});
it('dispatches UC and Quark playback separately and rejects a stale UC account', async () => {
  const context = await netdiskPlayback(uc);
  expect(await context.play(episode)).toEqual({ url: 'http://127.0.0.1/uc/media' });
  expect(mocks.playUcEpisode).toHaveBeenCalledWith({ share: uc, passcode: '1234', parent: '0', fid: 'file', page: 1 });
  await (await netdiskPlayback(quark)).play(episode);
  expect(mocks.playQuarkEpisode).toHaveBeenCalledWith({ share: quark, passcode: '', parent: '0', fid: 'file', page: 1 });
  mocks.readUcSettings.mockResolvedValue({ cached: true, accountId: 'account-b' });
  await expect(context.play(episode)).rejects.toThrow('账号已变化');
  expect(mocks.playUcEpisode).toHaveBeenCalledTimes(1);
});
it('requires UC authorization without preventing unbound Quark playback', async () => {
  mocks.readUcSettings.mockResolvedValue({ cached: false });
  await expect(netdiskPlayback(uc)).rejects.toThrow('扫码登录 UC');
  await expect(netdiskPlayback(quark)).resolves.toBeDefined();
  await expect(netdiskPlayback('https://evil.test/s/a')).rejects.toThrow('不支持');
});
it('keeps complete UC metadata when scanning fails or is cancelled and merges successful updates', async () => {
  const context = await netdiskPlayback(uc);
  await context.saveCache([episode]);
  mocks.scanUcEpisodes.mockRejectedValueOnce(new Error('offline'));
  await expect(context.refresh(new AbortController().signal)).rejects.toThrow('offline');
  expect(context.readCache()).toEqual([episode]);
  const controller = new AbortController();
  mocks.scanUcEpisodes.mockImplementationOnce(async (_share, _signal, emit) => { emit({ ...episode, id: 'new' }); controller.abort(); });
  expect(await context.refresh(controller.signal)).toBeNull();
  expect(context.readCache()).toEqual([episode]);
  mocks.scanUcEpisodes.mockImplementationOnce(async (_share, _signal, emit) => { emit({ ...episode, name: '01 4K.mp4' }); emit({ ...episode, id: 'new' }); });
  expect(await context.refresh(new AbortController().signal)).toEqual([{ ...episode, name: '01 4K.mp4' }, { ...episode, id: 'new' }]);
});
it('expires search directory caches after ten minutes while retaining history metadata', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000000);
  try {
    const context = await netdiskPlayback(uc);
    await context.saveCache([episode]);
    clock.mockReturnValue(1600000);
    expect(context.readCache(true)).toBeNull();
    expect(context.readCache()).toEqual([episode]);
  } finally { clock.mockRestore(); }
});

it('restores legacy Quark detail caches so existing offline history remains available', async () => {
  mocks.readQuarkInfoCache.mockReturnValue({ shares: [quark], synopsis: '旧简介' });
  expect(await loadNetdiskInfo('legacy-film')).toEqual({ shares: [quark], synopsis: '旧简介' });
  expect(mocks.readNetdiskInfo).not.toHaveBeenCalled();
  expect(mocks.readQuarkInfoCache).toHaveBeenCalledWith('legacy-film', false);
});
