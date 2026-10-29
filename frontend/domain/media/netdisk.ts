import type { Line } from '@/domain/media/media';

const otherDiskNames = /百度|阿里|阿雲|阿云|天翼|移动云|移动盘|迅雷|微云|蓝奏|蓝凑|城通|小飞机|(?:^|[^a-z])(?:uc|ali|aliyun|alipan|baidu|115|123|139|189)(?=$|[^a-z])/i;
const diskDomains = ['pan.baidu.com', 'alipan.com', 'aliyundrive.com', 'drive.uc.cn', 'fast.uc.cn', 'cloud.189.cn', 'caiyun.139.com', 'yun.139.com', '115.com', '115cdn.com', '123pan.com', '123684.com', '123865.com', '123912.com', '123pan.cn', 'pan.xunlei.com', 'weiyun.com', 'lanzou.com', 'lanzoui.com', 'lanzoux.com', 'lanzoub.com', 'lanzouj.com', 'ctfile.com', 'feijipan.com'];

/** 按域名边界识别分享地址的网盘归属；普通媒体或不透明 ID 返回空值，不猜测其类型。 */
export function netdiskKind(value: string): 'quark' | 'other' | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.hostname === 'pan.quark.cn') return 'quark';
    return diskDomains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)) ? 'other' : null;
  } catch { return null; }
}

/** 仅允许 HTTPS 的夸克分享进入网盘文件流程，拒绝相似域名及带凭证地址。 */
export function isQuarkShare(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'pan.quark.cn' && !url.username && !url.password && url.pathname.startsWith('/s/') && !!url.pathname.split('/')[2];
  } catch { return false; }
}

/** 隐藏其他网盘及未注明类型的网盘线路；保留夸克、普通媒体和待插件解析的普通选集。真实域名优先于线路名。 */
export function playableLines(lines: Line[]): Line[] {
  return lines.flatMap(line => {
    const namedDisk = otherDiskNames.test(line.name) || (/网盘|雲盘|云盘/i.test(line.name) && !/夸克|quark/i.test(line.name));
    const episodes = line.episodes.filter(episode => {
      const kind = netdiskKind(episode.url);
      if (kind === 'quark') return isQuarkShare(episode.url);
      if (kind === 'other') return false;
      return !namedDisk;
    });
    return episodes.length ? [{ ...line, episodes }] : [];
  });
}
