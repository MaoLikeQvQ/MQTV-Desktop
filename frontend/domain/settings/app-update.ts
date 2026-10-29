import { DEFAULT_RESOURCE_URL } from '@/config/services';
export interface AppUpdateInfo {
  platform: 'macos' | 'windows'; arch: 'arm64' | 'x64' | 'ia32';
  osVersion: string; packageName: string; versionCode: number; versionName: string;
}
export type UpdateResult = { updateAvailable: false } | {
  updateAvailable: true; versionName: string; notes: string; downloadUrl: string;
};
/**
 * 校验更新响应与当前平台、应用标识和构建号，并限制安装包下载地址为后台同源路径。
 * @param value 更新接口原始响应。
 * @param info 本机平台及安装版本信息。
 * @returns 无更新状态或可展示的新版信息。
 * @throws 响应字段、版本匹配或安装包地址校验失败时抛出错误。
 */
export function parseUpdateResult(value: unknown, info: AppUpdateInfo): UpdateResult {
  if (!value || typeof value !== 'object') throw new Error('更新服务返回格式错误');
  const data = value as Record<string, unknown>;
  if (data.updateAvailable === false) return { updateAvailable: false };
  if (data.updateAvailable !== true || data.platform !== info.platform || data.flavor !== 'desktop' ||
      data.packageName !== info.packageName || typeof data.versionCode !== 'number' ||
      !Number.isSafeInteger(data.versionCode) || data.versionCode <= info.versionCode ||
      typeof data.versionName !== 'string' || !data.versionName.trim() ||
      typeof data.downloadUrl !== 'string') throw new Error('更新服务返回的版本信息无效');
  const download = new URL(data.downloadUrl, DEFAULT_RESOURCE_URL);
  if (download.origin !== new URL(DEFAULT_RESOURCE_URL).origin ||
      !new RegExp('^/api/apk/[a-zA-Z0-9_-]+$').test(download.pathname) || download.username || download.password || download.search || download.hash)
    throw new Error('安装包下载地址无效');
  return { updateAvailable: true, versionName: data.versionName,
    notes: typeof data.notes === 'string' ? data.notes : '', downloadUrl: download.href };
}
