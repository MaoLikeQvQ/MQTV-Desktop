import { parseDoubanList } from '@/domain/discovery/douban';
import type { DiscoveryItem } from '@/domain/discovery/discovery-cache';

/** 规范化豆瓣动漫列表，复用发现页通用字段校验。 */
export function parseAnimeList(value: unknown): { items: DiscoveryItem[] } {
  return parseDoubanList(value);
}
/** 按北京时间生成日期键和星期编号，星期一为 1、星期日为 7。 */
export function animeDate(now = new Date()): { key: string; weekday: number } {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return { key, weekday: new Date(key + 'T12:00:00+08:00').getUTCDay() || 7 };
}
/**
 * 按日期稳定选取每日推荐，交替混合两地区、去重，并支持本地换一批。
 * @param japan 日本动漫候选条目。
 * @param china 中国动漫候选条目。
 * @param date 当天日期键。
 * @param batch 换一批的批次序号；计算过程不发起网络请求。
 */
export function dailyAnime(japan: DiscoveryItem[], china: DiscoveryItem[], date: string, batch = 0): DiscoveryItem[] {
  // Alternate the two lists so daily picks include both regions when available.
  const seen = new Set<string>();
  const pool = Array.from({ length: Math.max(japan.length, china.length) }, (_, i) => [china[i], japan[i]]).flat().filter(item => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id); return true;
  });
  if (!pool.length) return [];
  const seed = [...date].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
  const start = (seed + batch * 8) % pool.length;
  return Array.from({ length: Math.min(8, pool.length) }, (_, i) => pool[(start + i) % pool.length]);
}
