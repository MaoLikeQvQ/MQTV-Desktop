import type { DiscoveryItem } from '@/domain/discovery/discovery-cache';
import type { Channel } from '@/router';
import { parseDoubanList, parseWeeklyCover } from '@/domain/discovery/douban';
import { animeSources as requests, discoveryContent as discoveryRequest, weeklyCoverCandidates, animeList } from '@/api/discovery';
import { parseAnimeList } from '@/domain/discovery/anime';

/** 将各动漫接口的原始响应转换为统一展示条目，保留原请求地址作为缓存键。 */
export const animeSources = {
  japan: {
    key: requests.japan.key,
    /** 请求日本动漫列表，并校验、规范化影片条目。 */
    load: async () => parseAnimeList(await requests.japan.load()),
  },
  china: {
    key: requests.china.key,
    /** 请求中国动漫列表，并校验、规范化影片条目。 */
    load: async () => parseAnimeList(await requests.china.load()),
  },

};

/** 按展示顺序发起并发请求，每份地区结果独立发布；全部成功后才写入缓存。 */
export function discoveryContent(channel: Channel, filter: string, page = 0) {
  const request = discoveryRequest(channel, filter, page);
  return {
    key: request.requests.length > 1 ? 'paged-v1:' + request.key : request.key,
    /** 并发加载各地区，先返回的结果立即展示；失败保留已展示数据并在全部结束后报告。 */
    async load(onProgress?: (data: { items: DiscoveryItem[] }) => void) {
      const lists: DiscoveryItem[][] = request.requests.map(() => []);
      const errors: string[] = [];
      let result: { items: DiscoveryItem[] } = { items: [] };
      await Promise.all(request.requests.map(async (source, index) => {
        try { lists[index] = parseDoubanList(await source.load()).items; }
        catch (reason) { errors.push(reason instanceof Error ? reason.message : String(reason)); return; }
        const seen = new Set<string>();
        const items = Array.from({ length: Math.max(0, ...lists.map(list => list.length)) }, (_, index) => lists.map(list => list[index]))
          .flat().filter(item => {
            if (!item || seen.has(item.id)) return false;
            seen.add(item.id); return true;
          });
        result = { items };
        onProgress?.(result);
      }));
      if (!errors.length && channel === 'recommended' && filter === 'douban_movie_weekly') {
        await Promise.all(result.items.map(async (item, index) => {
          try {
            const cover = parseWeeklyCover(await weeklyCoverCandidates(item.title), item.id);
            result = { items: result.items.map((current, position) => position === index ? { ...current, cover } : current) };
            onProgress?.(result);
          } catch (reason) { errors.push(reason instanceof Error ? reason.message : String(reason)); }
        }));
      }
      if (errors.length) throw new Error('部分分类加载失败：' + errors.join('；'));
      return result;
    },
  };
}

/** 加载指定地区动漫的一页，按豆瓣实际分页步长构造请求并规范化响应。 */
export async function animeContent(region: 'japan' | 'china', page: number) {
  return parseAnimeList(await animeList(region, page).load());
}
