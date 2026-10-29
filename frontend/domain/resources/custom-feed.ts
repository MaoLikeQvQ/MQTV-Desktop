import { nativeAdapter, nativeSourceReady } from '@/domain/resources/native-source';
import { parseFeed, type Feed, type Source } from '@/domain/media/media';
import { quarkLine } from '@/domain/resources/quark-lines';
import { buildRequestUrl } from '@/utils/url';

/** 将订阅中的相对文件路径转换为绝对地址，保留插件名和内联规则。 */
function resolveFile(value: unknown, address: string): unknown {
  return typeof value === 'string' && /^(?:\.\.?\/|\/)/.test(value)
    ? new URL(value, address).href : value;
}

/**
 * 将标准接口或 TVBox sites 配置统一为 Feed；保留扩展字段但不执行脚本或插件。
 * 校验已声明的数量与版本，补齐 TVBox 缺省值，并隔离同订阅内重复的来源 key。
 * @throws 无来源、字段不合法或声明的数量不匹配时拒绝整份订阅。
 */
export function normalizeCustomFeed(value: unknown, address: string): Feed {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('返回数据不是有效的资源配置');
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.sites) || !input.sites.length) throw new Error('返回数据中没有资源来源（sites）');
  const keys = new Set<string>();
  const sites = input.sites.map((item: unknown, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${index + 1} 个资源格式错误`);
    const source = item as Record<string, unknown>;
    if (typeof source.key !== 'string' || !source.key.trim() || typeof source.name !== 'string' || !source.name.trim()
      || typeof source.api !== 'string' || !source.api.trim() || !Number.isInteger(source.type) || (source.type as number) < 0
      || (source.searchable !== undefined && ![0, 1, 2].includes(source.searchable as number))) {
      throw new Error(`第 ${index + 1} 个资源缺少有效的 key、name、api、type 或 searchable`);
    }
    let key = source.key;
    while (keys.has(key)) key += `#${index + 1}`;
    keys.add(key);
    return { ...source, key, originalKey: source.key, api: resolveFile(source.api, address),
      ext: resolveFile(source.ext, address), searchable: source.searchable ?? 1 };
  });
  return parseFeed({ ...input, version: input.version === undefined ? 'tvbox' : input.version, count: input.count === undefined ? sites.length : input.count,
    spider: resolveFile(input.spider, address), sites });
}

/** 判断默认或自定义订阅来源能否进入现有搜索流程，避免将 HTTP 脚本地址误作采集接口。 */
export function canSearchCustomSource(source: Source): boolean {
  if (source.searchable === 0 || source.enabled === false) return false;
  if (nativeAdapter(source)) return nativeSourceReady(source);
  if (quarkLine(source).sites.length > 0) return true;
  if (source.type !== 1 || /\.js(?:[?#]|$)/i.test(source.api)) return false;
  try { buildRequestUrl(source.api); return true; } catch { return false; }
}

/** 统计当前执行能力支持搜索的来源数，不代表已完成来源连通性或播放验证。 */
export function supportedSourceCount(feed: Feed): number {
  return feed.sites.filter(canSearchCustomSource).length;
}

export type ValidatedResource = { url: string; feed: Feed };

/** 请求并解析待添加的订阅，成功才返回统一资源；不修改存储，不自动重试。 */
export async function validateCustomResource(address: string, fetcher: (url: string) => Promise<unknown>): Promise<ValidatedResource> {
  const url = buildRequestUrl(address.trim());
  return { url, feed: normalizeCustomFeed(await fetcher(url), url) };
}
