import { postSearchQuality } from '@/api/quality';
import { searchRelevance, titleRelevance } from '@/domain/search/search';

export type SearchQualityEvent = {
  id: string; resourceId: string; kind: 'search'; success: boolean; durationMs: number;
  resultCount: number; matchedCount: number; relevanceVersion: 1; relevanceScore?: number;
};
/** 生成后台兼容的匿名观测；词与片名只用于本机计算，失败结果计数为零，未知相关度不伪造为零。 */
export function makeSearchQuality(resourceId: string, elapsed: number, success: boolean, keyword: string, titles: string[]): SearchQualityEvent {
  const names = success ? titles.slice(0, 100000) : [];
  const relevance = success ? searchRelevance(keyword, names) : null;
  return { id: crypto.randomUUID(), resourceId, kind: 'search', success, durationMs: Math.min(86400000, Math.max(0, Math.round(elapsed))), resultCount: names.length,
    matchedCount: names.filter(title => (titleRelevance(keyword, title) ?? 0) >= 0.6).length, relevanceVersion: 1,
    ...(names.length && relevance !== null ? { relevanceScore: relevance } : {}) };
}
/** 按后台每批最多二十条的契约依次上报，不自动重试；失败交由调用者处理，不影响搜索结果。 */
export async function submitSearchQuality(events: SearchQualityEvent[]): Promise<void> {
  for (let index = 0; index < events.length; index += 20) await postSearchQuality(events.slice(index, index + 20));
}
