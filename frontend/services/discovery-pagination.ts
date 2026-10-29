import type { DiscoveryItem } from '@/domain/discovery/discovery-cache';

export type DiscoveryPage = { items: DiscoveryItem[] };
export type PaginationState = DiscoveryPage & { loading: boolean; hasMore: boolean; error: string };
export type PageLoader = (page: number, onProgress: (data: DiscoveryPage) => void) => Promise<DiscoveryPage>;

/**
 * 管理首屏之后的分页：合并重复触发、按 ID 追加、失败重试同一页，释放后忽略过期响应。
 * 首屏仍由原有缓存管理；后续页面只保存在当前视图，避免改变首屏缓存内容与有效期。
 */
export function createDiscoveryPagination(initial: DiscoveryItem[], loader: PageLoader, changed: (state: PaginationState) => void) {
  let state: PaginationState = { items: [], loading: false, hasMore: true, error: '' };
  let page = 1;
  let active = true;
  const initialIds = new Set(initial.map(item => item.id));
  const completedIds = new Set(initialIds);
  /** 发布分页状态；页面已离开时不再向旧视图写入。 */
  function publish(next: PaginationState) {
    if (!active) return;
    state = next; changed(state);
  }
  /** 将新返回的条目追加到已显示结果，保留已有顺序并排除首屏及页间重复项。 */
  function append(data: DiscoveryPage) {
    const seen = new Set([...initialIds, ...state.items.map(item => item.id)]);
    const added = data.items.filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id); return true;
    });
    publish({ ...state, items: [...state.items, ...added] });
  }
  /** 进入底部时请求下一页；错误后仅显式重试，失败不推进游标，空页或重复页停止加载。 */
  async function load(retry = false) {
    if (!active || state.loading || !state.hasMore || (state.error && !retry)) return;
    publish({ ...state, loading: true, error: '' });
    try {
      const result = await loader(page, data => { if (active) append(data); });
      if (!active) return;
      const hasNew = result.items.some(item => !completedIds.has(item.id));
      append(result);
      result.items.forEach(item => completedIds.add(item.id));
      page++;
      publish({ ...state, loading: false, hasMore: hasNew });
    } catch (reason) {
      publish({ ...state, loading: false, error: '加载下一页失败：' + (reason instanceof Error ? reason.message : String(reason)) });
    }
  }
  return {
    load,
    /** 读取当前快照，不触发加载或持久化。 */
    read: () => state,
    /** 取消旧视图的更新权限，已在传输的请求结束后也不会追加到新分类。 */
    dispose: () => { active = false; },
  };
}
