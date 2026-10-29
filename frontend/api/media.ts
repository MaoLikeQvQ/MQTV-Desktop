import { requestJson } from '@/utils/request';

/**
 * 请求 CMS 搜索列表，保留来源地址已有参数并编码关键词。
 * @param sourceUrl CMS 接口完整地址。
 * @param keyword 搜索关键词，请求前移除首尾空白。
 */
export const searchMedia = (sourceUrl: string, keyword: string) =>
  requestJson<{ list?: unknown }>(sourceUrl, { params: { ac: 'videolist', wd: keyword.trim(), pg: '1' } });
/** 按影片 ID 请求 CMS 详情，保留来源地址上的既有参数。 */
export const readMediaDetail = (sourceUrl: string, id: string) =>
  requestJson<{ list?: Record<string, unknown>[] }>(sourceUrl, { params: { ac: 'videolist', ids: id } });
