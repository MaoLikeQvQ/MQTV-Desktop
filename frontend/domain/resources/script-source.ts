import type { Source } from '@/domain/media/media';

export type ScriptLanguage = 'javascript' | 'python';
/** 仅识别 type 3 的 HTTP 脚本入口，避免把 Android 插件或采集接口当成脚本。 */
export function scriptLanguage(source: Source): ScriptLanguage | null {
  if (source.type !== 3) return null;
  try {
    const url = new URL(source.api);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    return /\.py$/i.test(url.pathname) ? 'python' : /\.js$/i.test(url.pathname) ? 'javascript' : null;
  } catch { return null; }
}
/** 将影响执行的来源配置转换为就绪状态身份，防止同 key 改配置后沿用旧运行环境状态。 */
export function scriptSourceIdentity(source: Source): string {
  return JSON.stringify([source.key, source.api, source.ext ?? null, source.type, source.resourceUrl ?? null]);
}

/** 根据当前配置对应的原生运行时状态决定脚本能否搜索；无需逐个授权，首次执行自动检查内容。 */
export function canSearchScriptSource(source: Source, statuses: Record<string, { ready: boolean }>): boolean {
  return source.enabled !== false && source.searchable !== 0 && !!scriptLanguage(source) && statuses[scriptSourceIdentity(source)]?.ready === true;
}
