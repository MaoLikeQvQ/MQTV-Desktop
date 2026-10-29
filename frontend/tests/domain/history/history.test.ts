import { describe, expect, it } from 'vitest';
import { findHistoryEpisode, samePlaybackTarget, HISTORY_KEY, HISTORY_LIMIT, historyIdentity, playbackTime, readHistory, saveHistory, upsertHistory, historyVod, type PlaybackRecord } from '@/domain/history/history';

const vod = { vod_id: '42', vod_name: '测试剧集', source: { key: 'a', name: '来源 A', api: 'https://example.com/api', type: 1, searchable: 1 } };
const record: PlaybackRecord = {
  id: historyIdentity('feed-a', vod), resource: 'feed-a', vod, group: { key: '测试剧集', items: [vod] },
  target: { line: '高清', episode: '第 3 集', episodeIndex: 2, episodeCount: 12, url: 'https://example.com/3.mp4' },
  position: 123.5, duration: 1800, speed: 1.5, updatedAt: 1000,
};
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
describe('recent playback persistence and resumption', () => {
  it('restores native adapter opaque episode identity', () => {
    const store = storage();
    const native = { ...record, vod: { ...vod, source: { ...vod.source, type: 3, api: 'csp_Anime1' } }, target: { line: 'Anime1', episode: '第一集', episodeIndex: 0, episodeCount: 1, script: { id: 'opaque-native', flag: 'Anime1' } } };
    saveHistory(store, [native]);
    expect(readHistory(store)).toEqual([native]);
    expect(findHistoryEpisode([{ name: 'Anime1', episodes: [{ name: '第一集', url: 'opaque-native' }] }], native.target)?.episode.url).toBe('opaque-native');
  });
  it('restores source, line, episode, position, duration and speed after a fresh read', () => {
    const store = storage();
    saveHistory(store, [record]);
    expect(readHistory(store)).toEqual([record]);
  });
  it('updates a film once and moves it to the front without keeping the old episode', () => {
    const other = { ...record, id: 'other' };
    const next = { ...record, position: 200, target: { ...record.target, episode: '第 4 集', episodeIndex: 3 }, updatedAt: 2000 };
    expect(upsertHistory([other, record], next)).toEqual([next, other]);
    expect(historyIdentity('feed-b', vod)).not.toBe(record.id);
    expect(historyIdentity('feed-a', { ...vod, source: { ...vod.source, resourceUrl: 'https://other.com/feed' } })).not.toBe(record.id);
  });
  it('preserves an existing poster when a progress update has no poster', () => {
    const illustrated = { ...record, vod: { ...vod, vod_pic: 'https://example.com/cover.jpg' } };
    const next = { ...record, position: 300 };
    expect(upsertHistory([illustrated], next)[0]).toEqual({ ...next, vod: illustrated.vod });
    const refreshed = { ...next, vod: { ...vod, vod_pic: 'https://example.com/new.jpg' } };
    expect(upsertHistory([illustrated], refreshed)[0]).toEqual(refreshed);
  });
  it('persists grouped sources with their display and playback identity', () => {
    const store = storage();
    const other = { ...vod, vod_id: 'other', vod_pic: 'https://example.com/poster.jpg', source: { ...vod.source, key: 'b' } };
    const grouped = { ...record, group: { key: '测试剧集', items: [vod, other] } };
    saveHistory(store, [grouped]);
    expect(readHistory(store)[0].group).toEqual(grouped.group);
    expect(upsertHistory([grouped], { ...grouped, position: 400 })[0].group).toEqual(grouped.group);
    expect(historyVod({ ...other, vod_content: '简介', vod_play_url: 'https://example.com/temporary.mp4' })).toMatchObject({ vod_content: '简介', vod_pic: other.vod_pic, source: other.source });
    expect(historyVod({ ...other, vod_play_url: 'https://example.com/temporary.mp4' }).vod_play_url).toBeUndefined();
  });
  it('rejects records without valid grouped source information', () => {
    const store = storage();
    store.setItem(HISTORY_KEY, JSON.stringify([{ ...record, group: { key: 'test', items: [null, {}] } }]));
    expect(readHistory(store)).toEqual([]);
    store.setItem(HISTORY_KEY, JSON.stringify([{ ...record, group: undefined }]));
    expect(readHistory(store)).toEqual([]);
  });
  it('bounds records and sorts latest first when reading', () => {
    const store = storage();
    const records = Array.from({ length: HISTORY_LIMIT + 2 }, (_, i) => ({ ...record, id: String(i), updatedAt: i }));
    store.setItem(HISTORY_KEY, JSON.stringify(records));
    expect(readHistory(store)).toHaveLength(HISTORY_LIMIT);
    expect(readHistory(store)[0].updatedAt).toBe(HISTORY_LIMIT + 1);
    expect(upsertHistory(records.slice(0, HISTORY_LIMIT), record)).toHaveLength(HISTORY_LIMIT);
  });
  it('matches the original line and episode after ordering and signed URLs change', () => {
    const episode = { name: '第 3 集', url: 'https://example.com/new-token.mp4' };
    const lines = [{ name: '其他', episodes: [episode] }, { name: '高清', episodes: [episode] }];
    expect(findHistoryEpisode(lines, record.target)).toEqual({ lineIndex: 1, episode });
    expect(findHistoryEpisode(lines.slice(0, 1), record.target)).toBeNull();
    expect(findHistoryEpisode([{ name: '高清', episodes: [] }], record.target)).toBeNull();
  });
  it('persists stable Quark file identity without a temporary media URL', () => {
    const store = storage();
    const cloud = { ...record, target: { line: '线路 2', episode: '第三集', episodeIndex: 2, episodeCount: 3,
      quark: { share: 'https://pan.quark.cn/s/example', file: { id: 'file-3', name: '第三集', parent: 'folder', page: 1 } } } };
    saveHistory(store, [cloud]);
    expect(readHistory(store)).toEqual([cloud]);
    expect(store.getItem(HISTORY_KEY)).not.toContain('127.0.0.1');
  });
  it('does not hide corrupt storage or storage write failures', () => {
    const store = storage();
    store.setItem(HISTORY_KEY, '{');
    expect(() => readHistory(store)).toThrow();
    expect(store.getItem(HISTORY_KEY)).toBe('{');
    expect(() => saveHistory({ setItem: () => { throw new Error('QuotaExceededError'); } }, [record])).toThrow('QuotaExceededError');
    store.setItem(HISTORY_KEY, JSON.stringify([null, {}, { ...record, position: -1 }, record]));
    expect(readHistory(store)).toEqual([record]);
  });
  it('formats progress in seconds, including hours', () => {
    expect(playbackTime(123.5)).toBe('02:03');
    expect(playbackTime(3723)).toBe('1:02:03');
  });
});

