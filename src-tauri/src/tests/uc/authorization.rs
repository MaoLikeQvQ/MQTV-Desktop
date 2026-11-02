use super::*;

#[test]
fn rejects_other_provider_empty_account_and_header_injection() {
    let valid = json!({"provider":"uc","accountId":"artificial-account","credential":{"cookie":"fixture=value"}});
    assert!(validate_lease(&valid).is_ok());
    for (field, value) in [("provider", "quark"), ("accountId", ""), ("accountId", " ")] {
        let mut invalid = valid.clone();
        invalid[field] = json!(value);
        assert!(validate_lease(&invalid).is_err());
    }
    for cookie in ["", "fixture=value\r\nInjected: header"] {
        let mut invalid = valid.clone();
        invalid["credential"]["cookie"] = json!(cookie);
        assert!(validate_lease(&invalid).is_err());
    }
}

#[test]
fn metadata_never_exposes_credentials_or_beta_code() {
    let settings: Settings = serde_json::from_value(json!({"backend":"https://fixture.invalid/", "authorization_code":"artificial-code", "lease":{"accountId":"fixture", "source":"local", "credential":{"cookie":"artificial-secret"}}})).unwrap();
    let result = metadata(&settings);
    assert_eq!(result["cached"], true);
    assert_eq!(result["local"], true);
    assert!(!result.to_string().contains("artificial"));
}

#[test]
fn invalid_code_is_rejected_before_local_credentials() {
    tauri::async_runtime::block_on(async {
        assert!(uc_authorize_code(" ".into()).await.is_err());
        assert!(uc_authorize_code("x".repeat(129)).await.is_err());
        assert!(
            uc_settings(Some("https://override.invalid/".into()))
                .await
                .unwrap_err()
                .contains("VITE_API_BASE_URL")
        );
    });
}

#[test]
fn cookie_rotation_keeps_unrelated_values_and_embedded_equals() {
    let result = super::super::client::merge_cookies(
        "sid=old; retained=a=b",
        &["sid=new; Secure".into(), "__puus=fresh; Path=/".into()],
    );
    assert_eq!(result, "__puus=fresh; retained=a=b; sid=new");
}
