import { fetchImageBytes } from '@/api/images';
import { isDesktop } from '@/platform/desktop';
import { readImageCache, writeImageCache, type StoredImage } from '@/platform/storage';
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
function createBrowserImageStorage(limit = IMAGE_CACHE_LIMIT): CoverStorage {
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
type FileImageDependencies = {
  read: (url: string) => Promise<StoredImage | null>;
  write: (url: string, bytes: number[], mime: string) => Promise<void>;
};

/**
 * 创建原生文件图片缓存，SQLite 管理索引；未命中时逐张迁移旧 IndexedDB，不删除旧图片。
 * 迁移失败会保留旧记录，下次仍可重试；新图片只写入原生缓存。
 */
export function createFileImageStorage(legacy: CoverStorage, dependencies: FileImageDependencies, limit = IMAGE_CACHE_LIMIT): CoverStorage {
  return {
    /** 优先读取原生缓存，只有对应图片未命中时才读取并迁移一项旧缓存。 */
    async read(url) {
      const entry = await dependencies.read(url);
      if (entry) return new Blob([new Uint8Array(entry.bytes)], { type: entry.mime });
      const blob = await legacy.read(url);
      if (!blob || blob.size > limit) return null;
      await dependencies.write(url, Array.from(new Uint8Array(await blob.arrayBuffer())), blob.type);
      return blob;
    },
    /** 将新图片写入文件，原生层负责 SQLite 索引与 128 MiB 容量淘汰。 */
    async write(url, blob) {
      if (blob.size > limit) return;
      await dependencies.write(url, Array.from(new Uint8Array(await blob.arrayBuffer())), blob.type);
    },
  };
}

/** 桌面使用原生文件缓存和 SQLite 索引，浏览器预览保留原 IndexedDB 存储。 */
export function createImageStorage(limit = IMAGE_CACHE_LIMIT): CoverStorage {
  const browser = createBrowserImageStorage(limit);
  return isDesktop() ? createFileImageStorage(browser, { read: readImageCache, write: writeImageCache }, limit) : browser;
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
