import { describe, expect, it } from 'vitest';
import { deviceSearchConcurrency, canScoreSource, groupResults, observe, priority, readScores, saveScores, scoreIdentity, scoreValue, searchRelevance, searchSources, titleRelevance, type SourceScore, type Vod } from '@/domain/search/search';
import { DEFAULT_RESOURCE_URL } from '@/domain/resources/resource-cache';
import type { Source } from '@/domain/media/media';

const source = (key: string): Source => ({ key, name: key, api: 'https://example.com/' + key, type: 1, searchable: 1 });
const vod = (name: string, key = 'a', id = '1'): Vod => ({ vod_name: name, vod_id: id, source: source(key) });

describe('TV title grouping', () => {
  it('normalizes width, case, unicode spaces and closing waves while retaining distinct entries', () => {
    const groups = groupResults([vod('ＡＢＣ　第一季～'), vod(' abc 第一季 ', 'b'), vod('ABC 第一季', 'b'), vod('abc 第一季', 'a', '2')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map(item => [item.source.key, item.vod_id])).toEqual([['a', '1'], ['b', '1'], ['a', '2']]);
  });
  it('retains season, edition and language distinctions, and source-local ids', () => {
    expect(groupResults([vod('剧 第一季'), vod('剧 第二季'), vod('剧 电影版'), vod('剧 国语')])).toHaveLength(4);
    expect(groupResults([vod('', 'a'), vod('', 'b')])).toHaveLength(2);
    expect(groupResults([vod('同名', 'a'), vod('同名', 'b')])[0].items).toHaveLength(2);
  });
});

describe('TV relevance v1', () => {
  it('orders exact, contains, reordered words, scattered characters and unrelated matches', () => {
    const scores = [titleRelevance('流浪地球', '流浪地球'), titleRelevance('流浪地球', '流浪地球2'), titleRelevance('地球 流浪', '流浪地球'), titleRelevance('流浪地球', '流星浪花地心球赛'), titleRelevance('流浪地球', '爱情公寓')] as number[];
    expect(scores[0]).toBe(1);
    for (let i = 0; i < scores.length - 1; i++) expect(scores[i]).toBeGreaterThan(scores[i + 1]);
    expect(titleRelevance('ＡＢＣ：第一季', 'abc 第一季')).toBe(1);
    expect(titleRelevance('哈哈哈哈', '哈')).toBeLessThanOrEqual(0.1);
    expect(titleRelevance('地', '流浪地球')).toBe(0.35);
  });
  it('keeps unknowns separate and weights original result ranks', () => {
    expect(titleRelevance('---', '电影')).toBeNull();
    expect(searchRelevance('电影', [])).toBeNull();
    expect(searchRelevance('电影', [''])).toBeNull();
    expect(searchRelevance('电影', ['爱情公寓'])).toBe(0);
    expect(searchRelevance('电影', ['电影', '爱情公寓'])!).toBeGreaterThan(searchRelevance('电影', ['爱情公寓', '电影'])!);
  });
});

describe('local source quality', () => {
  it('scores only sources supplied by the default resource service', () => {
    expect(canScoreSource('default', DEFAULT_RESOURCE_URL, source('a'))).toBe(true);
    expect(canScoreSource('custom', DEFAULT_RESOURCE_URL, source('a'))).toBe(false);
    expect(canScoreSource('default', 'https://third-party.example/api/resources', source('a'))).toBe(false);
    expect(canScoreSource('default', DEFAULT_RESOURCE_URL, { ...source('a'), resourceUrl: DEFAULT_RESOURCE_URL })).toBe(false);
  });
  it('applies 60/30/10 and excludes unknown relevance', () => {
    expect(scoreValue(observe(undefined, 3000, true, 0.5))).toBe(80);
    expect(scoreValue(observe(undefined, 3000, true, null))).toBeCloseTo(65 / 70 * 100);
    expect(scoreValue(observe(undefined, 3000, false, null))).toBeCloseTo(5 / 70 * 100);
    expect(scoreValue()).toBeNull();
    const measured = observe(undefined, 100, true, 1);
    expect(priority(measured)).toBe(scoreValue(measured));
    expect(priority()).toBeLessThan(priority(measured));
  });
  it('lets reliable relevant sources outrank quick unrelated or failed ones', () => {
    let slow: SourceScore | undefined, unrelated: SourceScore | undefined, failed: SourceScore | undefined;
    for (let i = 0; i < 20; i++) {
      slow = observe(slow, 12000, true, 1);
      unrelated = observe(unrelated, 100, true, 0);
      failed = observe(failed, 100, false, null);
    }
    expect(priority(slow)).toBeGreaterThan(priority(unrelated));
    expect(priority(unrelated)).toBeGreaterThan(priority(failed));
  });
  it('scopes persisted scores to resource configuration and retains numeric evidence only', async () => {
    const id = await scoreIdentity('backend-a', source('a'));
    expect(id).not.toBe(await scoreIdentity('backend-b', source('a')));
    expect(id).not.toBe(await scoreIdentity('backend-a', { ...source('a'), ext: { site: 'new' } }));
    let data = '';
    saveScores({ setItem: (_, value) => { data = value; } }, { [id]: observe(undefined, 100, true, 1) });
    expect(readScores({ getItem: () => data })[id].samples).toBe(1);
    expect(data).not.toContain('example.com');
    expect(readScores({ getItem: () => '{broken' })).toEqual({});
    expect(readScores({ getItem: () => JSON.stringify({ [id]: { samples: 1, successes: 2 } }) })).toEqual({});
  });
  it('starts sources by displayed rating even when sample counts differ', async () => {
    const ratings: Record<string, SourceScore | undefined> = {
      high: observe(undefined, 100, true, 1),
      established: { samples: 100, successes: 100, elapsedTotalMs: 300000, relevanceTotal: 50, relevanceSamples: 100 },
      low: observe(undefined, 100, false, null),
    };
    const sources = ['unseen', 'low', 'established', 'high'].map(source);
    sources.sort((a, b) => priority(ratings[b.key]) - priority(ratings[a.key]));
    const starts: string[] = [];
    await searchSources(sources, async item => { starts.push(item.key); }, 2);
    expect(starts).toEqual(['high', 'established', 'low', 'unseen']);
  });
  it('publishes fast results and failures while a slower source is still pending', async () => {
    let releaseSlow!: (value: string) => void;
    const slow = new Promise<string>(resolve => { releaseSlow = resolve; });
    const updates: (PromiseSettledResult<string> | undefined)[][] = [];
    const arrived: string[] = [];
    const pending = searchSources(['slow', 'fast', 'failed'].map(source), async item => {
      if (item.key === 'slow') return slow;
      if (item.key === 'failed') throw new Error('unavailable');
      return item.key;
    }, 2, (snapshot, completed) => {
      updates.push([...snapshot]);
      if (completed.status === 'fulfilled') arrived.push(completed.value);
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(updates).toHaveLength(2);
    expect(updates[0][0]).toBeUndefined();
    expect(updates[0][1]).toEqual({ status: 'fulfilled', value: 'fast' });
    expect(updates[0][2]).toBeUndefined();
    expect(updates[1].filter(Boolean)).toHaveLength(2);
    expect(updates[1][2]?.status).toBe('rejected');
    expect(arrived).toEqual(['fast']);
    releaseSlow('slow');
    const results = await pending;
    expect(updates).toHaveLength(3);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(updates[2][0]).toEqual({ status: 'fulfilled', value: 'slow' });
    expect(arrived).toEqual(['fast', 'slow']);
  });
  it('bounds concurrency and retains results after another source fails', async () => {
    let active = 0, maximum = 0;
    const starts: string[] = [];
    const results = await searchSources(['a', 'b', 'c', 'd', 'e'].map(source), async item => {
      starts.push(item.key); active++; maximum = Math.max(active, maximum);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      if (item.key === 'b') throw new Error('failed');
      return item.key;
    }, 2);
    expect(maximum).toBe(2);
    expect(starts).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(results.map(item => item.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  });
});

describe('device search concurrency', () => {
  it('reserves processor capacity and caps response buffering', () => {
    expect([1, 2, 4, 8, 12, 32].map(deviceSearchConcurrency)).toEqual([1, 1, 3, 6, 9, 16]);
    expect(deviceSearchConcurrency(NaN)).toBe(2);
    expect(deviceSearchConcurrency(0)).toBe(2);
  });
  it('still dispatches all sources when given an invalid worker count', async () => {
    const results = await searchSources(['a', 'b'].map(source), async item => item.key, 0);
    expect(results).toEqual([{ status: 'fulfilled', value: 'a' }, { status: 'fulfilled', value: 'b' }]);
  });
});
