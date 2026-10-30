import { requestJson } from '@/utils/request';

/** 沿用 TV 的爱奇艺输入联想接口，通过原生 JSON 传输编码关键词并请求候选。 */
export function fetchSearchSuggestions(keyword: string): Promise<unknown> {
  return requestJson('https://suggest.video.iqiyi.com/', { params: { if: 'mobile', key: keyword } });
}
