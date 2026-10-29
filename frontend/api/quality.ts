import { invoke } from '@tauri-apps/api/core';

/** 将单批匿名来源搜索观测发送到配置后台，状态与响应限制由原生层处理。 */
export const postSearchQuality = (events: unknown[]) => invoke<void>('report_search_quality', { events });
