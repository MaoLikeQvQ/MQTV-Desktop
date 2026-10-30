import { invokePlayback } from '@/platform/playback-request';
import type { Source } from '@/domain/media/media';
import type { ScriptLanguage } from '@/domain/resources/script-source';

export type ScriptSourceStatus = { key: string; ready: boolean; reason: string };
export type ScriptStatus = { javascript: boolean; python: boolean; sources: ScriptSourceStatus[] };
export type ScriptInspection = { digest: string; files: number; language: ScriptLanguage };
export type ScriptMediaResponse = { list?: Record<string, unknown>[] };
/** 读取内置运行时和指定来源的可用状态，无需手动授权，不下载或执行脚本。 */
export const readScriptStatus = (sources: Source[]) => invokePlayback<ScriptStatus>('script_status', { sources });
/** 下载并校验来源脚本及模块，缓存固定版本并返回内容摘要，不执行脚本或要求手动授权。 */
export const inspectScriptSource = (source: Source) => invokePlayback<ScriptInspection>('script_inspect', { source });
/** 兼容旧调用方的摘要确认接口；正常搜索和播放无需调用。 */
export const trustScriptSource = (source: Source, digest: string) => invokePlayback<void>('script_trust', { source, digest });
/** 在原生层自动检查并执行脚本来源的搜索操作。 */
export const searchScriptSource = (source: Source, keyword: string) => invokePlayback<ScriptMediaResponse>('script_search', { source, keyword });
/** 在原生层读取脚本来源的影片详情，保留不透明影片 ID。 */
export const readScriptDetail = (source: Source, id: string) => invokePlayback<ScriptMediaResponse>('script_detail', { source, id });
/** 将原始选集 ID 交回插件解析，原生层处理必要的媒体代理和请求头。 */
export const resolveScriptPlayback = (source: Source, flag: string, id: string, flags: string[]) => invokePlayback<{ url: string }>('script_play', { source, flag, id, flags });
/** 取消原生脚本操作并关闭当前脚本媒体通道。 */
export const cancelScriptTasks = () => invokePlayback<void>('script_cancel');
