import { invokePlayback } from '@/platform/playback-request';

/** 解析普通选集网页中的静态媒体地址，再通过原生回环通道加载；不携带网盘凭证。 */
export function prepareMediaPlayback(url: string): Promise<string> {
  return invokePlayback<string>('media_play', { url });
}

/** 读取当前普通媒体或网盘代理的实收字节；会话不匹配时返回未知，不将未知当作零。 */
export function readMediaDownloadedBytes(url: string): Promise<number | null> {
  return invokePlayback<number | null>('media_downloaded_bytes', { url });
}
