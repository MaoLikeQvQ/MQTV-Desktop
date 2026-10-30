use super::{
    authorization::{lease, refresh_invalid},
    credentials::{LOCK, Store, load},
};
use serde_json::Value;
/// 准备应用授权并调用网盘包；失效后只刷新账号，不自动重复转存。
pub async fn quark_play(
    share: String,
    parent: String,
    passcode: Option<String>,
    fid: String,
    page: Option<u32>,
) -> Result<Value, String> {
    let _guard = LOCK.lock().await;
    let mut s = load()?;
    lease(&mut s, &[]).await?;
    match mqtv_netdisk::quark::playback::quark_play(&Store, share, parent, passcode, fid, page)
        .await
    {
        Err(e) if e == "AUTH_INVALID" => {
            s = load()?;
            refresh_invalid(&mut s).await?;
            Err("原授权已失效，已获取新的账号授权，请重新点击选集播放".into())
        }
        result => result,
    }
}

/// 只返回当前媒体会话的累计下载字节，不读取账号或发起网络请求。
#[tauri::command]
pub fn quark_downloaded_bytes(url: String) -> Option<u64> {
    mqtv_netdisk::quark::downloaded_bytes(&url)
}
