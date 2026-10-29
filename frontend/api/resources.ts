import { requestJson } from '@/utils/request';

/** 请求指定资源订阅的原始 JSON；缓存、格式校验与多订阅合并由上层处理。 */
export const fetchResource = (address: string) => requestJson(address);
