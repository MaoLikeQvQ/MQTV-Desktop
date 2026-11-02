use serde::{Deserialize, Serialize};
use serde_json::Value;

// Serialize authorization reads, refreshes, and playback preparation across commands.
pub(super) use mqtv_netdisk::uc::LOCK;

#[derive(Default, Serialize, Deserialize)]
pub(super) struct Settings {
    pub(super) backend: String,
    #[serde(default)]
    pub(super) authorization_code: Option<String>,
    pub(super) lease: Option<Value>,
    #[serde(default)]
    pub(super) saved: std::collections::BTreeMap<String, String>,
}
const SECRET: &str = "uc-authorization";

/// 后台统一使用构建环境配置；切换环境时清除后台租约，保留本地扫码账号及其他字段。
fn normalize(mut settings: Settings) -> Result<Settings, String> {
    let backend = crate::config::backend_url()?.to_string();
    if settings.backend != backend
        && !settings
            .lease
            .as_ref()
            .is_some_and(|l| l["source"] == "local")
    {
        settings.lease = None;
        settings.saved.clear();
    }
    settings.backend = backend;
    Ok(settings)
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

/// 在原生层读取已保存内测码的快照；不获取提供商锁，避免跨网盘反向等待。
pub(crate) fn stored_code() -> Result<Option<String>, String> {
    Ok(load()?.authorization_code)
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
impl mqtv_netdisk::uc::CredentialStore for Store {
    fn load(&self) -> Result<mqtv_netdisk::uc::Account, String> {
        let s = load()?;
        let lease = s.lease.as_ref().ok_or("账号授权尚未准备")?;
        Ok(mqtv_netdisk::uc::Account {
            id: lease["accountId"].as_str().ok_or("账号信息缺失")?.into(),
            cookie: lease["credential"]["cookie"]
                .as_str()
                .ok_or("账号凭证缺失")?
                .into(),
            saved: s.saved,
        })
    }
    fn save(&self, account: &mqtv_netdisk::uc::Account) -> Result<(), String> {
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
        s.saved.clear();
        s.lease = Some(
            serde_json::json!({"provider":"uc","source":"local","name":name,"accountId":format!("local-{id}"),"credential":{"cookie":cookie},"reuseUntil":"authentication_invalid"}),
        );
        save(&s)
    }
}

#[cfg(test)]
#[path = "../../tests/uc/credentials.rs"]
mod tests;
