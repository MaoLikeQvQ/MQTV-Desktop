//! 应用本机 SQLite 与文件存储；凭证不经过系统凭证服务或前端。
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, AeadCore, OsRng, Payload, rand_core::RngCore},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Mutex, MutexGuard, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

static DATABASE: OnceLock<Mutex<Database>> = OnceLock::new();
static EXIT_LISTENERS: Mutex<std::collections::BTreeSet<String>> =
    Mutex::new(std::collections::BTreeSet::new());
static EXIT_PENDING: Mutex<Option<std::collections::BTreeSet<String>>> = Mutex::new(None);
static EXIT_GUARD: AtomicBool = AtomicBool::new(false);
const IMAGE_LIMIT: u64 = 128 * 1024 * 1024;
const MAX_IMAGE: usize = 4 * 1024 * 1024;

pub(crate) struct Database {
    connection: Connection,
    root: PathBuf,
}

/// Unix 使用私有目录权限，Windows 沿用用户本机应用目录的访问控制。
pub(crate) fn private_dir(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| "无法创建应用数据目录".into())
}

/// 写入完整的同目录临时文件并同步后原子替换，错误不覆盖已有文件。
pub(crate) fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("应用文件路径无效")?;
    private_dir(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建应用临时文件")?;
    temp.write_all(bytes).map_err(|_| "无法写入应用文件")?;
    temp.as_file().sync_all().map_err(|_| "无法同步应用文件")?;
    temp.persist(path).map_err(|_| "无法替换应用文件")?;
    Ok(())
}

