import { DESKTOP_UPDATE_URL } from '@/config/services';
import { requestJson } from '@/utils/request';

/** 返回 GitHub 最新正式发布条目的桌面更新清单地址，不上传设备参数。 */
export function updateCheckUrl(): string {
  return DESKTOP_UPDATE_URL;
}
/** 读取 GitHub Release 附件中的更新清单，平台和下载地址由领域层校验。 */
export const fetchAppUpdate = () => requestJson(updateCheckUrl());
