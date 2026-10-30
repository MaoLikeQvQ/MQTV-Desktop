import { isDesktop } from '@/platform/desktop';
import { importLegacyStorage, readStorageSnapshot, applyStorageValues } from '@/platform/storage';

type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type LegacyStorage = StorageAccess & Pick<Storage, 'length' | 'key'>;
type StorageDependencies = {
  snapshot: () => Promise<Record<string, string>>;
  migrate: (entries: Record<string, string>) => Promise<Record<string, string>>;
  apply: (entries: Record<string, string | null>) => Promise<void>;
};

/**
 * 创建 SQLite 的界面内存快照及有序写队列。先初始化再读取；失败保留待写项并通知订阅者。
 * 同步 setItem 只更新运行中的快照，flush 成功才代表所有待写数据已落盘。
 */
export function createApplicationStorage(dependencies: StorageDependencies) {
  let values = new Map<string, string>();
  const pending = new Map<string, string | null>();
  const versions = new Map<string, number>();
  let nextVersion = 0;
  const queue: { run: () => Promise<void>; batch?: Map<string, string | null>; version: number }[] = [];
  let ready = false;
  let frozen = false;
  const deferredChanges = new Map<string, string | null>();
  const incoming: Record<string, string | null>[] = [];
  let running: Promise<void> | undefined;
  let failure: Error | null = null;
  const listeners = new Set<() => void>();
  /** 通知界面更新持久错误提示和未保存状态。 */
  function notify(): void { for (const listener of listeners) listener(); }
  /** 合并其他窗口已提交的数据，不覆盖当前窗口尚未落盘的编辑。 */
  function receiveChanges(entries: Record<string, string | null>): void {
    if (!ready) { incoming.push(entries); return; }
    let changed = false;
    for (const [key, value] of Object.entries(entries)) {
      if (!key.startsWith('mqtv-')) continue;
      if (pending.has(key)) { deferredChanges.set(key, value); continue; }
      if ((values.get(key) ?? null) === value) continue;
      if (value === null) values.delete(key); else values.set(key, value);
      changed = true;
    }
    if (changed) notify();
  }
  /** 在单个有序队列中写入，失败时停止，待显式重试后继续。 */
  function startWriting(): Promise<void> {
    if (running) return running;
    if (failure || !queue.length) return Promise.resolve();
    running = (async () => {
      while (queue.length && !failure) {
        const task = queue[0];
        try {
          await task.run();
          queue.shift();
          if (task.batch) for (const [key] of task.batch) {
            if (versions.get(key) !== task.version) continue;
            pending.delete(key);
            versions.delete(key);
          }
          const settled: Record<string, string | null> = {};
          for (const [key, value] of deferredChanges) {
            if (pending.has(key)) continue;
            settled[key] = value;
            deferredChanges.delete(key);
          }
          receiveChanges(settled);
        } catch {
          failure = new Error('本地数据库保存失败，部分更改尚未保存。请检查磁盘空间和目录权限后重试。');
          notify();
        }
      }
    })().finally(() => {
      running = undefined;
      if (!failure && queue.length) void startWriting();
    });
    return running;
  }
  /** 拒绝未初始化、退出冻结及尚未处理的保存失败，避免静默接受无法持久化的操作。 */
  function assertWritable(): void {
    if (!ready) throw new Error('本地数据库尚未初始化');
    if (frozen) throw new Error('应用正在退出，请等待本地数据保存完成');
    if (failure) throw failure;
  }
  /** 将不可合并的原生操作排入同一个队列，失败保留原操作供显式重试。 */
  function enqueueOperation(operation: () => Promise<void>): void {
    assertWritable();
    queue.push({ run: operation, version: ++nextVersion });
    void startWriting();
  }
  /** 将一组变更同时更新到快照并排入同一事务，空值代表删除。 */
  function setItems(entries: Record<string, string | null>): void {
    assertWritable();
    for (const key of Object.keys(entries)) if (!key.startsWith('mqtv-')) throw new Error('不支持此本地数据键');
    const batch = new Map<string, string | null>();
    const version = ++nextVersion;
    for (const [key, value] of Object.entries(entries)) {
      if ((values.get(key) ?? null) === value) continue;
      if (value === null) values.delete(key); else values.set(key, value);
      pending.set(key, value);
      versions.set(key, version);
      batch.set(key, value);
    }
    if (batch.size) queue.push({ run: () => dependencies.apply(Object.fromEntries(batch)), batch, version });
    notify();
    void startWriting();
  }
  return {
    /** 主窗口导入旧业务数据；播放窗口仅恢复 SQLite，避免提前标记空迁移完成。 */
    async initialize(legacy?: LegacyStorage): Promise<void> {
      if (ready) return;
      let snapshot = await dependencies.snapshot();
      if (legacy) {
        const entries: Record<string, string> = {};
        for (let index = 0; index < legacy.length; index++) {
          const key = legacy.key(index);
          if (!key?.startsWith('mqtv-')) continue;
          const value = legacy.getItem(key);
          if (value !== null) entries[key] = value;
        }
        snapshot = await dependencies.migrate(entries);
      }
      values = new Map(Object.entries(snapshot));
      ready = true;
      for (const entries of incoming.splice(0)) receiveChanges(entries);
    },
    receiveChanges,
    enqueueOperation,
    /** 开始全应用退出时拒绝新增编辑，已有队列仍可继续保存。 */
    freezeWrites(): void { frozen = true; notify(); },
    /** 保存或退出失败后解除冻结，原有保存错误仍需显式重试。 */
    resumeWrites(): void { frozen = false; notify(); },
    /** 供播放进度等后台更新跳过退出期间的非必要新写入。 */
    isFrozen(): boolean { return frozen; },
    /** 从已初始化的内存快照读取，保证组件首次渲染即可恢复持久数据。 */
    getItem(key: string): string | null {
      if (!ready) throw new Error('本地数据库尚未初始化');
      return values.get(key) ?? null;
    },
    /** 更新快照并安排有序落盘；已有写入错误时拒绝继续修改，避免无声丢失。 */
    setItem(key: string, value: string): void { setItems({ [key]: value }); },
    /** 删除普通业务数据，并安排同一队列持久化删除操作。 */
    removeItem(key: string): void { setItems({ [key]: null }); },
    setItems,
    /** 等待所有已安排写入完成；保存失败时向关闭窗口流程报告错误。 */
    async flush(): Promise<void> {
      while (running || (!failure && queue.length)) await (running ?? startWriting());
      if (failure) throw failure;
    },
    /** 显式重试仍未落盘的数据，成功后解除错误并允许继续保存。 */
    async retry(): Promise<void> {
      failure = null;
      notify();
      await startWriting();
      if (failure) throw failure;
      notify();
    },
    /** 关窗命令失败时保持可见提示，避免误以为程序已经退出。 */
    reportCloseError(): void {
      failure = new Error('本地数据已保存，但关闭窗口失败，请重试退出。');
      notify();
    },
    /** 读取最新的持久化失败状态，供全局错误提示使用。 */
    getError(): Error | null { return failure; },
    /** 返回是否仍有未落盘数据，供正常关窗时决定是否等待。 */
    hasPending(): boolean { return queue.length > 0; },
    /** 订阅普通数据或保存错误变化，返回卸载函数。 */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const desktopStorage = createApplicationStorage({ snapshot: readStorageSnapshot, migrate: importLegacyStorage, apply: applyStorageValues });

/** 桌面业务统一读写 SQLite；Web 开发预览继续使用浏览器本地存储。 */
export const applicationStorage: StorageAccess = {
  /** 根据当前平台读取持久数据快照。 */
  getItem(key) { return isDesktop() ? desktopStorage.getItem(key) : localStorage.getItem(key); },
  /** 根据当前平台保存数据，桌面后台失败由全局持久提示呈现。 */
  setItem(key, value) { if (isDesktop()) desktopStorage.setItem(key, value); else localStorage.setItem(key, value); },
  /** 根据当前平台删除一项业务数据。 */
  removeItem(key) { if (isDesktop()) desktopStorage.removeItem(key); else localStorage.removeItem(key); },
};
