import { setPlaybackRevision } from '@/platform/playback-request';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Vod, TitleGroup } from '@/domain/search/search';
import type { PlaybackRecord } from '@/domain/history/history';

export type PlayerSelection = { vod: Vod; group: TitleGroup | null; resume?: PlaybackRecord; resource: string };
export type PlayerRequest = { revision: number; selection: PlayerSelection };

/** 判断当前入口是否为独立播放窗口；仅固定内部入口使用此标记。 */
export function isPlayerWindow(): boolean { return window.location.hash === '#player'; }

/** 主窗口打开或复用唯一播放窗口，参数通过原生命令传递，不写入 URL。 */
export function openPlayerWindow(selection: PlayerSelection): Promise<void> {
  return invoke('player_window_open', { selection });
}

/**
 * 先监听再读取待播影片，处理窗口加载期间的点击；只接受更新版本，避免握手结果覆盖新事件。
 * 卸载立即失效，迟到的监听注册成功也会释放，兼容 StrictMode 重挂载。
 */
export function connectPlayerWindow(onSelection: (selection: PlayerSelection) => void, onError: (error: unknown) => void): () => void {
  let disposed = false;
  let latest = 0;
  let unlisten: (() => void) | undefined;
  /** 同一窗口只接收一次最新的影片选择。 */
  function receive(request: PlayerRequest | null): void {
    if (disposed || !request || request.revision <= latest) return;
    latest = request.revision;
    setPlaybackRevision(request.revision);
    onSelection(request.selection);
  }
  void (async () => {
    try {
      unlisten = await listen<PlayerRequest>('player-selection', event => receive(event.payload));
      if (disposed) { unlisten(); return; }
      receive(await invoke<PlayerRequest | null>('player_window_ready'));
    } catch (error) { if (!disposed) onError(error); }
  })();
  return () => { disposed = true; unlisten?.(); };
}

/** 原生合并单条播放历史或删除指定记录，并广播给所有窗口。 */
export function updatePlaybackHistory(record?: PlaybackRecord, removeId?: string): Promise<void> {
  return invoke('storage_history_update', { record, removeId });
}
