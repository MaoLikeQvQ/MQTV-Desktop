use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, io::ErrorKind, path::Path};
use tauri::Manager;

// Serialize authorization reads, refreshes, and playback preparation across commands.
pub(super) use mqtv_netdisk::quark::LOCK;

#[derive(Default, Serialize, Deserialize)]
pub(super) struct Settings {
    pub(super) backend: String,
    #[serde(default)]
    pub(super) authorization_code: Option<String>,
    pub(super) lease: Option<Value>,
    #[serde(default)]
    pub(super) saved: std::collections::BTreeMap<String, String>,
}
const SECRET: &str = "quark-authorization";

/// 数据库无授权时迁移旧本地 JSON，成功加密及回读校验后移除明文；不访问系统凭证。
pub(crate) fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let legacy = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位旧应用数据目录")?
        .join("credentials/quark-authorization.json");
    if let Some(settings) = read_legacy(&legacy)? {
        let expected = serde_json::to_vec(&settings).map_err(|_| "授权迁移编码失败")?;
        let stored = crate::storage::secret_load(SECRET)?;
        if stored.is_none() {
            save(&settings)?;
        }
        let restored = crate::storage::secret_load(SECRET)?.ok_or("授权迁移校验失败")?;
        cleanup_legacy(&legacy, &expected, &restored)?;
    }
    Ok(())
}

/// 清理阶段可重复执行；已加密数据与旧文件不一致时保留双方并明确报错。
fn cleanup_legacy(path: &Path, expected: &[u8], restored: &[u8]) -> Result<(), String> {
    if restored != expected {
        return Err("数据库授权与旧明文文件不一致，已保留双方，请先备份并处理旧授权文件".into());
    }
    let current = read_legacy(path)?.ok_or("旧授权文件已变化，请重试迁移")?;
    if serde_json::to_vec(&current).map_err(|_| "旧授权文件编码失败")? != expected {
        return Err("旧授权文件在迁移期间已变化，已保留原文件".into());
    }
    fs::remove_file(path).map_err(|_| "授权已入库，但无法移除旧明文授权文件".into())
}

/// 真实账号测试必须显式指定独立应用数据目录。
#[cfg(test)]
pub(super) fn init_smoke() {
    crate::storage::init_smoke();
}

/// 后台统一使用构建环境配置；切换环境时清除后台租约，保留本地扫码账号及其他字段。
fn normalize(mut settings: Settings) -> Result<Settings, String> {
    let backend = crate::config::backend_url()?.to_string();
    if settings.backend != backend && !settings.lease.as_ref().is_some_and(|l| l["source"] == "local") {
        settings.lease = None;
    }
    settings.backend = backend;
    Ok(settings)
}

fn read_legacy(path: &Path) -> Result<Option<Settings>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            normalize(serde_json::from_slice(&bytes).map_err(|_| "旧本地授权数据无效")?).map(Some)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法读取旧本地授权文件".into()),
    }
}

/// 只读取 SQLite 中的加密凭证；缺少记录时返回默认设置，解密失败不回退。
pub(super) fn load() -> Result<Settings, String> {
    match crate::storage::secret_load(SECRET)? {
        Some(bytes) => normalize(serde_json::from_slice(&bytes).map_err(|_| "本地授权数据无效")?),
        None => Ok(Settings {
            backend: crate::config::backend_url()?.to_string(),
            ..Settings::default()
        }),
    }
}

/// 将授权码、账号 Cookie 及转存映射加密保存至 SQLite，不通过前端传递。
pub(super) fn save(settings: &Settings) -> Result<(), String> {
    crate::storage::secret_save(
        SECRET,
        &serde_json::to_vec(settings).map_err(|_| "授权保存失败")?,
    )
}

/// 通过本地数据库接入独立网盘包，保持账号与授权字段格式兼容。
pub(super) struct Store;
impl mqtv_netdisk::quark::CredentialStore for Store {
    fn load(&self) -> Result<mqtv_netdisk::quark::Account, String> {
        let s = load()?;
        let lease = s.lease.as_ref().ok_or("账号授权尚未准备")?;
        Ok(mqtv_netdisk::quark::Account {
            id: lease["accountId"].as_str().ok_or("账号信息缺失")?.into(),
            cookie: lease["credential"]["cookie"]
                .as_str()
                .ok_or("账号凭证缺失")?
                .into(),
            saved: s.saved,
        })
    }
    fn save(&self, account: &mqtv_netdisk::quark::Account) -> Result<(), String> {
        let mut s = load()?;
        let lease = s.lease.as_mut().ok_or("账号授权尚未准备")?;
        if lease["accountId"].as_str() != Some(account.id.as_str()) {
            return Err("账号已变化，请重新选择播放".into());
        }
        lease["credential"]["cookie"] = serde_json::json!(account.cookie);
        s.saved = account.saved.clone();
        save(&s)
    }
    fn install_login(&self, id: &str, name: &str, cookie: &str) -> Result<(), String> {
        let mut s = load()?;
        s.lease = Some(
            serde_json::json!({"provider":"quark","source":"local","name":name,"accountId":format!("local-{id}"),"credential":{"cookie":cookie},"reuseUntil":"authentication_invalid"}),
        );
        save(&s)
    }
}

#[cfg(test)]
#[path = "../../tests/quark/credentials.rs"]
mod tests;
