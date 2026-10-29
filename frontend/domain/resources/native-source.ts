import type { Source } from '@/domain/media/media';

/** 识别内置原生协议适配；不根据相近名称执行 Guard、Amns 或任意 JAR。 */
export function nativeAdapter(source: Source): 'anime1' | 'appget' | null {
  if (source.type !== 3) return null;
  return source.api === 'csp_Anime1' ? 'anime1' : source.api === 'csp_AppGet' ? 'appget' : null;
}
/** 只保留原生协议配置，防止订阅中的旧账号字段传播到调用参数或新增历史。 */
export function nativeSourceConfig(source: Source): Source {
  let config: Record<string, unknown> = {};
  try {
    const ext = typeof source.ext === 'string' ? JSON.parse(source.ext) : source.ext;
    if (ext && typeof ext === 'object' && !Array.isArray(ext)) config = ext as Record<string, unknown>;
  } catch { /* 无效配置由原生层明确报错。 */ }
  return { key: source.key, name: source.name, type: source.type, api: source.api, searchable: source.searchable,
    ext: Object.fromEntries(['url', 'site', 'dataKey', 'dataIv'].filter(key => typeof config[key] === 'string').map(key => [key, config[key]])) };
}
/** 检查可静态确认的配置要求；就绪只代表具备调用能力，不代表远端连通或授权有效。 */
export function nativeSourceReady(source: Source): boolean {
  const adapter = nativeAdapter(source);
  if (!adapter || source.searchable === 0 || source.enabled === false) return false;
  if (adapter === 'anime1') return true;
  try {
    const ext = typeof source.ext === 'string' ? JSON.parse(source.ext) : source.ext;
    if (!ext || typeof ext !== 'object') return false;
    const config = ext as Record<string, unknown>;
    const url = new URL(String(config.url || config.site || ''));
    const encoder = new TextEncoder();
    return (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      && !url.username && !url.password && !url.hash
      && typeof config.dataKey === 'string' && [16, 24, 32].includes(encoder.encode(config.dataKey).length)
      && typeof config.dataIv === 'string' && encoder.encode(config.dataIv).length === 16;
  } catch { return false; }
}
