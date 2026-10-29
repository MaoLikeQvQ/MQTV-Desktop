import { describe, expect, it, vi } from 'vitest';
import { nativeAdapter, nativeSourceConfig, nativeSourceReady } from '@/domain/resources/native-source';
import { searchSourceMedia, readSourceDetail, resolveSourcePlayback } from '@/services/scripts';
import { authorizeNativeAdapter } from '@/api/adapters';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const source = { key: 'anime', name: '动漫', type: 3, api: 'csp_Anime1', searchable: 1 };
describe('native adapters', () => {
  it('dispatches opaque IDs through native search detail and playback', async () => {
    invoke.mockResolvedValue({ list: [{ vod_id: '12', vod_name: '动画' }] });
    expect(await searchSourceMedia(source, '动画')).toHaveLength(1);
    expect(invoke).toHaveBeenLastCalledWith('adapter_search', { source: nativeSourceConfig(source), keyword: '动画' });
    await readSourceDetail(source, '12');
    expect(invoke).toHaveBeenLastCalledWith('adapter_detail', { source: nativeSourceConfig(source), id: '12' });
    invoke.mockResolvedValue({ url: 'http://127.0.0.1:12345/media' });
    expect(await resolveSourcePlayback(source, 'Anime1', 'opaque', [])).toContain('127.0.0.1');
    expect(invoke).toHaveBeenLastCalledWith('adapter_play', { source: nativeSourceConfig(source), id: 'opaque' });
    await authorizeNativeAdapter(source, { cookie: 'test-only' });
    expect(invoke).toHaveBeenLastCalledWith('adapter_authorize', { source: nativeSourceConfig(source), authorization: { cookie: 'test-only' } });
  });
  it('rejects Guard variants and incomplete AppGet configurations', () => {
    expect(nativeAdapter({ ...source, api: 'csp_Anime1Guard' })).toBeNull();
    expect(nativeSourceReady({ ...source, enabled: false })).toBe(false);
    expect(nativeSourceReady({ ...source, api: 'csp_AppGet' })).toBe(false);
    expect(nativeSourceReady({ ...source, api: 'csp_AppGet', ext: { url: 'https://app.test', dataKey: '0123456789abcdef', dataIv: 'fedcba9876543210' } })).toBe(true);
    expect(nativeSourceConfig({ ...source, ext: { token: 'do-not-persist', cookie: 'do-not-persist', url: 'https://app.test' } }).ext).toEqual({ url: 'https://app.test' });
  });
});
