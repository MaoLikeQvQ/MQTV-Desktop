use super::*;
struct Store(&'static str);
impl CredentialStore for Store {
    fn load(&self) -> Result<super::super::Account, String> {
        Ok(super::super::Account {
            id: self.0.into(),
            cookie: String::new(),
            saved: Default::default(),
        })
    }
    fn save(&self, _: &super::super::Account) -> Result<(), String> {
        panic!("unexpected save")
    }
    fn install_login(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
        panic!("unexpected login")
    }
}
#[test]
fn share_cache_reuses_token_and_isolates_file_credentials() {
    let share = "https://pan.quark.cn/s/test123";
    SESSIONS.lock().unwrap().push(ShareSession {
        account: "cache-test".into(),
        share: share.into(),
        passcode: "1234".into(),
        token: "test-token".into(),
        created: std::time::Instant::now(),
        files: [(
            "dir:2:fid".into(),
            json!({"fid":"fid","share_fid_token":"file-token"}),
        )]
        .into(),
    });
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            assert_eq!(
                share_token(&Store("cache-test"), share, "1234")
                    .await
                    .unwrap(),
                "test-token"
            );
        });
    assert!(
        cached_file(&Store("cache-test"), share, "1234", "dir", 2, "fid")
            .unwrap()
            .is_some()
    );
    assert!(
        cached_file(&Store("other-account"), share, "1234", "dir", 2, "fid")
            .unwrap()
            .is_none()
    );
    assert!(
        cached_file(&Store("cache-test"), share, "wrong", "dir", 2, "fid")
            .unwrap()
            .is_none()
    );
    assert!(
        cached_file(&Store("cache-test"), share, "1234", "dir", 1, "fid")
            .unwrap()
            .is_none()
    );
    SESSIONS.lock().unwrap()[0].created =
        std::time::Instant::now() - std::time::Duration::from_secs(301);
    assert!(
        cached_file(&Store("cache-test"), share, "1234", "dir", 2, "fid")
            .unwrap()
            .is_none()
    );
    invalidate_share(share);
    assert!(SESSIONS.lock().unwrap().is_empty());
}
