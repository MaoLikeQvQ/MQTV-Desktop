import { invoke } from '@tauri-apps/api/core';
import { BACKEND_URL } from '@/config/services';
import { buildRequestUrl, type QueryParams } from '@/utils/url';

export type RequestOptions = { baseURL?: string; params?: QueryParams };

// Native transport owns timeouts, HTTP status, JSON decoding and response size limits.
// No automatic retries: callers decide whether a failed operation may be repeated.
/**
 * 统一发送 JSON 请求，校验地址、合并查询参数并将原生失败转换为 Error。
 * @template T 调用方预期的响应类型，不替代运行时字段校验。
 * @param address 完整地址或相对于后台的接口路径。
 * @param options 可选服务地址和查询参数。
 * @returns 原生层解码后的 JSON；超时、HTTP 状态和大小限制由原生层执行。
 * @throws 地址校验或请求失败时抛出错误，不自动重试。
 */
export async function requestJson<T = unknown>(address: string, options: RequestOptions = {}): Promise<T> {
  try {
    const url = buildRequestUrl(address, options.params, options.baseURL ?? BACKEND_URL);
    return await invoke<T>('fetch_json', { url });
  } catch (reason) {
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

