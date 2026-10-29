import { fetchResource } from '@/api/resources';
import { loadResource } from '@/domain/resources/resource-cache';
import { resolveCustomResources, type CustomResource } from '@/domain/resources/custom-resources';
import { validateCustomResource, type ValidatedResource } from '@/domain/resources/custom-feed';
import type { Feed } from '@/domain/media/media';

/**
 * 按订阅地址读取资源，按需复用七天缓存并校验响应后持久化。
 * @param storage 本机存储适配。
 * @param address 当前资源订阅地址，也是缓存隔离依据。
 * @param useCache 是否允许复用未过期的订阅缓存。
 */
export const readResourceFeed = (storage: Storage, address: string, useCache: boolean) =>
  loadResource(storage, address, useCache, fetchResource);
/** 并行加载已启用的自定义订阅，隔离失败项并合并带来源标识的资源。 */
export const readCustomResourceFeeds = (entries: CustomResource[], validated?: ValidatedResource) =>
  resolveCustomResources(entries, fetchResource, validated);

/** 添加或编辑前通过真实请求校验订阅，返回可直接参与合并的统一结构。 */
export const inspectCustomResource = (address: string) => validateCustomResource(address, fetchResource);

/** 一并保存订阅、合并资源和资源模式；写入失败时恢复原值，避免重启读取旧资源。 */
export function persistCustomResourceState(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, result: { entries: CustomResource[]; feed: Feed }): void {
  const values = [
    ['mqtv-custom-resources', JSON.stringify(result.entries)],
    ['mqtv-feed', JSON.stringify(result.feed)],
    ['mqtv-resource-mode', 'custom'],
  ];
  const previous = values.map(([key]) => [key, storage.getItem(key)] as const);
  try {
    for (const [key, value] of values) storage.setItem(key, value);
  } catch (reason) {
    for (const [key, value] of previous) {
      if (storage.getItem(key) === value) continue;
      if (value === null) storage.removeItem(key); else storage.setItem(key, value);
    }
    throw reason;
  }
}
