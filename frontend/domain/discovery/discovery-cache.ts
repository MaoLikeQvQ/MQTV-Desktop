export type DiscoveryItem = { id: string; title: string; cover?: string; rating?: string; weekday?: number };
export type DiscoveryCache = { items: DiscoveryItem[]; updatedAt: number };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export const DISCOVERY_TTL = 60 * 60 * 1000;
const prefix = 'mqtv-discovery-cache:v1:';

/** 校验并规范化发现页缓存条目，只保留支持的展示字段和有效星期。 */
function parseItems(data: unknown): DiscoveryItem[] {
  if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) throw new Error('推荐内容格式异常');
  return data.items.filter((item): item is DiscoveryItem => !!item && typeof item === 'object' && typeof item.id === 'string' && typeof item.title === 'string')
    .map(item => ({ id: item.id, title: item.title, cover: typeof item.cover === 'string' ? item.cover : undefined, rating: typeof item.rating === 'string' ? item.rating : undefined, ...(Number.isInteger(item.weekday) && item.weekday! >= 1 && item.weekday! <= 7 ? { weekday: item.weekday } : {}) }));
}

// One cache per application instance; storage also survives a restart.
/**
 * 创建跨重启的发现页缓存；按启动时刻判断一小时有效期，同次运行不自动过期刷新。
 * @param storage 持久存储适配。
 * @param startedAt 本次应用启动时间，用于固定本次运行的过期判断。
 * @returns 缓存读取、加载、刷新判断及失败重试方法。
 */
export function createDiscoveryCache(storage: Storage, startedAt = Date.now()) {
  const memory = new Map<string, DiscoveryCache>();
  const pending = new Map<string, Promise<DiscoveryCache>>();
  const settled = new Set<string>();
  const failures = new Map<string, unknown>();
  /** 先读取内存，再读取并校验持久缓存；损坏或缺失的缓存返回 null。 */
  function read(url: string): DiscoveryCache | null {
    const saved = memory.get(url);
    if (saved) return saved;
    try {
      const data = JSON.parse(storage.getItem(prefix + url) || 'null');
      if (!data || !Number.isFinite(data.updatedAt) || data.updatedAt <= 0) return null;
      const cached = { items: parseItems(data), updatedAt: data.updatedAt };
      memory.set(url, cached);
      return cached;
    } catch { return null; }
  }
  /** 根据本次启动时刻判断是否需要加载；本次已完成的请求不会重复自动刷新。 */
  function needsRefresh(url: string): boolean {
    if (settled.has(url)) return false;
    const cached = read(url);
    return !cached || startedAt < cached.updatedAt || startedAt - cached.updatedAt > DISCOVERY_TTL;
  }
  /** 解除失败请求的本次运行限制，使显式重试可以再次加载。 */
  function retryFailed() {
    for (const url of failures.keys()) settled.delete(url);
    failures.clear();
  }
  /**
   * 复用有效缓存或正在进行的请求，成功后更新缓存，失败时保留旧值并记录失败状态。
   * @param url 请求地址及缓存键。
   * @param fetcher 缓存缺失或启动时过期才执行的加载函数。
   * @param now 可选成功更新时间，便于确定性验证。
   */
  function load(url: string, fetcher: (url: string) => Promise<unknown>, now?: number): Promise<DiscoveryCache> {
    const running = pending.get(url);
    if (running) return running;
    if (failures.has(url)) return Promise.reject(failures.get(url));
    const cached = read(url);
    if (cached && !needsRefresh(url)) { settled.add(url); return Promise.resolve(cached); }
    const request = Promise.resolve().then(() => fetcher(url)).then(data => {
      const result = { items: parseItems(data), updatedAt: now ?? Date.now() };
      memory.set(url, result);
      settled.add(url);
      // Full or unavailable storage must not turn a successful request into a load failure.
      try { storage.setItem(prefix + url, JSON.stringify(result)); } catch { /* Keep the in-memory cache. */ }
      return result;
    }).catch(error => { settled.add(url); failures.set(url, error); throw error; }).finally(() => { pending.delete(url); });
    pending.set(url, request);
    return request;
  }
  return { read, load, needsRefresh, retryFailed };
}

// Keep bytes, rather than object URLs, so each card can safely release its own URL.
export type CoverStorage = { read: (url: string) => Promise<Blob | null>; write: (url: string, blob: Blob) => Promise<void> };
/**
 * 创建有容量上限的图片内存缓存，支持持久存储回填与并发下载去重。
 * @param maxEntries 内存中最多保留的最近使用图片数量。
 * @param storage 可选持久图片存储；存储失败不阻止图片网络加载。
 */
export function createCoverCache(maxEntries = 120, storage?: CoverStorage) {
  const entries = new Map<string, Promise<Blob>>();
  const pending = new Map<string, Promise<Blob>>();
  return (url: string, fetcher: (url: string) => Promise<number[]>): Promise<Blob> => {
    const cached = entries.get(url);
    if (cached) {
      entries.delete(url); entries.set(url, cached);
      return cached;
    }
    const running = pending.get(url);
    if (running) return running;
    const request = Promise.resolve().then(async () => {
      let blob: Blob | null = null;
      try { blob = await storage?.read(url) ?? null; } catch { /* Storage failure still permits a network load. */ }
      if (!blob) {
        blob = new Blob([new Uint8Array(await fetcher(url))]);
        if (!blob.size) throw new Error('图片内容为空');
        try { await storage?.write(url, blob); } catch { /* Keep the memory cache when persistent storage is unavailable. */ }
      }
      entries.set(url, Promise.resolve(blob));
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      return blob;
    }).finally(() => { pending.delete(url); });
    pending.set(url, request);
    return request;
  };
}
