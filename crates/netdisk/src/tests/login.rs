use super::*;
/// 验证未知扫码会话返回过期状态，取消未知会话也可安全完成。
#[test]
fn unknown_session_is_expired() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            assert_eq!(
                quark_qr_poll(&UnusedStore, "missing-session".into())
                    .await
                    .unwrap()["state"],
                "expired"
            );
            quark_qr_cancel("missing-session".into()).await;
        });
}
/// 按需请求真实扫码地址并校验令牌，随后取消会话；不完成账号授权保存。
#[test]
#[ignore = "requests a real login QR; does not save or replace any account"]
fn creates_real_login_qr() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let result = quark_qr_create().await.expect("create QR");
            let url = reqwest::Url::parse(result["scanUrl"].as_str().unwrap()).unwrap();
            assert_eq!(url.host_str(), Some("su.quark.cn"));
            assert!(
                url.query_pairs()
                    .any(|(k, v)| k == "token" && !v.is_empty())
            );
            quark_qr_cancel(result["id"].as_str().unwrap().to_string()).await;
        });
}

struct UnusedStore;
impl super::super::CredentialStore for UnusedStore {
    fn load(&self) -> Result<super::super::Account, String> {
        panic!("unexpected credential read")
    }
    fn save(&self, _: &super::super::Account) -> Result<(), String> {
        panic!("unexpected credential write")
    }
    fn install_login(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
        panic!("unexpected login save")
    }
}
