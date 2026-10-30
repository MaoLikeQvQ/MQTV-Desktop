import { applicationStorage } from '@/services/storage';
import { readQuarkInfo, type QuarkEpisode } from '@/api/quark';
import { scanQuarkEpisodes } from '@/services/quark-episodes';
import { isQuarkShare } from '@/domain/media/netdisk';

const PREFIX = 'mqtv-quark-playback-cache-v1:';
type Detail = { shares: string[]; synopsis: string };

/** 从本机持久存储读取解析结果；损坏时明确报错并保留原数据。 */
function read<T>(kind: string, identity: string): T | null {
  try {
    const value = applicationStorage.getItem(PREFIX + JSON.stringify([kind, identity]));
    return value === null ? null : JSON.parse(value) as T;
  } catch { throw new Error('无法读取本机线路缓存，请重新进入影片页面重试。'); }
}

/** 保存不含授权令牌或临时播放地址的目录信息，写入失败时提示用户。 */
function write(kind: string, identity: string, value: unknown): void {
  try {
    const key = PREFIX + JSON.stringify([kind, identity]);
    const serialized = JSON.stringify(value);
    if (applicationStorage.getItem(key) !== serialized) applicationStorage.setItem(key, serialized);
  }
  catch { throw new Error('线路缓存保存失败，请检查本机存储空间。'); }
}

/** 读取持久化分享线路与简介，缓存无自动过期，损坏时报告错误并保留原数据。 */
export function readQuarkInfoCache(url: string): Detail | null {
  const cached = read<Detail>('detail', url);
  if (cached && (!Array.isArray(cached.shares) || !cached.shares.length || !cached.shares.every(isQuarkShare) || typeof cached.synopsis !== 'string')) throw new Error('本机线路缓存格式无效，请重新进入影片页面重试。');
  return cached;
}

/** 优先恢复分享线路与简介；后台更新补齐线路并保留已有简介，取消后保留旧缓存。 */
export async function loadQuarkInfo(url: string, refresh = false, signal?: AbortSignal): Promise<Detail> {
  if (!refresh) {
    const cached = readQuarkInfoCache(url);
    if (cached) return cached;
  }
  const info = await readQuarkInfo(url);
  const previous = refresh ? readQuarkInfoCache(url) : null;
  const result = { shares: [...new Set([...(previous?.shares ?? []), ...info.shares.filter(isQuarkShare)])], synopsis: info.synopsis || previous?.synopsis || '' };
  if (result.shares.length && !signal?.aborted) write('detail', url, result);
  return result;
}

/** 读取完整扫描后保存的选集；跨页面与重启复用，不存储文件访问令牌。 */
export function readQuarkEpisodeCache(share: string): QuarkEpisode[] | null {
  const cached = read<QuarkEpisode[]>('episodes', share);
  if (cached === null) return null;
  if (!Array.isArray(cached) || !cached.length || !cached.every(item => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.parent === 'string' && Number.isInteger(item.page) && item.page > 0)) throw new Error('本机选集缓存格式无效，请重新进入影片页面重试。');
  return cached;
}

/** 仅在目录完整扫描成功后替换持久缓存，扫描取消或失败时保留上次完整结果。 */
export function saveQuarkEpisodeCache(share: string, episodes: QuarkEpisode[]): void {
  write('episodes', share, episodes);
}

/** 后台扫描后更新已有文件元数据并补入新选集，保留已缓存条目和顺序；失败或取消不覆盖缓存。 */
export async function refreshQuarkEpisodes(share: string, signal: AbortSignal): Promise<QuarkEpisode[] | null> {
  const episodes: QuarkEpisode[] = [];
  await scanQuarkEpisodes(share, signal, episode => episodes.push(episode));
  if (signal.aborted) return null;
  const previous = readQuarkEpisodeCache(share);
  const byId = new Map(episodes.map(episode => [episode.id, episode]));
  const knownIds = new Set((previous ?? []).map(episode => episode.id));
  const merged = [...(previous ?? []).map(episode => byId.get(episode.id) ?? episode), ...episodes.filter(episode => !knownIds.has(episode.id))];
  if (JSON.stringify(previous) === JSON.stringify(merged)) return null;
  saveQuarkEpisodeCache(share, merged);
  return merged;
}
