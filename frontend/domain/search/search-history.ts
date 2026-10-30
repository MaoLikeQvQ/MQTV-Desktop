export const SEARCH_HISTORY_KEY = 'mqtv-search-history-v1';
export const SEARCH_HISTORY_LIMIT = 10;

/** 过滤无效词、去掉首尾空白并去重，只保留最近的十条搜索词。 */
export function normalizeSearchHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, SEARCH_HISTORY_LIMIT);
}

/** 从普通业务存储恢复搜索历史；无效 JSON 返回空列表，不修改原始数据。 */
export function readSearchHistory(storage: Pick<Storage, 'getItem'>): string[] {
  const raw = storage.getItem(SEARCH_HISTORY_KEY);
  try { return normalizeSearchHistory(JSON.parse(raw || '[]')); }
  catch { return []; }
}

/** 将本次提交的非空搜索词移到最前面，重复搜索不占用额外记录。 */
export function rememberSearch(history: string[], term: string): string[] {
  return normalizeSearchHistory([term, ...history]);
}
