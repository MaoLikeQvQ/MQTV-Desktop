import { describe, expect, it } from 'vitest';
import { createDownloadRate, downloadRateText } from '@/domain/media/download-rate';

describe('video download speed', () => {
  it('uses elapsed time, reports stalls as zero, and resets between sessions', () => {
    const sample = createDownloadRate();
    expect(sample(1024, 0)).toBeNull();
    expect(sample(3072, 500)).toBe(4096);
    expect(sample(3072, 1500)).toBe(0);
    expect(sample(0, 2500)).toBeNull();
    expect(sample(1024, 3500)).toBe(1024);
    expect(sample(null, 4000)).toBeNull();
    expect(sample(999999, 5000)).toBeNull();
    expect(sample(999999, 5000)).toBeNull();
  });
  it('keeps unavailable distinct from a stalled download and formats units', () => {
    expect(downloadRateText(null)).toBe('网速暂不可用');
    expect(downloadRateText(0)).toBe('0.0 KB/s');
    expect(downloadRateText(1024 * 512)).toBe('512.0 KB/s');
    expect(downloadRateText(1024 ** 2 * 1.25)).toBe('1.25 MB/s');
    expect(downloadRateText(Number.NaN)).toBe('网速暂不可用');
  });
});
