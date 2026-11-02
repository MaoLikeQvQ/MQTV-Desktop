/// 验证接口地址使用配置后台的同源地址，并保留指定接口路径。
#[test]
fn endpoints_use_the_configured_backend() {
    let base = super::backend_url().unwrap();
    let endpoint = super::backend_endpoint("/api/proxy").unwrap();
    assert_eq!(base.origin(), endpoint.origin());
    assert_eq!(endpoint.path(), "/api/proxy");
    if let Ok(expected) = std::env::var("VITE_API_BASE_URL") {
        assert_eq!(
            base.origin(),
            reqwest::Url::parse(&expected).unwrap().origin()
        );
    }
}

/// UC 授权与资源配置保持同源，路径独立于夸克。
#[test]
fn uc_authorization_uses_configured_origin() {
    let endpoint = super::uc_authorization_endpoint().unwrap();
    assert_eq!(endpoint.origin(), super::backend_url().unwrap().origin());
    assert_eq!(endpoint.path(), "/api/authorizations/uc");
}
