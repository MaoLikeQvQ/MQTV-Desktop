import { invoke } from '@tauri-apps/api/core';
import type { Source } from '@/domain/media/media';
import type { ScriptLanguage } from '@/domain/resources/script-source';

export type ScriptSourceStatus = { key: string; ready: boolean; reason: string };
export type ScriptStatus = { javascript: boolean; python: boolean; sources: ScriptSourceStatus[] };
export type ScriptInspection = { digest: string; files: number; language: ScriptLanguage };
export type ScriptMediaResponse = { list?: Record<string, unknown>[] };
/** 读取内置运行时和指定来源的原生信任状态，不下载或执行脚本。 */
export const readScriptStatus = (sources: Source[]) => invoke<ScriptStatus>('script_status', { sources });
/** 下载并校验来源脚本及模块，返回供用户确认的内容摘要，不执行脚本。 */
export const inspectScriptSource = (source: Source) => invoke<ScriptInspection>('script_inspect', { source });
/** 在用户明确确认后信任已检查的固定内容摘要；内容变更需要重新检查。 */
export const trustScriptSource = (source: Source, digest: string) => invoke<void>('script_trust', { source, digest });
/** 在原生层执行可信来源的搜索操作。 */
export const searchScriptSource = (source: Source, keyword: string) => invoke<ScriptMediaResponse>('script_search', { source, keyword });
/** 在原生层读取可信来源的影片详情，保留不透明影片 ID。 */
export const readScriptDetail = (source: Source, id: string) => invoke<ScriptMediaResponse>('script_detail', { source, id });
/** 将原始选集 ID 交回插件解析，原生层处理必要的媒体代理和请求头。 */
export const resolveScriptPlayback = (source: Source, flag: string, id: string, flags: string[]) => invoke<{ url: string }>('script_play', { source, flag, id, flags });
/** 取消原生脚本操作并关闭当前脚本媒体通道。 */
export const cancelScriptTasks = () => invoke<void>('script_cancel');