impl Database {
    /// 打开 bundled SQLite；仅迁移已知版本，不覆盖更高版本或损坏的数据库。
    pub(crate) fn open(root: PathBuf) -> Result<Self, String> {
        private_dir(&root)?;
        let path = root.join("mqtv.db");
        let connection = Connection::open(&path).map_err(|_| "无法打开本地数据库")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|_| "无法设置数据库权限")?;
        }
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| "无法配置数据库锁等待")?;
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|_| "无法读取数据库版本")?;
        if version > 1 {
            return Err("本地数据库版本较新，请使用更新的软件".into());
        }
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, payload BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS images (
                url TEXT PRIMARY KEY, hash TEXT NOT NULL, mime TEXT NOT NULL,
                size INTEGER NOT NULL, accessed INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS images_accessed ON images(accessed);
            PRAGMA user_version=1;
            COMMIT;",
            )
            .map_err(|_| "无法初始化本地数据库")?;
        Ok(Self { connection, root })
    }

    fn snapshot(&self) -> Result<BTreeMap<String, String>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT key,value FROM settings ORDER BY key")
            .map_err(|_| "无法读取本地设置")?;
        statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| "无法读取本地设置")?
            .collect::<rusqlite::Result<_>>()
            .map_err(|_| "本地设置格式无效".into())
    }

    /// 原子导入旧浏览器设置一次；现有数据库值优先，失败不记录完成标志。
    fn import(
        &mut self,
        entries: BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, String>, String> {
        if entries.keys().any(|key| !key.starts_with("mqtv-")) {
            return Err("只能迁移 MQTV 本地设置".into());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "无法开始本地数据迁移")?;
        let done = transaction
            .query_row(
                "SELECT value FROM metadata WHERE key='browser-import-v1'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| "无法读取迁移状态")?
            .is_some();
        if !done {
            for (key, value) in entries {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO settings(key,value) VALUES(?1,?2)",
                        params![key, value],
                    )
                    .map_err(|_| "无法迁移本地设置")?;
            }
            transaction
                .execute(
                    "INSERT INTO metadata(key,value) VALUES('browser-import-v1','complete')",
                    [],
                )
                .map_err(|_| "无法保存迁移状态")?;
        }
        transaction.commit().map_err(|_| "无法提交本地数据迁移")?;
        self.snapshot()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        if !key.starts_with("mqtv-") {
            return Err("本地设置键无效".into());
        }
        self.connection.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value]).map_err(|_| "无法保存本地设置")?;
        Ok(())
    }

    /// 多键更新同一事务提交，删除使用 None；不向前端开放任意 SQL。
    fn apply(&mut self, entries: BTreeMap<String, Option<String>>) -> Result<(), String> {
        if entries.keys().any(|key| !key.starts_with("mqtv-")) {
            return Err("本地设置键无效".into());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "无法开始本地设置事务")?;
        for (key, value) in entries {
            match value {
                Some(value) => {
                    transaction.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map_err(|_| "无法保存本地设置")?;
                }
                None => {
                    transaction
                        .execute("DELETE FROM settings WHERE key=?1", [key])
                        .map_err(|_| "无法删除本地设置")?;
                }
            }
        }
        transaction
            .commit()
            .map_err(|_| "无法提交本地设置事务".into())
    }

    /// 持有数据库互斥锁时合并单条历史，避免两个窗口整份 JSON 互相覆盖。
    fn history_update(
        &self,
        record: Option<serde_json::Value>,
        remove_id: Option<String>,
    ) -> Result<String, String> {
        const KEY: &str = "mqtv-playback-history-v1";
        let current = self.snapshot()?.remove(KEY);
        let mut records: Vec<serde_json::Value> = match current {
            Some(value) => {
                serde_json::from_str(&value).map_err(|_| "本地播放历史损坏，已保留原数据")?
            }
            None => vec![],
        };
        if let Some(mut record) = record {
            let id = record["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("播放记录标识无效")?
                .to_string();
            if record["vod"]["vod_name"].as_str().is_none()
                || record["target"].as_object().is_none()
            {
                return Err("播放记录内容无效".into());
            }
            if record["vod"]["vod_pic"]
                .as_str()
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                if let Some(old) = records.iter().find(|old| old["id"] == id) {
                    record["vod"]["vod_pic"] = old["vod"]["vod_pic"].clone();
                }
            }
            records.retain(|old| old["id"] != id);
            records.insert(0, record);
            records.truncate(200);
        }
        if let Some(id) = remove_id {
            records.retain(|old| old["id"] != id);
        }
        let value = serde_json::to_string(&records).map_err(|_| "播放历史编码失败")?;
        self.set(KEY, &value)?;
        Ok(value)
    }

    /// 已有密文时绝不生成替代密钥；丢失、损坏和读取失败均明确拒绝解密。
    fn key(&self) -> Result<[u8; 32], String> {
        let dir = self.root.join("keys");
        let path = dir.join("local.key");
        match fs::read(&path) {
            Ok(bytes) => return bytes.try_into().map_err(|_| "本地凭证密钥损坏".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法读取本地凭证密钥".into()),
        }
        let count: i64 = self
            .connection
            .query_row("SELECT count(*) FROM secrets", [], |r| r.get(0))
            .map_err(|_| "无法检查本地凭证")?;
        if count != 0 {
            return Err("本地凭证密钥丢失，请恢复密钥后重试".into());
        }
        private_dir(&dir)?;
        let mut key = [0; 32];
        OsRng
            .try_fill_bytes(&mut key)
            .map_err(|_| "无法生成凭证密钥")?;
        let mut temp = tempfile::NamedTempFile::new_in(&dir).map_err(|_| "无法创建凭证密钥")?;
        temp.write_all(&key).map_err(|_| "无法保存凭证密钥")?;
        temp.as_file().sync_all().map_err(|_| "无法同步凭证密钥")?;
        match temp.persist_noclobber(&path) {
            Ok(_) => Ok(key),
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => fs::read(path)
                .map_err(|_| "无法读取本地凭证密钥")?
                .try_into()
                .map_err(|_| "本地凭证密钥损坏".into()),
            Err(_) => Err("无法安装凭证密钥".into()),
        }
    }

    fn secret_load(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let payload: Option<Vec<u8>> = self
            .connection
            .query_row("SELECT payload FROM secrets WHERE name=?1", [name], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|_| "无法读取加密凭证")?;
        let Some(payload) = payload else {
            return Ok(None);
        };
        if payload.len() < 29 || payload[0] != 1 {
            return Err("本地凭证格式无效".into());
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key()?).map_err(|_| "本地凭证密钥无效")?;
        cipher
            .decrypt(
                Nonce::from_slice(&payload[1..13]),
                Payload {
                    msg: &payload[13..],
                    aad: name.as_bytes(),
                },
            )
            .map(Some)
            .map_err(|_| "本地凭证解密失败，数据或密钥已变化".into())
    }

    fn secret_save(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        // 即使是替换授权，也先验证已有密文，防止丢失密钥后静默覆盖。
        self.secret_load(name)?;
        let first: Option<String> = self
            .connection
            .query_row("SELECT name FROM secrets ORDER BY name LIMIT 1", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|_| "无法检查凭证密钥")?;
        if let Some(first) = first {
            if first != name {
                self.secret_load(&first)?;
            }
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key()?).map_err(|_| "本地凭证密钥无效")?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let encrypted = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: bytes,
                    aad: name.as_bytes(),
                },
            )
            .map_err(|_| "本地凭证加密失败")?;
        let mut payload = vec![1];
        payload.extend_from_slice(&nonce);
        payload.extend(encrypted);
        self.connection.execute("INSERT INTO secrets(name,payload) VALUES(?1,?2) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload",
            params![name, payload]).map_err(|_| "无法保存加密凭证")?;
        Ok(())
    }

    fn read_image(&mut self, url: &str) -> Result<Option<CachedImage>, String> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "无法读取图片缓存")?;
        let row: Option<(String, String)> = transaction
            .query_row("SELECT hash,mime FROM images WHERE url=?1", [url], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
            .map_err(|_| "无法读取图片索引")?;
        let Some((hash, mime)) = row else {
            return Ok(None);
        };
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("图片缓存索引无效".into());
        }
        let path = self.root.join("cache/images").join(&hash);
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                transaction
                    .execute("DELETE FROM images WHERE url=?1", [url])
                    .map_err(|_| "无法移除失效图片索引")?;
                transaction.commit().map_err(|_| "无法更新图片缓存")?;
                return Ok(None);
            }
            Err(_) => return Err("无法读取图片缓存文件".into()),
        };
        if bytes.is_empty()
            || bytes.len() > MAX_IMAGE
            || format!("{:x}", Sha256::digest(&bytes)) != hash
        {
            return Err("图片缓存内容损坏".into());
        }
        transaction
            .execute(
                "UPDATE images SET accessed=?2 WHERE url=?1",
                params![url, timestamp()],
            )
            .map_err(|_| "无法更新图片缓存访问时间")?;
        transaction.commit().map_err(|_| "无法更新图片缓存")?;
        Ok(Some(CachedImage { bytes, mime }))
    }

    fn write_image(
        &mut self,
        url: &str,
        bytes: &[u8],
        mime: &str,
        limit: u64,
    ) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() > MAX_IMAGE || bytes.len() as u64 > limit {
            return Err("缓存图片大小无效".into());
        }
        // 旧版缓存可使用空 MIME；下载路径已有图片类型与响应大小校验。
        if !mime.is_empty()
            && !matches!(
                mime.split(';').next(),
                Some("image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif")
            )
        {
            return Err("缓存图片格式不支持".into());
        }
        let hash = format!("{:x}", Sha256::digest(bytes));
        let dir = self.root.join("cache/images");
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "无法开始图片缓存写入")?;
        write_file(&dir.join(&hash), bytes)?;
        transaction.execute("INSERT INTO images(url,hash,mime,size,accessed) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(url) DO UPDATE SET hash=excluded.hash,mime=excluded.mime,size=excluded.size,accessed=excluded.accessed",
            params![url,hash,mime,bytes.len() as i64,timestamp()]).map_err(|_| "无法保存图片索引")?;
        let mut total: i64 = transaction
            .query_row("SELECT coalesce(sum(size),0) FROM images", [], |r| r.get(0))
            .map_err(|_| "无法统计图片缓存")?;
        while total > limit as i64 {
            let (old_url, size): (String, i64) = transaction
                .query_row(
                    "SELECT url,size FROM images ORDER BY accessed,url LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|_| "无法选择过期图片缓存")?;
            transaction
                .execute("DELETE FROM images WHERE url=?1", [old_url])
                .map_err(|_| "无法清理图片缓存索引")?;
            total -= size;
        }
        transaction.commit().map_err(|_| "无法提交图片缓存")?;
        // 索引先提交，再持有新的写锁回收孤立文件；提交失败不会删除仍被旧索引引用的文件。
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "无法开始图片缓存清理")?;
        let mut statement = transaction
            .prepare("SELECT DISTINCT hash FROM images")
            .map_err(|_| "无法读取图片索引")?;
        let retained = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|_| "无法读取图片索引")?
            .collect::<rusqlite::Result<std::collections::HashSet<_>>>()
            .map_err(|_| "图片索引无效")?;
        drop(statement);
        for entry in fs::read_dir(&dir).map_err(|_| "无法读取图片缓存目录")? {
            let entry = entry.map_err(|_| "无法读取图片缓存文件")?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.len() == 64
                && name.bytes().all(|b| b.is_ascii_hexdigit())
                && !retained.contains(name.as_ref())
            {
                fs::remove_file(entry.path()).map_err(|_| "无法删除过期图片缓存文件")?;
            }
        }
        transaction.commit().map_err(|_| "无法提交图片缓存")?;
        Ok(())
    }
}

