import { describe, expect, it, vi } from 'vitest';
import { createFileImageStorage } from '@/services/images';

describe('native image cache migration', () => {
  it('reads native bytes without opening the old IndexedDB', async () => {
    const legacy = { read: vi.fn(), write: vi.fn() };
    const storage = createFileImageStorage(legacy, { read: vi.fn().mockResolvedValue({ bytes: [1, 2], mime: 'image/png' }), write: vi.fn() });
    const blob = await storage.read('https://images.test/1');
    expect(blob?.type).toBe('image/png');
    expect(Array.from(new Uint8Array(await blob!.arrayBuffer()))).toEqual([1, 2]);
    expect(legacy.read).not.toHaveBeenCalled();
  });
  it('lazily migrates one requested legacy image and writes new images only to native files', async () => {
    const blob = new Blob([new Uint8Array([3, 4])], { type: 'image/jpeg' });
    const legacy = { read: vi.fn().mockResolvedValue(blob), write: vi.fn() };
    const write = vi.fn().mockResolvedValue(undefined);
    const storage = createFileImageStorage(legacy, { read: vi.fn().mockResolvedValue(null), write });
    expect(await storage.read('old')).toBe(blob);
    expect(write).toHaveBeenCalledWith('old', [3, 4], 'image/jpeg');
    await storage.write('new', blob);
    expect(write).toHaveBeenCalledWith('new', [3, 4], 'image/jpeg');
    expect(legacy.read).toHaveBeenCalledTimes(1);
    expect(legacy.write).not.toHaveBeenCalled();
  });
  it('preserves failed migrations for a later retry and skips oversized entries', async () => {
    const blob = new Blob([new Uint8Array([3, 4])]);
    const legacy = { read: vi.fn().mockResolvedValue(blob), write: vi.fn() };
    const write = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined);
    const storage = createFileImageStorage(legacy, { read: vi.fn().mockResolvedValue(null), write });
    await expect(storage.read('old')).rejects.toThrow('disk');
    expect(await storage.read('old')).toBe(blob);
    const bounded = createFileImageStorage(legacy, { read: vi.fn().mockResolvedValue(null), write }, 1);
    await bounded.write('large', blob);
    expect(await bounded.read('large')).toBeNull();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
