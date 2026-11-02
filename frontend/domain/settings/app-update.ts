import { DESKTOP_RELEASES_URL } from '@/config/services';
export interface AppUpdateInfo {
  platform: 'macos' | 'windows'; arch: 'arm64' | 'x64' | 'ia32';
  osVersion: string; packageName: string; versionCode: number; versionName: string;
}
export type UpdateResult = { updateAvailable: false } | {
  updateAvailable: true; versionName: string; notes: string; downloadUrl: string;
};

/** 将系统版本解析为可比较的数字段；非法版本不参与兼容性判断。 */
function osParts(value: string): number[] {
  if (!/^\d+(?:\.\d+){0,3}$/.test(value)) throw new Error('更新清单的系统版本无效');
  const parts = value.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('更新清单的系统版本无效');
  return parts;
}

/** 比较系统版本，缺省小版本视为零，例如 14 与 14.0 等价。 */
function meetsMinimum(current: string, minimum: string): boolean {
  const installed = osParts(current), required = osParts(minimum);
  for (let index = 0; index < Math.max(installed.length, required.length); index++) {
    const difference = (installed[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/** 仅接受本项目 GitHub Release 的直接安装包附件，拒绝其他仓库、协议和路径。 */
function installerUrl(value: string, platform: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('安装包下载地址无效'); }
  const releases = new URL(DESKTOP_RELEASES_URL);
  const prefix = releases.pathname + '/download/';
  const parts = url.pathname.slice(prefix.length).split('/');
  const extension = platform === 'macos' ? /\.(dmg|pkg)$/i : /\.(exe|msi)$/i;
  if (url.origin !== releases.origin || !url.pathname.startsWith(prefix) || parts.length !== 2 ||
      parts.some(part => !part || /[\\/\s]/.test(decodeURIComponent(part)) || ['.', '..'].includes(decodeURIComponent(part))) ||
      !extension.test(parts[1]) || url.username || url.password || url.search || url.hash) {
    throw new Error('安装包下载地址无效');
  }
  return url.href;
}

/**
 * 校验 GitHub 更新清单，并按应用标识、构建号、平台、架构和可选最低系统版本选择安装包。
 * 不兼容或没有更新时返回无更新；缺失字段和非法下载地址明确报错。
 */
export function parseUpdateResult(value: unknown, info: AppUpdateInfo): UpdateResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('更新服务返回格式错误');
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1 || data.packageName !== info.packageName ||
      !Number.isSafeInteger(data.versionCode) || (data.versionCode as number) <= 0 ||
      typeof data.versionName !== 'string' || !data.versionName.trim() ||
      typeof data.notes !== 'string' || !Array.isArray(data.packages) || !data.packages.length) {
    throw new Error('更新服务返回的版本信息无效');
  }
  const identities = new Set<string>();
  let selected: string | undefined;
  for (const item of data.packages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('更新清单的安装包信息无效');
    const entry = item as Record<string, unknown>;
    if (!['macos', 'windows'].includes(String(entry.platform)) || !['arm64', 'x64', 'ia32'].includes(String(entry.arch)) ||
        typeof entry.downloadUrl !== 'string' || (entry.minOsVersion !== undefined && typeof entry.minOsVersion !== 'string')) {
      throw new Error('更新清单的安装包信息无效');
    }
    const identity = entry.platform + ':' + entry.arch;
    if (identities.has(identity)) throw new Error('更新清单包含重复平台安装包');
    identities.add(identity);
    const url = installerUrl(entry.downloadUrl, String(entry.platform));
    if (typeof entry.minOsVersion === 'string') osParts(entry.minOsVersion);
    if (entry.platform === info.platform && entry.arch === info.arch &&
        (entry.minOsVersion === undefined || meetsMinimum(info.osVersion, entry.minOsVersion as string))) selected = url;
  }
  if ((data.versionCode as number) <= info.versionCode || !selected) return { updateAvailable: false };
  return { updateAvailable: true, versionName: data.versionName, notes: data.notes, downloadUrl: selected };
}
