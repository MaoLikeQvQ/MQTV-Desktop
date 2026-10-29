import { fetchImageBytes } from '@/api/images';
import { createCoverCache, type CoverStorage } from '@/domain/discovery/discovery-cache';

const DB_NAME = 'mqtv-images';
const STORE = 'images';
export const IMAGE_CACHE_LIMIT = 128 * 1024 * 1024;
type Entry = { url: string; bytes: ArrayBuffer; mime: string; accessedAt: number };

// Store inline bytes: WebKit can lose file-backed IndexedDB Blobs across browser restarts.
/**
 * 创建 IndexedDB 图片存储，使用原始字节持久化并按访问顺序清理超额数据。
 * @param limit 持久缓存的字节上限，默认 128 MiB。
 * @returns 图片读取与写入方法。
 */
export function createImageStorage(limit = IMAGE_CACHE_LIMIT): CoverStorage {
  let database: Promise<IDBDatabase> | undefined;
  /** 复用数据库连接；初始化图片表及访问时间索引，失败后允许重新连接。 */
  function open(): Promise<IDBDatabase> {
    if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'url' });
        store.createIndex('accessedAt', 'accessedAt');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('图片缓存暂不可用'));
    }).catch(error => { database = undefined; throw error; });
    return database;
  }
  return {
    /** 读取缓存图片并更新访问时间；删除旧格式或无效记录，返回可展示的 Blob。 */
    async read(url) {
      const db = await open();
      return new Promise<Blob | null>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE), request = store.get(url);
        let blob: Blob | null = null;
        request.onsuccess = () => {
          const entry = request.result as Entry | undefined;
          if (entry?.bytes instanceof ArrayBuffer && entry.bytes.byteLength > 0 && entry.bytes.byteLength <= limit) {
            blob = new Blob([entry.bytes], { type: entry.mime });
            store.put({ ...entry, accessedAt: Date.now() });
          } else if (entry) store.delete(url);
        };
        transaction.oncomplete = () => resolve(blob);
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    },
    /** 保存图片字节，并在同一事务中按最久未访问顺序清理超过容量上限的记录。 */
    async write(url, blob) {
      if (blob.size > limit) return;
      const bytes = await blob.arrayBuffer();
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        store.put({ url, bytes, mime: blob.type, accessedAt: Date.now() } satisfies Entry);
        // Oldest first, with all pruning in the same transaction as the new image.
        const entries: { url: string; size: number }[] = [];
        let size = 0;
        const cursor = store.index('accessedAt').openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) {
            const entry = item.value as Entry;
            if (entry.bytes instanceof ArrayBuffer) {
              size += entry.bytes.byteLength;
              entries.push({ url: entry.url, size: entry.bytes.byteLength });
            } else item.delete();
            item.continue();
          } else {
            for (const entry of entries) {
              if (size <= limit) break;
              store.delete(entry.url); size -= entry.size;
            }
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    },
  };
}
const load = createCoverCache(120, createImageStorage());
/**
 * 优先复用内存与持久图片缓存，未命中时下载；并发请求共享同一加载任务。
 * @param url 图片地址，也是图片缓存键。
 * @param direct 是否要求封面直连。
 * @returns 可用于创建页面 object URL 的图片 Blob。
 */
export function loadCachedImage(url: string, direct = false): Promise<Blob> {
  return load(url, address => fetchImageBytes(address, direct));
}
