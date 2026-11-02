import { fetchAppUpdate } from '@/api/update';
import { parseUpdateResult, type AppUpdateInfo } from '@/domain/settings/app-update';

/**
 * 请求更新信息并校验平台、构建号及下载地址，返回页面可展示的更新结果。
 * @param info 当前安装版本与设备信息。
 * @throws 请求失败或响应不符合更新契约时抛出错误。
 */
export async function checkAppUpdate(info: AppUpdateInfo) {
  return parseUpdateResult(await fetchAppUpdate(info), info);
}
