import type { TitleGroup, Vod } from '@/domain/search/search';
import type { QuarkEpisode } from '@/api/quark';
import { scriptLanguage } from '@/domain/resources/script-source';
import { quarkLine } from '@/domain/resources/quark-lines';
import { nativeAdapter, nativeSourceConfig } from '@/domain/resources/native-source';

export type PlaybackProgress = { position: number; duration: number; speed: number };
export type PlaybackTarget = {
  line: string;
  episode: string;
  episodeIndex: number;
  episodeCount: number;
  url?: string;
  script?: { id: string; flag: string };
  quark?: { share: string; file: QuarkEpisode };
};
export type PlaybackRecord = PlaybackProgress & {
  id: string;
  resource: string;
  vod: Vod;
  target: PlaybackTarget;
  group: TitleGroup;
  updatedAt: number;
};
export const HISTORY_KEY = 'mqtv-playback-history-v1';
export const HISTORY_LIMIT = 200;
/** 使用资源环境、来源和影片 ID 生成历史标识，避免不同订阅间的影片记录冲突。 */
export function historyIdentity(resource: string, vod: Vod): string {
  return JSON.stringify([resource, vod.source.resourceUrl ?? '', vod.source.key, String(vod.vod_id)]);
}
/** 判断输入是否为有限的非负数，供历史数据校验使用。 */
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
/** 校验历史记录、来源、选集定位和播放进度，过滤无法安全恢复的记录。 */
function valid(value: unknown): value is PlaybackRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as PlaybackRecord;
  const t = r.target, v = r.vod, s = v?.source;
  return typeof r.id === 'string' && typeof r.resource === 'string' && !!v && typeof v.vod_name === 'string'
    && (typeof v.vod_id === 'string' || typeof v.vod_id === 'number') && !!s && typeof s.key === 'string'
    && typeof s.name === 'string' && typeof s.api === 'string' && validHistoryGroup(r.group) && !!t && typeof t.line === 'string'
    && typeof t.episode === 'string' && Number.isInteger(t.episodeIndex) && t.episodeIndex >= 0
    && Number.isInteger(t.episodeCount) && t.episodeCount > t.episodeIndex
    && (t.quark ? typeof t.quark.share === 'string' && typeof t.quark.file?.id === 'string' && typeof t.quark.file?.name === 'string'
      : t.script ? !!(scriptLanguage(s) || nativeAdapter(s)) && typeof t.script.id === 'string' && !!t.script.id && typeof t.script.flag === 'string'
        : typeof t.url === 'string' && /^https?:\/\//i.test(t.url))
    && nonnegative(r.position) && nonnegative(r.duration) && nonnegative(r.updatedAt)
    && nonnegative(r.speed) && r.speed > 0;
}
/** 保存影片展示信息及恢复来源所需配置，不持久化解析后的临时媒体地址。 */
export function historyVod(vod: Vod): Vod {
  return {
    vod_id: vod.vod_id, vod_name: vod.vod_name, vod_pic: vod.vod_pic,
    vod_remarks: vod.vod_remarks, type_name: vod.type_name, vod_year: vod.vod_year, vod_content: vod.vod_content,
    source: {
      key: vod.source.key, name: vod.source.name, api: vod.source.api,
      ext: (scriptLanguage(vod.source) || nativeAdapter(vod.source))
        ? (nativeAdapter(vod.source) ? nativeSourceConfig(vod.source).ext : vod.source.ext) : { siteUrl: quarkLine(vod.source).sites },
      type: vod.source.type, searchable: vod.source.searchable, resourceUrl: vod.source.resourceUrl,
    },
  };
}
/** 校验同组来源及影片信息，确保续播可以恢复来源切换列表。 */
function validHistoryGroup(value: unknown): value is TitleGroup {
  if (!value || typeof value !== 'object') return false;
  const group = value as TitleGroup;
  return typeof group.key === 'string' && Array.isArray(group.items) && group.items.length > 0
    && group.items.every(item => item && (typeof item.vod_id === 'string' || typeof item.vod_id === 'number')
      && typeof item.vod_name === 'string' && item.source && typeof item.source.key === 'string'
      && typeof item.source.name === 'string' && typeof item.source.api === 'string');
}
/**
 * 读取并校验本机播放历史，按更新时间倒序返回最多 200 条记录。
 * @throws JSON 或列表格式损坏时抛出错误，由调用方保留原数据并提示。
 */
export function readHistory(storage: Pick<Storage, 'getItem'>): PlaybackRecord[] {
  const raw = storage.getItem(HISTORY_KEY);
  if (!raw) return [];
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('播放记录格式无效');
  return data.filter(valid).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, HISTORY_LIMIT);
}
/** 将最多 200 条播放记录写入本机存储，存储失败由调用方处理。 */
export function saveHistory(storage: Pick<Storage, 'setItem'>, records: PlaybackRecord[]): void {
  storage.setItem(HISTORY_KEY, JSON.stringify(records.slice(0, HISTORY_LIMIT)));
}
/** 把当前影片记录置顶并替换同标识旧记录，缺少海报时保留旧海报，返回有数量上限的新列表。 */
export function upsertHistory(records: PlaybackRecord[], record: PlaybackRecord): PlaybackRecord[] {
  const previous = records.find(item => item.id === record.id);
  const next = record.vod.vod_pic?.trim() || !previous?.vod.vod_pic ? record
    : { ...record, vod: { ...record.vod, vod_pic: previous.vod.vod_pic } };
  return [next, ...records.filter(item => item.id !== record.id)].slice(0, HISTORY_LIMIT);
}
// Refresh detail first: URLs and ordering can change between visits.
/**
 * 在刷新后的详情中按线路和播放地址定位历史选集，地址变化时按集名回退。
 * @returns 匹配的线路索引与选集，无法匹配时返回 null。
 */
export function findHistoryEpisode(lines: import('@/domain/media/media').Line[], target: PlaybackTarget) {
  const lineIndex = lines.findIndex(line => line.name === (target.script?.flag ?? target.line));
  if (lineIndex < 0) return null;
  const episodes = lines[lineIndex].episodes;
  let episodeIndex = episodes.findIndex(item => item.url === (target.script?.id ?? target.url));
  if (episodeIndex < 0) episodeIndex = episodes.findIndex(item => item.name === target.episode);
  return episodeIndex < 0 ? null : { lineIndex, episode: episodes[episodeIndex] };
}
/** 按稳定选集身份判断是否恢复上次进度，脚本同名选集不能仅凭显示名称匹配。 */
export function samePlaybackTarget(current: PlaybackTarget, previous: PlaybackTarget): boolean {
  if (current.quark || previous.quark) return !!current.quark && !!previous.quark
    && current.quark.share === previous.quark.share && current.quark.file.id === previous.quark.file.id;
  if (current.script || previous.script) return !!current.script && !!previous.script
    && current.script.flag === previous.script.flag && current.script.id === previous.script.id;
  return current.line === previous.line && current.episode === previous.episode;
}
/** 将秒数转换为播放记录显示的分秒或时分秒文本。 */
export function playbackTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${value >= 3600 ? `${Math.floor(value / 3600)}:` : ''}${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
