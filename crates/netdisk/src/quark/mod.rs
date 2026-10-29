//! 夸克目录、登录和播放能力。调用方持有 LOCK 并准备有效账号后调用目录及播放接口。
mod client;
pub mod files;
pub mod login;
pub mod playback;
mod proxy;
use std::collections::BTreeMap;
use tokio::sync::Mutex;
/// 跨授权、扫码和播放的共享锁，宿主与网盘调用必须使用同一把锁。
pub static LOCK: Mutex<()> = Mutex::const_new(());
/// 仅供原生调用的账号快照，不应序列化到界面或日志。
pub struct Account {
    pub id: String,
    pub cookie: String,
    pub saved: BTreeMap<String, String>,
}
/// 宿主提供凭证存储；更新 Cookie 和转存记录时保留宿主的其他授权字段。
pub trait CredentialStore: Send + Sync {
    fn load(&self) -> Result<Account, String>;
    fn save(&self, account: &Account) -> Result<(), String>;
    fn install_login(&self, id: &str, name: &str, cookie: &str) -> Result<(), String>;
}
/// 关闭当前媒体监听，供宿主退出时清理。
pub fn shutdown() {
    proxy::stop();
}

#[cfg(test)]
#[path = "../tests/share.rs"]
mod share_tests;

/// 解释夸克业务响应，不访问账号或网络。
pub use client::decode_api_response as decode_response;

/// 查询当前媒体会话的累计下载字节，不匹配的会话返回未知。
pub use proxy::downloaded_bytes;
