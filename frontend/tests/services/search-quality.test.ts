import { beforeEach, describe, it, expect, vi } from 'vitest';
import { makeSearchQuality, submitSearchQuality } from '@/services/search-quality';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });
describe('anonymous search quality', () => {
  it('reports failure with zero results and never includes query or titles', () => {
    const event = makeSearchQuality('source-id', 15.4, false, '私有搜索词', ['私有片名']);
    expect(event).toMatchObject({ resourceId: 'source-id', kind: 'search', success: false, durationMs: 15, resultCount: 0, matchedCount: 0, relevanceVersion: 1 });
    expect(event.relevanceScore).toBeUndefined();
    expect(JSON.stringify(event)).not.toMatch(/私有/);
  });
  it('keeps empty-success relevance unknown and includes known relevance', () => {
    expect(makeSearchQuality('a', 2, true, '电影', []).relevanceScore).toBeUndefined();
    expect(makeSearchQuality('a', 2, true, '电影', ['电影'])).toMatchObject({ resultCount: 1, matchedCount: 1, relevanceScore: 1 });
  });
  it('sends bounded batches and propagates rejection without retrying', async () => {
    invoke.mockResolvedValue(undefined);
    await submitSearchQuality(Array.from({length: 23}, () => makeSearchQuality('a', 1, false, '', [])));
    expect(invoke.mock.calls.map(call => call[1].events.length)).toEqual([20,3]);
    invoke.mockReset();
    invoke.mockImplementation(async () => { throw new Error('offline'); });
    let failure = '';
    try { await submitSearchQuality([makeSearchQuality('a',1,false,'',[])]); } catch (reason) { failure = String(reason); }
    expect(failure).toBe('Error: offline');
    expect(invoke.mock.calls.length).toBe(1);
  });
});
