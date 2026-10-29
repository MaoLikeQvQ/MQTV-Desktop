import type { DiscoveryItem } from '@/domain/discovery/discovery-cache';

/** 将非数组对象收窄为字段记录，其他输入返回 null。 */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** 仅接受无凭证的 HTTPS 图片地址，非法或缺失地址返回 undefined。 */
function imageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return; }
}
/**
 * 将豆瓣影片列表映射为统一展示条目，过滤无效条目及不安全图片。
 * @throws 响应中没有合法列表字段时抛出格式错误。
 */
export function parseDoubanList(value: unknown): { items: DiscoveryItem[] } {
  const data = record(value);
  const subjects = data?.subjects ?? data?.data;
  if (!Array.isArray(subjects)) throw Error('豆瓣列表格式异常');
  return { items: subjects.flatMap((value: unknown) => {
    const item = record(value);
    if (!item || typeof item.title !== 'string' || !item.title.trim() || !['string', 'number'].includes(typeof item.id)) return [];
    return [{ id: `douban:${item.id}`, title: item.title.trim(), cover: imageUrl(item.cover), rating: typeof item.rate === 'string' && Number(item.rate) > 0 ? item.rate : undefined }];
  }) };
}

/** 按豆瓣 ID 精确匹配搜索候选封面，避免使用同名影片图片；无匹配时保持无封面。 */
export function parseWeeklyCover(value: unknown, id: string): string | undefined {
  if (!Array.isArray(value)) throw new Error('豆瓣影片封面响应格式异常');
  const item = value.map(record).find(item => item && String(item.id) === id.replace(/^douban:/, ''));
  return imageUrl(item?.img);
}
