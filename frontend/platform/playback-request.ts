import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
let revision: number | undefined;

/** 更新独立播放窗口的任务代际；迟到请求只能访问其发起时所属的代际。 */
export function setPlaybackRevision(value: number): void { revision = value; }

/** 请求携带当前影片代际，原生关闭或切片后拒绝旧请求；主窗口不附加代际。 */
export function invokePlayback<T>(command: string, args?: InvokeArgs): Promise<T> {
  return invoke<T>(command, revision === undefined ? args : { ...args, playbackRevision: revision });
}
