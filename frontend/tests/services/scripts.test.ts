import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scriptLanguage, scriptSourceIdentity, canSearchScriptSource } from '@/domain/resources/script-source';
import { searchSourceMedia, readSourceDetail, resolveSourcePlayback } from '@/services/scripts';
import { inspectScriptSource, trustScriptSource, readScriptStatus } from '@/api/scripts';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const source = { key: 'js', name: 'JS', type: 3, api: 'https://example.test/drpy2.js', searchable: 1, ext: 'https://example.test/rule.js' };
beforeEach(() => invoke.mockReset());
describe('script source protocol', () => {
  it('requires a type 3 HTTP script and rejects credentials or Android entrypoints', () => {
    expect(scriptLanguage(source)).toBe('javascript');
    expect(scriptLanguage({ ...source, api: 'https://example.test/a.PY?version=2' })).toBe('python');
    expect(scriptLanguage({ ...source, type: 1 })).toBeNull();
    expect(scriptLanguage({ ...source, api: 'csp_Python' })).toBeNull();
    expect(scriptLanguage({ ...source, api: 'https://user:pass@example.test/a.js' })).toBeNull();
    expect(scriptSourceIdentity(source)).not.toBe(scriptSourceIdentity({ ...source, ext: 'changed' }));
  });
  it('counts only enabled script sources with ready state for the same configuration', () => {
    const status = { [scriptSourceIdentity(source)]: { ready: true } };
    expect(canSearchScriptSource(source, {})).toBe(false);
    expect(canSearchScriptSource(source, status)).toBe(true);
    expect(canSearchScriptSource({ ...source, searchable: 0 }, status)).toBe(false);
    expect(canSearchScriptSource({ ...source, enabled: false }, status)).toBe(false);
    expect(canSearchScriptSource({ ...source, ext: 'changed' }, status)).toBe(false);
  });
  it('keeps inspection separate from explicit trust', async () => {
    invoke.mockResolvedValue({ digest: 'abc', files: 2, language: 'javascript' });
    await inspectScriptSource(source);
    expect(invoke.mock.calls).toEqual([['script_inspect', { source }]]);
    await trustScriptSource(source, 'abc');
    expect(invoke).toHaveBeenLastCalledWith('script_trust', { source, digest: 'abc' });
    await readScriptStatus([source]);
    expect(invoke).toHaveBeenLastCalledWith('script_status', { sources: [source] });
  });
  it('searches and reads opaque IDs via native commands while filtering malformed films', async () => {
    invoke.mockResolvedValue({ list: [{ vod_id: 'opaque:42', vod_name: '动画' }, { vod_id: {}, vod_name: 'bad' }, null] });
    expect(await searchSourceMedia(source, ' 动画 ')).toEqual([{ vod_id: 'opaque:42', vod_name: '动画', source }]);
    expect(invoke).toHaveBeenLastCalledWith('script_search', { source, keyword: '动画' });
    await readSourceDetail(source, 'opaque:42');
    expect(invoke).toHaveBeenLastCalledWith('script_detail', { source, id: 'opaque:42' });
  });
  it('retains CMS transport and rejects malformed search response', async () => {
    invoke.mockResolvedValue({ list: [] });
    await searchSourceMedia({ ...source, type: 1, api: 'https://example.test/api' }, '动画');
    expect(invoke.mock.calls[0][0]).toBe('fetch_json');
    invoke.mockResolvedValue({ list: 'bad' });
    await expect(searchSourceMedia(source, '动画')).rejects.toThrow('搜索响应格式无效');
  });
  it('resolves the original flag and ID at playback time and rejects share pages', async () => {
    invoke.mockResolvedValue({ url: 'http://127.0.0.1:1234/token/stream.m3u8' });
    expect(await resolveSourcePlayback(source, '高清', 'opaque$42', ['高清'])).toContain('/token/');
    expect(invoke).toHaveBeenLastCalledWith('script_play', { source, flag: '高清', id: 'opaque$42', flags: ['高清'] });
    invoke.mockResolvedValue({ url: 'https://pan.quark.cn/s/test' });
    expect(await resolveSourcePlayback(source, '夸克', 'id', [])).toBe('https://pan.quark.cn/s/test');
    invoke.mockResolvedValue({ url: 'https://pan.baidu.com/s/test' });
    await expect(resolveSourcePlayback(source, '百度', 'id', [])).rejects.toThrow('网盘分享页');
    invoke.mockResolvedValue({ url: 'javascript:alert(1)' });
    await expect(resolveSourcePlayback(source, '', 'id', [])).rejects.toThrow('播放协议');
  });
});
