import { parseFeed, type Feed } from '@/domain/media/media';
import { DEFAULT_RESOURCE_URL } from '@/config/services';
export { DEFAULT_RESOURCE_URL } from '@/config/services';
/** 将缺失地址或历史默认地址迁移为当前环境的默认资源地址，保留自定义地址。 */
export function resolveResourceUrl(saved: string | null): string {
  return !saved || ['http://127.0.0.1:3101/api/resources', 'http://localhost:3101/api/resources', 'http://tvadmin.maolike.cn/api/resources'].includes(saved) ? DEFAULT_RESOURCE_URL : saved;
}
export const RESOURCE_TTL = 7 * 24 * 60 * 60 * 1000;
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export type ResourceCache = { feed: Feed; updatedAt: number };
/** 按完整订阅地址生成独立的资源缓存存储键。 */
const key = (address: string) => 'mqtv-resource-cache:' + address;
/** 读取并校验指定订阅的资源缓存，无效或缺失缓存返回 null。 */
export function readResourceCache(storage: Storage, address: string): ResourceCache | null {
  try {
    const data = JSON.parse(storage.getItem(key(address)) || 'null');
    if (!data || !Number.isFinite(data.updatedAt) || data.updatedAt <= 0) return null;
    return { feed: parseFeed(data.feed), updatedAt: data.updatedAt };
  } catch { return null; }
}
/** 检查资源缓存是否处于七天有效期内，未来时间戳视为无效。 */
export function resourceCacheFresh(cache: ResourceCache | null, now = Date.now()): boolean {
  return !!cache && now >= cache.updatedAt && now - cache.updatedAt < RESOURCE_TTL;
}
/**
 * 按需复用资源缓存，否则请求并校验新订阅，成功后才保存缓存与更新时间。
 * @param storage 资源缓存存储适配。
 * @param address 完整订阅地址。
 * @param useCache 是否允许复用有效缓存。
 * @param fetcher 获取订阅响应的函数。
 * @param now 本次有效期判断与成功更新时间。
 * @throws 请求、响应校验或持久化失败时抛出错误。
 */
export async function loadResource(storage: Storage, address: string, useCache: boolean, fetcher: (url: string) => Promise<unknown>, now = Date.now()): Promise<ResourceCache> {
  const cached = readResourceCache(storage, address);
  if (useCache && resourceCacheFresh(cached, now)) return cached!;
  const result = { feed: parseFeed(await fetcher(address)), updatedAt: now };
  storage.setItem(key(address), JSON.stringify(result));
  return result;
}
