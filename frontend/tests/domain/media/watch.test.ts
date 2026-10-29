import { describe, it, expect } from 'vitest';
import { initialWatchSource, orderWatchSources, synopsisText, withPlaybackPoster } from '@/domain/media/watch';
import { historyIdentity, type PlaybackRecord } from '@/domain/history/history';
const cms = { vod_id: '1', vod_name: '电影', source: { key: 'cms', name: '普通', api: 'https://example.com/api', type: 1, searchable: 1 } };
const cloud = { ...cms, source: { ...cms.source, key: 'cloud', api: 'csp_Wogg', type: 3, ext: { site: ['https://www.wogg.net'] } } };
describe('watch entry selection', () => {
  it('prioritizes netdisk sources without changing order inside a category', () => {
    const second = { ...cloud, vod_id: '2' };
    expect(orderWatchSources([cms, cloud, second])).toEqual([cloud, second, cms]);
    expect(initialWatchSource([cms, cloud], [], 'feed')).toEqual({ vod: cloud, resume: undefined });
  });
  it('resumes the latest matching history without crossing resource environments', () => {
    const record: PlaybackRecord = { id: historyIdentity('feed', cms), resource: 'feed', vod: cms, group: { key: '电影', items: [cms, cloud] }, target: { line: '高清', episode: '第三集', episodeIndex: 2, episodeCount: 3, url: 'https://example.com/3.mp4' }, position: 12, duration: 100, speed: 1, updatedAt: 20 };
    expect(initialWatchSource([cms, cloud], [record], 'feed')).toEqual({ vod: cms, resume: record });
    expect(initialWatchSource([cms, cloud], [record], 'other')?.vod).toBe(cloud);
    expect(initialWatchSource([], [], 'feed')).toBeNull();
  });
  it('fills a missing poster from the same title without changing playback identity', () => {
    const illustrated = { ...cms, vod_pic: 'https://example.com/cover.jpg' };
    expect(withPlaybackPoster(cloud, [illustrated])).toEqual({ ...cloud, vod_pic: illustrated.vod_pic });
    expect(withPlaybackPoster({ ...cloud, vod_pic: ' ' }, [illustrated]).vod_pic).toBe(illustrated.vod_pic);
    expect(withPlaybackPoster(cloud, [{ ...illustrated, vod_name: '电影 第二季' }])).toBe(cloud);
    const own = { ...cloud, vod_pic: 'https://example.com/own.jpg' };
    expect(withPlaybackPoster(own, [illustrated])).toEqual(own);
  });
  it('renders synopsis as plain text', () => {
    expect(synopsisText('<p>故事&nbsp;简介</p>')).toBe('故事 简介');
    expect(synopsisText(null)).toBe('');
  });
});
