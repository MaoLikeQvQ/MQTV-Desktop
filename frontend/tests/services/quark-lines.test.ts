import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchQuarkSource } from '@/services/quark-lines';
const { searchQuarkLine } = vi.hoisted(() => ({ searchQuarkLine: vi.fn() }));
vi.mock('@/api/quark', () => ({ searchQuarkLine }));
const source = { key: 'wogg', name: '玩偶', type: 3, api: 'csp_WoGG', searchable: 1, ext: { siteUrl: ['https://a.test', 'https://b.test'] } };
describe('Wogg mirror search', () => {
  beforeEach(() => { searchQuarkLine.mockReset(); });
  it('switches mirrors on request failure and trims the keyword', async () => {
    searchQuarkLine.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([{ title: '影片' }]);
    expect(await searchQuarkSource(source, ' 影片 ')).toEqual([{ title: '影片' }]);
    expect(searchQuarkLine.mock.calls).toEqual([['https://a.test', '影片'], ['https://b.test', '影片']]);
  });
  it('respects a successful empty result', async () => {
    searchQuarkLine.mockResolvedValueOnce([]);
    expect(await searchQuarkSource(source, '影片')).toEqual([]);
    expect(searchQuarkLine).toHaveBeenCalledTimes(1);
  });
  it('reports failure when every mirror fails', async () => {
    searchQuarkLine.mockRejectedValue(new Error('offline'));
    await expect(searchQuarkSource(source, '影片')).rejects.toThrow('所有玩偶镜像均请求失败');
  });
});
