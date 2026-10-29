import type { Source } from '@/domain/media/media';

/** 解析资源中的夸克线路站点配置，校验 HTTPS 地址并给出不支持原因。 */
export function quarkLine(source: Source): { sites: string[]; reason: string } {
  if (!/wogg/i.test(source.api)) return { sites: [], reason: '此插件尚未适配桌面端' };
  let ext = source.ext;
  if (typeof ext === 'string') {
    try { ext = JSON.parse(ext); } catch { ext = null; }
  }
  const config = ext && typeof ext === 'object' ? ext as Record<string, unknown> : {};
  // WoGGGuard packages the site inside its Android jar. Its desktop adapter
  // uses the public WoGG site unless the feed supplies an explicit override.
  const value = config.siteUrl ?? config.site ?? (source.api === 'csp_WoGGGuard' ? 'https://www.wogg.net/' : undefined);
  const candidates = Array.isArray(value) ? value : [value];
  const sites = candidates.filter((v): v is string => {
    if (typeof v !== 'string') return false;
    try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
  });
  return { sites, reason: sites.length ? '支持线路搜索' : '线路缺少可用的 HTTPS 站点配置' };
}
