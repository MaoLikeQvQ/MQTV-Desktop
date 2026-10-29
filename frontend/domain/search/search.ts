import type { Source } from '@/domain/media/media';
import { DEFAULT_RESOURCE_URL } from '@/domain/resources/resource-cache';

/** 仅允许当前默认资源中的自有来源参与评分，自定义订阅不写入该评分体系。 */
export function canScoreSource(mode: 'default' | 'custom', address: string, source: Source): boolean {
  return mode === 'default' && address === DEFAULT_RESOURCE_URL && source.resourceUrl === undefined;
}

export type Vod = { vod_id: string | number; vod_name: string; vod_pic?: string; vod_remarks?: string; type_name?: string; vod_year?: string; vod_content?: string; vod_play_from?: string; vod_play_url?: string; source: Source };
export type TitleGroup = { key: string; items: Vod[] };

// Match TV TitleGroups: retain season, language and edition suffixes.
/** 规范化影片标题以进行同名分组，保留季数、语言和版本后缀。 */
export function titleKey(title: string): string {
  return title.normalize('NFKC').replace(/[\s\p{Z}]+/gu, ' ').trim().toLowerCase().replace(/[~〜]+$/u, '').trim();
}

/** 按规范化标题分组并按来源与影片 ID 去重，保持首次出现的顺序。 */
export function groupResults(items: Vod[]): TitleGroup[] {
  const groups = new Map<string, { group: TitleGroup; identities: Set<string> }>();
  for (const item of items) {
    const identity = JSON.stringify([item.source.key, String(item.vod_id)]);
    const key = titleKey(item.vod_name) || '\0' + identity;
    let entry = groups.get(key);
    if (!entry) { entry = { group: { key, items: [] }, identities: new Set() }; groups.set(key, entry); }
    if (!entry.identities.has(identity)) { entry.identities.add(identity); entry.group.items.push(item); }
  }
  return [...groups.values()].map(entry => entry.group);
}

