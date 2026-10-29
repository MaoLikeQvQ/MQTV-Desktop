import { animeListUrl } from '@/api/discovery';
import { describe, expect, it } from 'vitest';
import { animeDate, dailyAnime, parseAnimeList } from '@/domain/discovery/anime';

describe('anime data sources', () => {
  it('requests distinct animation categories rather than general regional TV', () => {
    expect(new URL(animeListUrl('japan')).searchParams.get('tag')).toBe('日本动画');
    expect(new URL(animeListUrl('china')).searchParams.get('tags')).toBe('中国大陆,动画');
    expect(parseAnimeList({ data: [{ id: '1', title: '国产动画' }] }).items[0].title).toBe('国产动画');
  });
  it('uses 24-item and 20-item offsets for the regional next pages', () => {
    expect(new URL(animeListUrl('japan', 2)).searchParams.get('page_start')).toBe('48');
    expect(new URL(animeListUrl('china', 2)).searchParams.get('start')).toBe('40');
  });
  it('normalizes real Douban subjects, omits missing scores and unsafe images', () => {
    expect(parseAnimeList({ subjects: [
      { id: '1', title: '国产动画', cover: 'https://img9.doubanio.com/a.jpg', rate: '9.1' },
      { id: '2', title: '日本动画', cover: 'javascript:alert(1)', rate: '0' }, null, { id: '3' },
    ] }).items).toEqual([
      { id: 'douban:1', title: '国产动画', cover: 'https://img9.doubanio.com/a.jpg', rating: '9.1' },
      { id: 'douban:2', title: '日本动画', cover: undefined, rating: undefined },
    ]);
    expect(() => parseAnimeList({ items: [] })).toThrow();
  });

});

describe('daily anime picks', () => {
  it('uses the Shanghai date and maps Sunday to seven', () => {
    expect(animeDate(new Date('2026-10-28T16:01:00Z'))).toEqual({ key: '2026-10-29', weekday: 4 });
    expect(animeDate(new Date('2026-11-01T00:00:00Z'))).toEqual({ key: '2026-11-01', weekday: 7 });
  });
  it('is stable each day, mixes regions, deduplicates and changes batches locally', () => {
    const japan = Array.from({ length: 12 }, (_, i) => ({ id: `j${i}`, title: `日漫${i}` }));
    const china = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, title: `国漫${i}` }));
    const first = dailyAnime(japan, china, '2026-10-29');
    expect(first).toEqual(dailyAnime(japan, china, '2026-10-29'));
    expect(first).toHaveLength(8);
    expect(first.filter(item => item.id.startsWith('j'))).toHaveLength(4);
    expect(dailyAnime(japan, china, '2026-10-29', 1)).not.toEqual(first);
    expect(dailyAnime(japan, china, '2026-10-30')).not.toEqual(first);
    expect(dailyAnime([japan[0]], [japan[0]], 'today')).toHaveLength(1);
    expect(dailyAnime([], [], 'today')).toEqual([]);
  });
});
