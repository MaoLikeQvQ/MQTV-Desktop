import { isQuarkShare, netdiskKind } from '@/domain/media/netdisk';
import { nativeAdapter } from '@/domain/resources/native-source';
import { searchNativeSource, readNativeDetail, resolveNativePlayback } from '@/api/adapters';
import type { Source } from '@/domain/media/media';
import type { Vod } from '@/domain/search/search';
import { scriptLanguage } from '@/domain/resources/script-source';
import { searchMedia, readMediaDetail } from '@/api/media';
import { searchScriptSource, readScriptDetail, resolveScriptPlayback } from '@/api/scripts';

/** 按来源协议搜索并校验结果，为每条影片附上原始来源配置。 */
export async function searchSourceMedia(source: Source, keyword: string): Promise<Vod[]> {
  const response = nativeAdapter(source) ? await searchNativeSource(source, keyword.trim()) : scriptLanguage(source) ? await searchScriptSource(source, keyword.trim()) : await searchMedia(source.api, keyword);
  if (response.list != null && !Array.isArray(response.list)) throw new Error('搜索响应格式无效');
  return (Array.isArray(response.list) ? response.list : []).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
    .filter(value => (typeof value.vod_id === 'string' || typeof value.vod_id === 'number') && typeof value.vod_name === 'string')
    .map(value => ({ ...value, source } as Vod));
}
/** 按来源协议请求详情，插件影片 ID 不作为 HTTP 地址解释。 */
export const readSourceDetail = (source: Source, id: string) => nativeAdapter(source) ? readNativeDetail(source, id) : scriptLanguage(source) ? readScriptDetail(source, id) : readMediaDetail(source.api, id);
/** 解析插件选集并校验媒体地址；拒绝将网盘分享页当作视频地址播放。 */
export async function resolveSourcePlayback(source: Source, flag: string, id: string, flags: string[]): Promise<string> {
  const value = nativeAdapter(source) ? (await resolveNativePlayback(source, id)).url : scriptLanguage(source) ? (await resolveScriptPlayback(source, flag, id, flags)).url : id;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('插件未返回有效的媒体地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('插件返回了不支持的播放协议');
  if (isQuarkShare(value)) return value;
  if (netdiskKind(value)) throw new Error('该选集返回不支持的网盘分享页，目前仅支持夸克网盘');
  return value;
}
