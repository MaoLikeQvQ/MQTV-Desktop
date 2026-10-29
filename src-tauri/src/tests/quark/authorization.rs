use super::*;
/// 验证缺少授权码字段的旧版设置仍可反序列化。
#[test]
fn old_settings_remain_readable_without_a_code() {
    let settings: Settings =
        serde_json::from_value(json!({"backend":"http://127.0.0.1:3101/","lease":null})).unwrap();
    assert!(settings.authorization_code.is_none());
}
/// 验证空白及超长授权码在访问本地凭证之前即被拒绝。
#[test]
fn invalid_input_is_rejected_before_accessing_local_credentials() {
    tauri::async_runtime::block_on(async {
        assert!(quark_authorize_code(" ".into()).await.is_err());
        assert!(quark_authorize_code("x".repeat(129)).await.is_err());
    });
}
