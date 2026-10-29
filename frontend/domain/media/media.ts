export interface Source { key: string; name: string; api: string; type: number; searchable: number; [key: string]: unknown }
export interface Feed {
  version: string; count: number; sites: Source[];
  subscriptions?: { id: string; url: string; config: Record<string, unknown> }[];
}
export interface Episode { name: string; url: string }
export interface Line { name: string; episodes: Episode[] }

/**
 * 校验资源订阅及各站点的必要字段，保留站点原有扩展配置。
 * @throws 版本、条目数量或站点字段不符合资源契约时抛出错误。
 */
export function parseFeed(value: unknown): Feed {
  if (!value || typeof value !== 'object') throw new Error('资源配置格式错误');
  const feed = value as Record<string, unknown>;
  if (typeof feed.version !== 'string' || !Array.isArray(feed.sites) || feed.count !== feed.sites.length) throw new Error('资源配置格式错误');
  const sites = feed.sites.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('资源格式错误');
    const source = item as Record<string, unknown>;
    if (typeof source.key !== 'string' || !source.key || typeof source.name !== 'string' || typeof source.api !== 'string' || typeof source.type !== 'number') throw new Error('资源格式错误');
    return source as Source;
  });
  return { ...feed, version: feed.version, count: sites.length, sites } as Feed;
}

/** 按线路与选集分隔符解析播放数据；仅插件来源显式允许保留待解析的非 HTTP 选集 ID。 */
export function parseEpisodes(flags: string, input: string, allowOpaqueIds = false): Line[] {
  const names = flags.split('$$$');
  return input.split('$$$').map((group, index) => ({
    name: names[index] || `线路 ${index + 1}`,
    episodes: group.split('#').flatMap((part) => {
      const separator = part.indexOf('$');
      const url = part.slice(separator + 1).trim();
      return separator >= 0 && !!url && (allowOpaqueIds || /^https?:\/\//i.test(url)) ? [{ name: part.slice(0, separator) || '播放', url }] : [];
    }),
  })).filter((line) => line.episodes.length > 0);
}

/** 将有效字节数格式化为带单位及空格的文件大小，无效值显示未知。 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${index === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[index]}`;
}

/** 生成选集按钮使用的紧凑文件大小，省略空格和多余小数零。 */
export function compactFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value=bytes; let index=0;
  while(value>=1024 && index<units.length-1){value/=1024;index++;}
  return `${Number(value.toFixed(index>=3?1:0))}${units[index]}`;
}

/** 生成详情页来源简称，去除开头的装饰符号并按 Unicode 字符取前四位，空名称保留原值。 */
export function sourceShortName(name: string): string {
  const plain = name.replace(/^[^\p{L}\p{N}]+/u, '');
  return Array.from(plain || name).slice(0, 4).join('');
}
