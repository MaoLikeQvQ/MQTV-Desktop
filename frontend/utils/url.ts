export type QueryParams = Record<string, string | number | boolean | null | undefined>;

/**
 * 生成 HTTP(S) 请求地址，保留已有参数并使用新参数覆盖同名项。
 * @param address 完整地址，或配合 baseURL 使用的相对路径。
 * @param params 待编码的查询参数，忽略 null 和 undefined。
 * @param baseURL 解析相对路径使用的服务地址。
 * @throws 地址包含凭证、片段或使用非 HTTP(S) 协议时抛出错误。
 */
export function buildRequestUrl(address: string, params: QueryParams = {}, baseURL?: string): string {
  const url = new URL(address, baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅支持不含凭证的 HTTP 地址');
  }
  if (url.hash) throw new Error('请求地址不能包含片段');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.href;
}

/**
 * 校验环境配置中的服务 origin，允许端口但拒绝路径、查询参数和凭证。
 * @param value 环境变量原始值。
 * @param name 用于错误提示的环境变量名。
 * @returns 规范化后的 HTTP(S) origin。
 */
export function serviceOrigin(value: string | undefined, name: string): string {
  try {
    if (!value?.trim()) throw new Error();
    const url = new URL(buildRequestUrl(value.trim()));
    if (url.pathname !== '/' || url.search) throw new Error();
    return url.origin;
  } catch { throw new Error(`${name} 必须配置为不含路径、参数和凭证的 HTTP(S) 域名`); }
}