fn timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

/// 在窗口开始调用命令前初始化本机目录，Windows 使用 LocalAppData。
pub(crate) fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法定位本机应用数据目录")?;
    let database = Database::open(root)?;
    DATABASE
        .set(Mutex::new(database))
        .map_err(|_| "本地数据库已初始化".to_string())
}

fn database() -> Result<MutexGuard<'static, Database>, String> {
    DATABASE
        .get()
        .ok_or("本地数据库尚未初始化")?
        .lock()
        .map_err(|_| "本地数据库锁异常".into())
}

pub(crate) fn data_root() -> Result<PathBuf, String> {
    Ok(database()?.root.clone())
}
pub(crate) fn secret_load(name: &str) -> Result<Option<Vec<u8>>, String> {
    database()?.secret_load(name)
}
pub(crate) fn secret_save(name: &str, bytes: &[u8]) -> Result<(), String> {
    database()?.secret_save(name, bytes)
}

/// 仅供显式真实账号测试初始化独立目录，不自动读取实际应用数据。
#[cfg(test)]
pub(crate) fn init_smoke() {
    DATABASE.get_or_init(|| {
        let root = PathBuf::from(
            std::env::var_os("MQTV_TEST_DATA_DIR")
                .expect("set MQTV_TEST_DATA_DIR to an authorized absolute test data directory"),
        );
        assert!(root.is_absolute());
        Mutex::new(Database::open(root).expect("open test database"))
    });
}

