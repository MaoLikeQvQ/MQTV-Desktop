import { readNetdiskInfo, readUcSettings, playUcEpisode, type UcEpisode } from '@/api/uc';
import { playQuarkEpisode } from '@/api/quark';
import { scanUcEpisodes } from '@/services/uc-episodes';
import { scanQuarkEpisodes } from '@/services/quark-episodes';
import { readQuarkInfoCache, readQuarkEpisodeCache, saveQuarkEpisodeCache, refreshQuarkEpisodes } from '@/services/quark-playback-cache';
import { applicationStorage } from '@/services/storage';
import { isNetdiskShare, isUcShare } from '@/domain/media/netdisk';

type Detail = { shares: string[]; synopsis: string };
const PREFIX = 'mqtv-netdisk-playback-cache-v1:';
const MAX_AGE = 10 * 60 * 1000;
/** 读取网盘公开元数据缓存，损坏时保留原值并报告错误。 */
function read<T>(kind: string, identity: string, search = false): T | null {
  try {
    const key = PREFIX + JSON.stringify([kind, identity]);
    if (search) {
      const time = Number(applicationStorage.getItem(key + ':time'));
      if (!time || Date.now() < time || Date.now() - time >= MAX_AGE) return null;
    }
    const raw = applicationStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw) as T;
  } catch { throw new Error('无法读取本机网盘缓存，请重新进入影片页面重试。'); }
}
/** 写入不含凭证或临时媒体地址的缓存，保存失败时提示。 */
function write(kind: string, identity: string, value: unknown): void {
  try {
    const key = PREFIX + JSON.stringify([kind, identity]), raw = JSON.stringify(value);
    if (applicationStorage.getItem(key) !== raw) applicationStorage.setItem(key, raw);
    applicationStorage.setItem(key + ':time', String(Date.now()));
  } catch { throw new Error('网盘缓存保存失败，请检查本机存储空间。'); }
}
/** 恢复混合网盘线路；搜索入口限十分钟，历史入口保留可用的公开分享元数据。 */
export function readNetdiskInfoCache(url: string, search = false): Detail | null {
  const cached = read<Detail>('detail', url, search) ?? readQuarkInfoCache(url, search);
  if (cached && (!Array.isArray(cached.shares) || !cached.shares.length || !cached.shares.every(isNetdiskShare) || typeof cached.synopsis !== 'string')) throw new Error('本机网盘线路缓存格式无效');
  return cached;
}
/** 一次请求提取夸克与 UC 分享，取消时不覆盖原缓存，刷新时保留已有简介。 */
export async function loadNetdiskInfo(url: string, refresh = false, signal?: AbortSignal, search = false): Promise<Detail> {
  if (!refresh) { const cached = readNetdiskInfoCache(url, search); if (cached) return cached; }
  const info = await readNetdiskInfo(url), previous = refresh ? readNetdiskInfoCache(url) : null;
  const result = { shares: [...new Set(info.shares.filter(isNetdiskShare))], synopsis: info.synopsis || previous?.synopsis || '' };
  if (result.shares.length && !signal?.aborted) write('detail', url, result);
  return result;
}
/** 绑定分享所属网盘及 UC 账号，确保缓存、扫描和播放不会交叉使用另一网盘或账号。 */
export async function netdiskPlayback(share: string) {
  if (!isNetdiskShare(share)) throw new Error('不支持的网盘分享地址');
  const uc = isUcShare(share);
  const account = uc ? await readUcSettings() : null;
  if (uc && (!account?.cached || !account.accountId)) throw new Error('请先在授权管理中授权 UC 网盘或验证内测码');
  const identity = JSON.stringify([account?.accountId, share]);
  /** 读取绑定账号的完整目录，夸克继续兼容原有缓存格式。 */
  function readCache(search = false): UcEpisode[] | null {
    if (!uc) return readQuarkEpisodeCache(share, search);
    const cached = read<UcEpisode[]>('uc-episodes', identity, search);
    if (cached && (!Array.isArray(cached) || !cached.length || !cached.every(item => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.parent === 'string' && Number.isInteger(item.page) && item.page > 0))) throw new Error('本机 UC 选集缓存格式无效');
    return cached;
  }
  /** UC 扫描或播放期间账号变化时拒绝继续使用原账号上下文。 */
  async function assertAccount(): Promise<void> {
    if (uc && (await readUcSettings()).accountId !== account?.accountId) throw new Error('UC 账号已变化，请重新打开影片');
  }
  /** 完整扫描成功且账号未变化时保存目录，不存储任何文件令牌。 */
  async function saveCache(episodes: UcEpisode[], signal?: AbortSignal): Promise<void> {
    await assertAccount();
    if (signal?.aborted) return;
    if (uc) write('uc-episodes', identity, episodes); else saveQuarkEpisodeCache(share, episodes);
  }
  /** 按网盘分派渐进目录扫描，取消后不再输出或继续翻页。 */
  async function scan(signal: AbortSignal, emit: (episode: UcEpisode) => void): Promise<void> {
    await assertAccount();
    await (uc ? scanUcEpisodes : scanQuarkEpisodes)(share, signal, emit);
    await assertAccount();
  }
  /** 后台完整扫描后合并目录，失败、取消或账号变化时保留旧缓存。 */
  async function refresh(signal: AbortSignal): Promise<UcEpisode[] | null> {
    if (!uc) return refreshQuarkEpisodes(share, signal);
    const episodes: UcEpisode[] = [];
    await scan(signal, episode => episodes.push(episode));
    if (signal.aborted) return null;
    const previous = readCache(), byId = new Map(episodes.map(episode => [episode.id, episode]));
    const known = new Set((previous ?? []).map(episode => episode.id));
    const merged = [...(previous ?? []).filter(episode => byId.has(episode.id)).map(episode => byId.get(episode.id)!), ...episodes.filter(episode => !known.has(episode.id))];
    if (JSON.stringify(previous) === JSON.stringify(merged)) return null;
    await saveCache(merged, signal); return signal.aborted ? null : merged;
  }
  /** 使用绑定网盘准备选集，UC 账号变化时阻止转存并要求重新进入。 */
  async function play(episode: UcEpisode): Promise<{ url: string }> {
    await assertAccount();
    const result = await (uc ? playUcEpisode : playQuarkEpisode)({ share, parent: episode.parent, passcode: new URL(share).searchParams.get('pwd') || '', fid: episode.id, page: episode.page });
    await assertAccount(); return result;
  }
  return { readCache, saveCache, scan, refresh, play };
}
