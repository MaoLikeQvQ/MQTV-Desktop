use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
/// 打开当前系统的夸克授权凭证条目；未配置安全存储的平台返回错误。
fn entry() -> Result<Entry, String> {
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return Err("当前平台尚未配置系统安全存储".into());
    }
    Entry::new("com.maolike.mqtv.desktop", "quark-authorization")
        .map_err(|_| "无法打开系统凭证存储".into())
}
/// 从系统凭证存储读取授权设置；首次使用时创建默认设置，并在内存中迁移旧后台地址。
pub(super) fn load() -> Result<Settings, String> {
    match entry()?.get_password() {
        Ok(text) => {
            let mut settings: Settings =
                serde_json::from_str(&text).map_err(|_| "本地授权数据无效".to_string())?;
            if matches!(
                settings.backend.as_str(),
                "http://127.0.0.1:3101/" | "http://localhost:3101/" | "http://tvadmin.maolike.cn/"
            ) {
                settings.backend = crate::config::backend_url()?.to_string();
            }
            Ok(settings)
        }
        Err(keyring::Error::NoEntry) => Ok(Settings {
            backend: crate::config::backend_url()?.to_string(),
            lease: None,
            authorization_code: None,
            saved: Default::default(),
        }),
        Err(_) => Err("无法读取系统凭证存储，请允许钥匙串访问".into()),
    }
}
/// 将完整授权设置序列化并写入系统凭证存储，保存失败时返回错误。
pub(super) fn save(settings: &Settings) -> Result<(), String> {
    entry()?
        .set_password(&serde_json::to_string(settings).map_err(|_| "授权保存失败")?)
        .map_err(|_| "无法保存到系统凭证存储".into())
}

/// 将既有钥匙串格式接入独立网盘包，不更换服务名、账号键或授权结构。
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
