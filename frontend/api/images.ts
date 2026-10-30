import { invokePlayback } from '@/platform/playback-request';
import { buildRequestUrl } from '@/utils/url';

/**
 * 请求图片原始字节；豆瓣封面使用专用下载命令，Bangumi 封面始终直连。
 * @param address 图片的完整 HTTP(S) 地址。
 * @param direct 是否绕过豆瓣封面代理直接请求。
 * @returns 图片字节数组，不负责本地缓存。
 * @throws 地址无效或原生下载失败时抛出错误。
 */
export async function fetchImageBytes(address: string, direct = false): Promise<number[]> {
  try {
    const url = buildRequestUrl(address), target = new URL(url), host = target.hostname;
    const cover = target.protocol === 'https:' && (host === 'doubanio.com' || host.endsWith('.doubanio.com') || host === 'lain.bgm.tv');
    return await (cover
      ? invokePlayback<number[]>('fetch_cover', { url, direct: direct || host === 'lain.bgm.tv' })
      : invokePlayback<number[]>('fetch_image', { url }));
  } catch (reason) {
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}
