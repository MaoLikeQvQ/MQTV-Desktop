import { buildRequestUrl } from '@/utils/url';
import { describe, expect, it } from 'vitest';
import { parseFeed, parseEpisodes, formatFileSize, compactFileSize } from '@/domain/media/media';

describe('resource feed', () => {
  it('retains searchable sources and accepts an empty feed', () => {
    expect(parseFeed({ version: 'v1', count: 0, sites: [] }).sites).toEqual([]);
    expect(parseFeed({ version: 'v2', count: 1, sites: [{ key: 'a', name: 'A', api: 'https://example.com/api', type: 1, searchable: 0 }] }).sites[0].searchable).toBe(0);
    expect(() => parseFeed({ version: 'v', count: 1, sites: null })).toThrow();
  });
});

describe('CMS requests', () => {
  it('preserves existing parameters and encodes search terms', () => {
    const url = new URL(buildRequestUrl('https://example.com/api?token=a', { wd: '测试', ac: 'videolist' }));
    expect(url.searchParams.get('token')).toBe('a');
    expect(url.searchParams.get('wd')).toBe('测试');
  });
  it('keeps line and episode names and URLs containing dollar signs', () => {
    expect(parseEpisodes('主线$$$备用', '第一集$https://example.com/a.m3u8?x=$1#第二集$https://example.com/b.mp4$$$正片$https://example.com/c.m3u8')).toEqual([
      { name: '主线', episodes: [{ name: '第一集', url: 'https://example.com/a.m3u8?x=$1' }, { name: '第二集', url: 'https://example.com/b.mp4' }] },
      { name: '备用', episodes: [{ name: '正片', url: 'https://example.com/c.m3u8' }] },
    ]);
  });
});

describe('file size display', () => {
  it('shows compact episode sizes without spaces or trailing decimal zeroes', () => {
    expect(compactFileSize(300 * 1024 ** 2)).toBe('300MB');
    expect(compactFileSize(5 * 1024 ** 3)).toBe('5GB');
    expect(compactFileSize(1.5 * 1024 ** 3)).toBe('1.5GB');
    expect(compactFileSize(0)).toBe('0B');
    expect(compactFileSize(-1)).toBe('未知');
    expect(compactFileSize(Number.NaN)).toBe('未知');
  });
  it('uses the real byte count and handles missing or invalid measurements', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1536)).toBe('1.50 KB');
    expect(formatFileSize(1.5 * 1024 ** 3)).toBe('1.50 GB');
    expect(formatFileSize(Number.NaN)).toBe('未知');
  });
});

 describe('script episode identities', () => {
  it('retains opaque IDs only when the caller explicitly selects script mode', () => {
    expect(parseEpisodes('高清', '第一集$opaque:42')).toEqual([]);
    expect(parseEpisodes('高清', '第一集$opaque:42$token#第二集$video/2', true)).toEqual([{ name: '高清', episodes: [{ name: '第一集', url: 'opaque:42$token' }, { name: '第二集', url: 'video/2' }] }]);
  });
});
