import { normalizeSearchKeyword } from '@/domain/search/search-keyword';
import { fetchSearchSuggestions } from '@/api/search-suggestions';

/** 读取当前输入的候选片名，兼容 TV 使用的 name/title 字段，去空、去重并限制为十二项。 */
export async function readSearchSuggestions(keyword: string): Promise<string[]> {
  keyword = normalizeSearchKeyword(keyword);
  if (!keyword) return [];
  const response = await fetchSearchSuggestions(keyword);
  if (!response || typeof response !== 'object') throw new Error('联想响应无效');
  const value = response as { code?: string; data?: unknown };
  if (value.code !== 'A00000' || !Array.isArray(value.data)) throw new Error('联想响应无效');
  return [...new Set(value.data.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const title = item.name ?? item.title;
    return typeof title === 'string' && title.trim() ? [title.trim()] : [];
  }))].slice(0, 12);
}