/// 前端退出监听注册成功后才启用，启动失败时仍允许正常退出。
#[tauri::command]
pub(crate) fn storage_enable_exit_guard(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    EXIT_LISTENERS
        .lock()
        .map_err(|_| "退出监听状态异常")?
        .insert(window.label().to_string());
    EXIT_GUARD.store(true, Ordering::Release);
    let pending = {
        let mut pending = EXIT_PENDING.lock().map_err(|_| "退出状态异常")?;
        if let Some(labels) = pending.as_mut() {
            labels.insert(window.label().to_string());
            true
        } else {
            false
        }
    };
    if pending {
        app.emit("storage-exit-requested", ())
            .map_err(|_| "无法通知新窗口保存数据")?;
    }
    Ok(())
}

pub(crate) fn exit_guard_enabled() -> bool {
    EXIT_GUARD.load(Ordering::Acquire)
}

/// 记录退出时的全部窗口，重复请求保留尚未确认的窗口集合。
pub(crate) fn begin_exit(app: &tauri::AppHandle) {
    if let Ok(mut pending) = EXIT_PENDING.lock() {
        if pending.is_none() {
            let listeners = EXIT_LISTENERS
                .lock()
                .map(|labels| labels.clone())
                .unwrap_or_default();
            *pending = Some(
                app.webview_windows()
                    .into_keys()
                    .filter(|label| listeners.contains(label))
                    .collect(),
            );
        }
    }
}

/// 每个窗口完成各自写队列后确认；所有参与窗口确认后才退出应用。
#[tauri::command]
pub(crate) fn storage_exit_ready(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    acknowledge_exit(&app, window.label());
}

