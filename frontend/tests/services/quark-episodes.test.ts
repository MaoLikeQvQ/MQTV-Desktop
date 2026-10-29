import { beforeEach, expect, it, vi } from 'vitest';
import { scanQuarkEpisodes } from '@/services/quark-episodes';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });

it('emits the first episode before a later directory completes, retaining traversal paths', async () => {
  let finish!: (value: unknown) => void;
  invoke.mockResolvedValueOnce({ files: [{ id: 'a', name: '01.mp4', video: true }, { id: 'dir', name: '第二季', folder: true }], pageSize: 100 })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const found: { id: string; path?: string }[] = [];
  const pending = scanQuarkEpisodes('https://pan.quark.cn/s/abc?pwd=1234', new AbortController().signal, item => found.push(item));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(found.map(item => item.id)).toEqual(['a']);
  finish({ files: [{ id: 'b', name: '02.mkv' }], pageSize: 100 });
  await pending;
  expect(found[1]).toMatchObject({ id: 'b', path: '第二季 / 02.mkv' });
  expect(invoke.mock.calls[1]).toEqual(['quark_files', { share: 'https://pan.quark.cn/s/abc?pwd=1234', passcode: '1234', parent: 'dir', page: 1 }]);
});

it('stops requesting and emitting after cancellation', async () => {
  const controller = new AbortController();
  invoke.mockImplementation(async () => { controller.abort(); return { files: [{ id: 'a', name: 'a.mp4' }], pageSize: 100 }; });
  const found = vi.fn();
  await scanQuarkEpisodes('https://pan.quark.cn/s/abc', controller.signal, found);
  expect(found).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('preserves emitted episodes and reports a subsequent directory failure', async () => {
  invoke.mockResolvedValueOnce({ files: [{ id: 'a', name: 'a.mp4' }, { id: 'dir', name: 'extra', folder: true }], pageSize: 100 })
    .mockRejectedValueOnce(new Error('目录请求失败'));
  const found = vi.fn();
  await expect(scanQuarkEpisodes('https://pan.quark.cn/s/abc', new AbortController().signal, found)).rejects.toThrow('目录请求失败');
  expect(found).toHaveBeenCalledTimes(1);
});

it('continues pagination and ignores duplicate files', async () => {
  invoke.mockResolvedValueOnce({ files: Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `${i}.mp4` })), total: 101, pageSize: 100 })
    .mockResolvedValueOnce({ files: [{ id: '0', name: '0.mp4' }, { id: '100', name: '100.mp4' }], total: 101, pageSize: 100 });
  const found = vi.fn();
  await scanQuarkEpisodes('https://pan.quark.cn/s/abc', new AbortController().signal, found);
  expect(found).toHaveBeenCalledTimes(101);
  expect(invoke.mock.calls[1][1].page).toBe(2);
});