describe('script playback history', () => {
  it('stores original plugin identity and reselects it without persisting resolved URLs', () => {
    const store = storage();
    const script = { ...record, vod: { ...vod, source: { ...vod.source, type: 3, api: 'https://example.com/a.py', ext: { host: 'https://example.com' } } }, target: { ...record.target, url: undefined, script: { flag: '高清', id: 'opaque:42' } } };
    saveHistory(store, [script]);
    expect(readHistory(store)).toEqual([script]);
    const episode = { name: '新名称', url: 'opaque:42' };
    expect(findHistoryEpisode([{ name: '高清', episodes: [episode] }], script.target)).toEqual({ lineIndex: 0, episode });
    expect(store.getItem(HISTORY_KEY)).not.toContain('127.0.0.1');
  });
});

describe('stable progress restoration identity', () => {
  it('does not restore script progress to another episode with the same display name', () => {
    const original = { ...record.target, script: { flag: '高清', id: 'video:1' } };
    expect(samePlaybackTarget(original, original)).toBe(true);
    expect(samePlaybackTarget({ ...original, script: { flag: '高清', id: 'video:2' } }, original)).toBe(false);
    expect(samePlaybackTarget(record.target, original)).toBe(false);
    expect(samePlaybackTarget({ ...record.target, url: 'https://example.com/refreshed' }, record.target)).toBe(true);
  });
});
