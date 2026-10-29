import { expect, it } from 'vitest';
import { episodeLabel } from '@/domain/media/episode-label';

it('moves the episode prefix into a badge and retains quality text', () => {
  expect(episodeLabel('01 4K.mp4', 1)).toEqual({ badge: '01', label: '4K' });
  expect(episodeLabel('第02集 - 初入仙途.mkv', 2)).toEqual({ badge: '02', label: '初入仙途' });
  expect(episodeLabel('03.mp4', 3)).toEqual({ badge: '03', label: '播放' });
});
it('retains unrelated numbers and complete titles', () => {
  expect(episodeLabel('4K 修复版.mp4', 1).label).toBe('4K 修复版');
  expect(episodeLabel('2020 特别篇.mp4', 2).label).toBe('2020 特别篇');
  expect(episodeLabel('初入仙途.mp4', 100)).toEqual({ badge: '100', label: '初入仙途' });
});