/** 将文本规范化为小写字词序列，去除非字母和数字的分隔字符。 */
function words(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Port of TV SearchRelevance v1. Unknown evidence stays null, not zero.
/**
 * 计算关键词与单个标题的匹配度，结合完整命中、词命中及字符顺序。
 * @returns 0 到 1 的相关度；缺乏有效文本时返回 null。
 */
export function titleRelevance(keyword: string, title: string): number | null {
  const queryWords = words(keyword), query = queryWords.replace(/ /g, ''), name = words(title).replace(/ /g, '');
  if (!query || !name) return null;
  if (query === name) return 1;
  const length = [...query].length;
  if (name.includes(query)) return length === 1 ? 0.35 : 0.85 + 0.05 * length / [...name].length;
  if (length === 1) return 0;
  const tokens = [...new Set(queryWords.split(/ +/))];
  const hits = tokens.filter(token => name.includes(token)).length;
  const tokenScore = tokens.length > 1 ? hits === tokens.length ? 0.8 : 0.6 * hits / tokens.length : 0;
  const q = [...query].slice(0, 256), t = [...name].slice(0, 512);
  const available = new Map<string, number>();
  for (const c of t) available.set(c, (available.get(c) ?? 0) + 1);
  let overlap = 0, longest = 0;
  for (const c of q) {
    const count = available.get(c) ?? 0;
    if (count > 0) { overlap++; available.set(c, count - 1); }
  }
  const ordered = new Array<number>(t.length + 1).fill(0), continuous = [...ordered];
  for (const c of q) {
    let previous = 0;
    for (let j = 1; j <= t.length; j++) {
      const old = ordered[j];
      ordered[j] = c === t[j - 1] ? previous + 1 : Math.max(ordered[j], ordered[j - 1]);
      previous = old;
    }
    for (let j = t.length; j > 0; j--) {
      continuous[j] = c === t[j - 1] ? continuous[j - 1] + 1 : 0;
      longest = Math.max(longest, continuous[j]);
    }
  }
  return Math.max(tokenScore, 0.4 * (0.65 * overlap + 0.2 * ordered[t.length] + 0.15 * longest) / length);
}

/** 按结果排名加权汇总标题相关度，无法计算的标题不计入权重。 */
export function searchRelevance(keyword: string, titles: string[]): number | null {
  let sum = 0, weights = 0;
  titles.forEach((title, index) => {
    const value = titleRelevance(keyword, title);
    if (value === null) return;
    const weight = 1 / Math.log(index + 2);
    sum += value * weight; weights += weight;
  });
  return weights ? sum / weights : null;
}

export type SourceScore = { samples: number; successes: number; elapsedTotalMs: number; relevanceTotal: number; relevanceSamples: number };
export type Scores = Record<string, SourceScore>;
export const SCORE_STORAGE_KEY = 'mqtv-search-scores-v1';
/** 创建没有观测样本的来源评分统计。 */
const emptyScore = (): SourceScore => ({ samples: 0, successes: 0, elapsedTotalMs: 0, relevanceTotal: 0, relevanceSamples: 0 });

// Only digest identities and numeric measurements are persisted; no titles or queries.
/** 按后台与来源配置生成 SHA-256 评分标识，避免持久保存查询词或影片标题。 */
export async function scoreIdentity(backend: string, source: Source): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([backend, source.key, source.api, source.ext ?? null]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** 追加一次来源请求的耗时、成功和相关度观测，返回新的统计对象。 */
export function observe(previous: SourceScore | undefined, elapsedMs: number, success: boolean, relevance: number | null): SourceScore {
  const next = { ...(previous ?? emptyScore()) };
  next.samples++;
  next.elapsedTotalMs += Math.max(0, elapsedMs);
  if (success) {
    next.successes++;
    if (relevance !== null && Number.isFinite(relevance) && relevance >= 0 && relevance <= 1) {
      next.relevanceTotal += relevance; next.relevanceSamples++;
    }
  }
  return next;
}

/**
 * 按成功率、相关度、速度的 60/30/10 权重计算评分；未知相关度不计权重。
 * @returns 百分制评分，没有观测样本时返回 null。
 */
export function scoreValue(score?: SourceScore): number | null {
  if (!score?.samples) return null;
  const relevance = score.relevanceSamples ? score.relevanceTotal / score.relevanceSamples : null;
  const speed = 1 / (1 + score.elapsedTotalMs / score.samples / 3000);
  // Same 60/30/10 quality components as tvadmin; unknown relevance is excluded.
  return (60 * score.successes / score.samples + (relevance === null ? 0 : 30 * relevance) + 10 * speed) / (relevance === null ? 70 : 100) * 100;
}

/** 生成来源调度优先值，使未评分来源排在已评分来源之后。 */
export function priority(score?: SourceScore): number {
  // Match the displayed rating; unmeasured sources follow rated ones.
  return scoreValue(score) ?? -1;
}

/** 读取本机来源统计并过滤无效摘要、计数和数值，异常时返回空评分表。 */
export function readScores(storage: Pick<Storage, 'getItem'>): Scores {
  try {
    const data: unknown = JSON.parse(storage.getItem(SCORE_STORAGE_KEY) || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([key, value]) => {
      if (!/^[a-f0-9]{64}$/.test(key) || !value || typeof value !== 'object') return false;
      const s = value as SourceScore;
      return [s.samples, s.successes, s.elapsedTotalMs, s.relevanceTotal, s.relevanceSamples].every(n => Number.isFinite(n) && n >= 0)
        && Number.isInteger(s.samples) && Number.isInteger(s.successes) && Number.isInteger(s.relevanceSamples)
        && s.successes <= s.samples && s.relevanceSamples <= s.successes && s.relevanceTotal <= s.relevanceSamples;
    }));
  } catch { return {}; }
}

/** 持久化最近最多 512 个来源的摘要标识及数值统计。 */
export function saveScores(storage: Pick<Storage, 'setItem'>, scores: Scores): void {
  storage.setItem(SCORE_STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(scores).slice(-512))));
}

// Leave capacity for rendering and parsing; bound simultaneous response buffers.
/** 取设备并行度的 75% 向下取整，并限制为 1 到 16 路；无效输入使用 2 路。 */
export function deviceSearchConcurrency(parallelism: number): number {
  if (!Number.isFinite(parallelism) || parallelism < 1) return 2;
  return Math.min(16, Math.max(1, Math.floor(parallelism * 0.75)));
}

// Higher-rated sources start first; unseen and low-rated sources still get a turn.
/**
 * 按给定来源顺序调度有限并发搜索，单路失败不阻断其他来源。
 * @param sources 按优先顺序排列的来源。
 * @param run 每个来源的搜索操作。
 * @param concurrency 最大并发数。
 * @param onSettled 每路完成后通知当前快照和本次完成结果。
 * @returns 按输入来源顺序排列的成功或失败结果。
 */
export async function searchSources<T>(sources: Source[], run: (source: Source) => Promise<T>, concurrency = deviceSearchConcurrency(globalThis.navigator?.hardwareConcurrency ?? 2), onSettled?: (results: readonly (PromiseSettledResult<T> | undefined)[], completed: PromiseSettledResult<T>) => void): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(sources.length);
  let cursor = 0;
  const workers = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  await Promise.all(Array.from({ length: Math.min(workers, sources.length) }, async () => {
    while (cursor < sources.length) {
      const index = cursor++;
      try { results[index] = { status: 'fulfilled', value: await run(sources[index]) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
      onSettled?.([...results], results[index]);
    }
  }));
  return results;
}
