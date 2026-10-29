import { BACKEND_URL } from '@/config/services';
import { requestJson } from '@/utils/request';
import { buildRequestUrl } from '@/utils/url';
import type { AppUpdateInfo } from '@/domain/settings/app-update';

/** 根据本机平台、架构、系统版本和构建号生成桌面更新检查地址。 */
export function updateCheckUrl(info: AppUpdateInfo): string {
  return buildRequestUrl('/api/update', { platform: info.platform, flavor: 'desktop',
    packageName: info.packageName, versionCode: info.versionCode,
    osVersion: info.osVersion, arch: info.arch }, BACKEND_URL);
}
/** 请求桌面更新接口的原始响应，兼容性及下载地址校验由业务层处理。 */
export const fetchAppUpdate = (info: AppUpdateInfo) => requestJson(updateCheckUrl(info));
