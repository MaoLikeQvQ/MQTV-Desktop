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
