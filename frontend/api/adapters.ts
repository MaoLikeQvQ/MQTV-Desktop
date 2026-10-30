import { invokePlayback } from '@/platform/playback-request';
import type { Source } from '@/domain/media/media';
import { nativeSourceConfig } from '@/domain/resources/native-source';
import type { ScriptMediaResponse } from '@/api/scripts';

export type AdapterAuthorization = { token?: string; cookie?: string; deviceId?: string; version?: string; userAgent?: string };
/** 注入外部授权到原生会话；传 null 撤销，凭证不写入订阅、历史或浏览器存储。 */
export const authorizeNativeAdapter = (source: Source, authorization: AdapterAuthorization | null) =>
  invokePlayback<void>('adapter_authorize', { source: nativeSourceConfig(source), authorization });
/** 通过内置协议搜索来源，不执行其 JAR。 */
export const searchNativeSource = (source: Source, keyword: string) => invokePlayback<ScriptMediaResponse>('adapter_search', { source: nativeSourceConfig(source), keyword });
/** 获取原生适配来源的统一详情和不透明选集位置。 */
export const readNativeDetail = (source: Source, id: string) => invokePlayback<ScriptMediaResponse>('adapter_detail', { source: nativeSourceConfig(source), id });
/** 在原生层取得媒体会话并启动代理，前端仅接收回环地址。 */
export const resolveNativePlayback = (source: Source, id: string) => invokePlayback<{ url: string }>('adapter_play', { source: nativeSourceConfig(source), id });