pub(crate) fn window_destroyed(app: &tauri::AppHandle, label: &str) {
    if let Ok(mut labels) = EXIT_LISTENERS.lock() {
        labels.remove(label);
    }
    acknowledge_exit(app, label);
}

fn acknowledge_exit(app: &tauri::AppHandle, label: &str) {
    let complete = if let Ok(mut pending) = EXIT_PENDING.lock() {
        if let Some(labels) = pending.as_mut() {
            labels.remove(label);
            labels.is_empty()
        } else {
            false
        }
    } else {
        false
    };
    if complete {
        app.exit(0);
    }
}

/// 任一窗口保存失败时取消整次退出，其他窗口恢复可编辑状态。
#[tauri::command]
pub(crate) fn storage_exit_cancel(app: tauri::AppHandle) -> Result<(), String> {
    *EXIT_PENDING.lock().map_err(|_| "退出状态异常")? = None;
    app.emit("storage-exit-cancelled", ())
        .map_err(|_| "无法取消应用退出".into())
}

/// 前端已完成保存或用户明确放弃后退出；显式退出码绕过二次保存请求。
#[tauri::command]
pub(crate) fn storage_exit(app: tauri::AppHandle) {
    app.exit(0);
}

/// 将 SQLite 锁等待和文件读写放到阻塞线程，不占用窗口事件线程。
async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "本地存储任务异常")?
}

/// 返回普通设置快照；加密凭证表不提供给前端。
#[tauri::command]
pub(crate) async fn storage_snapshot() -> Result<BTreeMap<String, String>, String> {
    blocking(|| database()?.snapshot()).await
}
/// 首次启动迁移浏览器中的 MQTV 键，数据库已有数据优先。
#[tauri::command]
pub(crate) async fn storage_import(
    entries: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    blocking(move || database()?.import(entries)).await
}
/// 一组设置以事务提交，避免订阅状态出现部分保存。
#[tauri::command]
pub(crate) async fn storage_apply(
    app: tauri::AppHandle,
    entries: BTreeMap<String, Option<String>>,
) -> Result<(), String> {
    blocking(move || {
        let mut db = database()?;
        db.apply(entries.clone())?;
        app.emit("storage-values-changed", entries)
            .map_err(|_| "本地数据已保存，但窗口同步失败".to_string())?;
        Ok(())
    })
    .await
}
/// 保存普通设置或业务缓存，SQL 参数绑定，不接受任意 SQL 或文件路径。
#[tauri::command]
pub(crate) async fn storage_set(key: String, value: String) -> Result<(), String> {
    blocking(move || database()?.set(&key, &value)).await
}

/// 历史更新由原生按单条合并，主窗口删除和播放器进度写入不会覆盖其他影片记录。
#[tauri::command]
pub(crate) async fn storage_history_update(
    app: tauri::AppHandle,
    record: Option<serde_json::Value>,
    remove_id: Option<String>,
) -> Result<(), String> {
    blocking(move || {
        let db = database()?;
        let value = db.history_update(record, remove_id)?;
        app.emit(
            "storage-values-changed",
            BTreeMap::from([("mqtv-playback-history-v1", Some(value))]),
        )
        .map_err(|_| "历史已保存，但窗口同步失败".to_string())?;
        Ok(())
    })
    .await
}

#[derive(Serialize)]
pub(crate) struct CachedImage {
    bytes: Vec<u8>,
    mime: String,
}
/// 读取文件图片并更新 SQLite 中的访问时间；文件已缺失视为缓存未命中。
#[tauri::command]
pub(crate) async fn image_cache_read(url: String) -> Result<Option<CachedImage>, String> {
    blocking(move || database()?.read_image(&url)).await
}
/// 写入文件图片及索引，按最近访问时间限制缓存总量为 128 MiB。
#[tauri::command]
pub(crate) async fn image_cache_write(
    url: String,
    bytes: Vec<u8>,
    mime: String,
) -> Result<(), String> {
    blocking(move || database()?.write_image(&url, &bytes, &mime, IMAGE_LIMIT)).await
}

#[cfg(test)]
#[path = "tests/storage.rs"]
mod tests;
