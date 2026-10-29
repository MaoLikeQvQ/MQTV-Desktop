import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { AppUpdateInfo } from '@/domain/settings/app-update';

/** 判断当前页面是否运行在 Tauri 桌面容器中。 */
export { isTauri as isDesktop };
/** 读取原生平台、系统版本、应用标识和构建号，作为更新检查参数。 */
export const readAppUpdateInfo = () => invoke<AppUpdateInfo>('app_update_info');
/** 读取系统可用并行度，供搜索调度计算并发上限。 */
export const readSearchParallelism = () => invoke<number>('search_parallelism');
/** 使用系统默认浏览器打开外部链接，调用方负责校验业务地址。 */
export const openExternalUrl = openUrl;

/** 读取桌面窗口是否处于占满设备屏幕的系统全屏状态。 */
export const readScreenFullscreen = () => getCurrentWindow().isFullscreen();
/** 进入或退出系统全屏；失败时向调用方传递错误，不回退成窗口内铺满。 */
export const setScreenFullscreen = (fullscreen: boolean) => getCurrentWindow().setFullscreen(fullscreen);
