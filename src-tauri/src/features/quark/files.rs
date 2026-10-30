use super::{
    authorization::{lease, refresh_invalid},
    credentials::{LOCK, Store, load},
};
#[cfg(test)]
pub(super) use mqtv_netdisk::quark::files::share_id;
use serde_json::Value;
/// 准备应用授权并读取目录，明确失效时刷新一次。
pub async fn quark_files(
    share: String,
    parent: Option<String>,
    passcode: Option<String>,
    page: Option<u32>,
) -> Result<Value, String> {
    let _guard = LOCK.lock().await;
    let mut s = load()?;
    lease(&mut s, &[]).await?;
    match mqtv_netdisk::quark::files::quark_files(
        &Store,
        share.clone(),
        parent.clone(),
        passcode.clone(),
        page,
    )
    .await
    {
        Err(e) if e == "AUTH_INVALID" => {
            s = load()?;
            refresh_invalid(&mut s).await?;
            mqtv_netdisk::quark::files::quark_files(&Store, share, parent, passcode, page).await
        }
        result => result,
    }
}
/// 在共享授权锁内遍历选集，明确失效时刷新并重新读取。
pub async fn quark_episodes(share: String, passcode: Option<String>) -> Result<Value, String> {
    let _guard = LOCK.lock().await;
    let mut s = load()?;
    lease(&mut s, &[]).await?;
    match mqtv_netdisk::quark::files::quark_episodes(&Store, share.clone(), passcode.clone()).await
    {
        Err(e) if e == "AUTH_INVALID" => {
            s = load()?;
            refresh_invalid(&mut s).await?;
            mqtv_netdisk::quark::files::quark_episodes(&Store, share, passcode).await
        }
        result => result,
    }
}
