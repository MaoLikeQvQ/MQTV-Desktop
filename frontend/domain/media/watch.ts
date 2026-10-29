import { titleKey, type Vod } from '@/domain/search/search';
import type { PlaybackRecord } from '@/domain/history/history';
import { historyIdentity } from '@/domain/history/history';
import { quarkLine } from '@/domain/resources/quark-lines';

/** 将已接入的夸克网盘来源稳定排在前面，不改变同类来源的原始顺序。 */
export function orderWatchSources(items: Vod[]): Vod[] {
  return [...items].sort((a, b) => Number(quarkLine(b.source).sites.length > 0) - Number(quarkLine(a.source).sites.length > 0));
}

/** 进入同名影片时优先恢复当前资源环境的最近记录；首次观看选择网盘优先后的第一个来源。 */
export function initialWatchSource(items: Vod[], history: PlaybackRecord[], resource: string): { vod: Vod; resume?: PlaybackRecord } | null {
  const ordered = orderWatchSources(items);
  if (!ordered.length) return null;
  const resume = [...history].sort((a, b) => b.updatedAt - a.updatedAt).find(record => ordered.some(vod => record.id === historyIdentity(resource, vod)));
  return { vod: resume ? ordered.find(vod => resume.id === historyIdentity(resource, vod))! : ordered[0], resume };
}

/** 将详情的简介标签与空白转换为纯文本，不向页面插入来源 HTML。 */
export function synopsisText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim() : '';
}

/** 当前来源缺少海报时复用同名影片的已有海报，保留来源身份与播放地址。 */
export function withPlaybackPoster(vod: Vod, candidates: Vod[]): Vod {
  const poster = [vod, ...candidates.filter(item => titleKey(item.vod_name) === titleKey(vod.vod_name))]
    .map(item => item.vod_pic).find(value => typeof value === 'string' && value.trim());
  return poster ? { ...vod, vod_pic: poster } : vod;
}
