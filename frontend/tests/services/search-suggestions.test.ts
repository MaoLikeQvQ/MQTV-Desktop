import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSearchSuggestions } from '@/services/search-suggestions';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => invoke.mockReset());

describe('TV search suggestion compatibility', () => {
  it('encodes user input and reads name/title candidates without duplicates', async () => {
    invoke.mockResolvedValue({ code: 'A00000', data: [{ name: '刀剑神域' }, { title: '刀剑神域第二季' }, { name: '刀剑神域' }, null, { name: '' }] });
    expect(await readSearchSuggestions(' 刀剑 & 神域 ')).toEqual(['刀剑神域', '刀剑神域第二季']);
    const [command, args] = invoke.mock.calls[0];
    const url = new URL(args.url);
    expect(command).toBe('fetch_json');
    expect(url.origin).toBe('https://suggest.video.iqiyi.com');
    expect(url.searchParams.get('key')).toBe('刀剑&神域');
    expect(url.searchParams.get('if')).toBe('mobile');
  });
  it('does not request empty input, and reports invalid or failed responses', async () => {
    expect(await readSearchSuggestions(' ')).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ code: 'error', data: [] });
    await expect(readSearchSuggestions('影片')).rejects.toThrow('联想响应无效');
  });
});
