/** 对累计下载字节按实际采样间隔测速；未知、计数重置或首次采样时返回 null。 */
export function createDownloadRate() {
  let previous: { bytes: number; time: number } | undefined;
  return (bytes: number | null, time: number): number | null => {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(time)) { previous = undefined; return null; }
    const last = previous;
    previous = { bytes, time };
    return last && time > last.time && bytes >= last.bytes ? (bytes - last.bytes) * 1000 / (time - last.time) : null;
  };
}
/** 以每秒字节显示实际视频下载速度，无法测量时保留未知状态。 */
export function downloadRateText(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return '网速暂不可用';
  return bytesPerSecond >= 1024 * 1024 ? `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s` : `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
}
