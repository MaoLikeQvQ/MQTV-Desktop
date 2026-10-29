use super::credentials::Store;
use serde_json::Value;
/// 创建独立网盘包的扫码会话，返回原有前端契约。
#[tauri::command]
pub async fn quark_qr_create() -> Result<Value, String> {
    mqtv_netdisk::quark::login::quark_qr_create().await
}
/// 取消扫码会话，阻止迟到响应保存凭证。
#[tauri::command]
pub async fn quark_qr_cancel(id: String) {
    mqtv_netdisk::quark::login::quark_qr_cancel(id).await
}
/// 轮询扫码状态，通过应用钥匙串适配器安装成功授权。
#[tauri::command]
pub async fn quark_qr_poll(id: String) -> Result<Value, String> {
    mqtv_netdisk::quark::login::quark_qr_poll(&Store, id).await
}
