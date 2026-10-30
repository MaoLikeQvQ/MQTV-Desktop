import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type StoredImage = { bytes: number[]; mime: string };

/** 读取 SQLite 中供界面使用的普通业务键值，不返回原生授权凭证。 */
export function readStorageSnapshot(): Promise<Record<string, string>> {
  return invoke('storage_snapshot');
}

/** 首次启动时原子导入旧业务键值；已存在的 SQLite 数据优先，成功后返回完整快照。 */
export function importLegacyStorage(entries: Record<string, string>): Promise<Record<string, string>> {
  return invoke('storage_import', { entries });
}

/** 在单个 SQLite 事务中保存一组业务数据，空值表示删除，失败时整体回滚。 */
export function applyStorageValues(entries: Record<string, string | null>): Promise<void> {
  return invoke('storage_apply', { entries });
}

/** 监听其他窗口已提交的普通设置，原生层按事务顺序广播，不包含凭证。 */
export function listenStorageChanges(receive: (entries: Record<string, string | null>) => void): Promise<UnlistenFn> {
  return listen<Record<string, string | null>>('storage-values-changed', event => receive(event.payload));
}

/** 读取文件图片缓存并更新 SQLite 中的访问时间，未命中时返回空。 */
export function readImageCache(url: string): Promise<StoredImage | null> {
  return invoke('image_cache_read', { url });
}

/** 保存图片文件与 SQLite 索引，由原生层按容量淘汰旧图片。 */
export function writeImageCache(url: string, bytes: number[], mime: string): Promise<void> {
  return invoke('image_cache_write', { url, bytes, mime });
}

/**
 * 正常关窗和系统退出均先等待 SQLite 写入；全部监听注册成功后才启用原生退出保护。
 * 保存失败保留窗口；监听或保护启用失败时清理已注册监听，并阻止应用继续启动。
 */
export async function installStorageCloseGuard(hasPending: () => boolean, flush: () => Promise<void>, reportCloseError: () => void, exitWrites?: { freeze: () => void; resume: () => void }): Promise<() => void> {
  const current = getCurrentWindow();
  let closingApproved = false;
  const unlistenClose = await current.onCloseRequested(async event => {
    if (closingApproved) return;
    window.dispatchEvent(new Event('mqtv-before-close'));
    if (!hasPending()) return;
    event.preventDefault();
    try { await flush(); }
    catch { return; /* 保存错误已由持久提示显示；保留窗口供用户重试。 */ }
    closingApproved = true;
    try { await current.close(); }
    catch { closingApproved = false; reportCloseError(); }
  });
  let unlistenExit: UnlistenFn | undefined;
  let unlistenCancelled: UnlistenFn | undefined;
  try {
    unlistenExit = await listen('storage-exit-requested', async () => {
      window.dispatchEvent(new Event('mqtv-before-close'));
      exitWrites?.freeze();
      try { await flush(); }
      catch {
        exitWrites?.resume();
        try { await invoke('storage_exit_cancel'); } catch { reportCloseError(); }
        return;
      }
      try { await invoke('storage_exit_ready'); }
      catch {
        exitWrites?.resume(); reportCloseError();
        try { await invoke('storage_exit_cancel'); } catch { reportCloseError(); }
      }
    });
    unlistenCancelled = await listen('storage-exit-cancelled', () => { exitWrites?.resume(); });
    await invoke('storage_enable_exit_guard');
    return () => { unlistenClose(); unlistenExit?.(); unlistenCancelled?.(); };
  } catch (reason) {
    unlistenClose();
    unlistenExit?.();
    unlistenCancelled?.();
    throw reason;
  }
}

/** 仅在用户明确选择放弃未保存更改时退出整个应用，跳过失败的写队列。 */
export async function closeDiscardingPendingStorage(): Promise<void> {
  await invoke('storage_exit');
}
