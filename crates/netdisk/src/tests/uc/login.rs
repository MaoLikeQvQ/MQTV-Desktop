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
                uc_qr_poll(&UnusedStore, "missing-session".into())
                    .await
                    .unwrap()["state"],
                "expired"
            );
            uc_qr_cancel("missing-session".into()).await;
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
            let result = uc_qr_create().await.expect("create QR");
            let url = reqwest::Url::parse(result["scanUrl"].as_str().unwrap()).unwrap();
            assert_eq!(url.host_str(), Some("su.uc.cn"));
            assert!(
                url.query_pairs()
                    .any(|(k, v)| k == "token" && !v.is_empty())
            );
            uc_qr_cancel(result["id"].as_str().unwrap().to_string()).await;
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

struct Store(std::sync::atomic::AtomicUsize);
impl CredentialStore for Store {
    fn load(&self) -> Result<super::super::Account, String> {
        panic!("login must not read old credentials")
    }
    fn save(&self, _: &super::super::Account) -> Result<(), String> {
        panic!("login must use install boundary")
    }
    fn install_login(&self, _: &str, name: &str, cookie: &str) -> Result<(), String> {
        assert_eq!(name, "mock-user");
        assert!(cookie.contains("__puus=mock-download-session"));
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
struct Mock {
    waiting: bool,
    expired_status: Option<u64>,
    invalid_member: bool,
    missing_cookie: bool,
    reached_member: tokio::sync::Notify,
}
impl Mock {
    fn valid() -> Self {
        Self {
            waiting: false,
            expired_status: None,
            invalid_member: false,
            missing_cookie: false,
            reached_member: tokio::sync::Notify::new(),
        }
    }
}
impl Transport for Mock {
    async fn request(
        &self,
        url: &str,
        cookie: &str,
        form: Option<&str>,
    ) -> Result<(Value, String), String> {
        let url = reqwest::Url::parse(url).unwrap();
        if url.host_str() == Some("api.open.uc.cn") {
            assert_eq!(url.query(), None, "CAS parameters must be in the POST form");
            let parsed = reqwest::Url::parse(&format!(
                "https://example.test/?{}",
                form.expect("CAS requires POST form")
            ))
            .unwrap();
            assert!(
                parsed
                    .query_pairs()
                    .any(|(key, value)| key == "client_id" && value == "381")
            );
            assert!(
                parsed
                    .query_pairs()
                    .any(|(key, value)| key == "v" && value == "1.2")
            );
            assert!(
                parsed
                    .query_pairs()
                    .any(|(key, value)| key == "request_id" && value.parse::<u64>().is_ok())
            );
            if url.path().ends_with("getServiceTicketByQrcodeToken") {
                assert!(
                    parsed
                        .query_pairs()
                        .any(|(key, value)| key == "token" && value == "mock-token")
                );
            }
        } else {
            assert!(form.is_none());
        }
        let mut cookie = cookie.to_owned();
        let data = match url.path() {
            "/cas/ajax/getTokenForQrcodeLogin" => {
                assert_eq!(url.host_str(), Some("api.open.uc.cn"));
                json!({"status":2000000,"data":{"members":{"token":"mock-token"}}})
            }
            "/cas/ajax/getServiceTicketByQrcodeToken" => {
                assert_eq!(url.host_str(), Some("api.open.uc.cn"));
                if let Some(status) = self.expired_status {
                    json!({"status":status})
                } else if self.waiting {
                    json!({"status":50004001})
                } else {
                    json!({"status":2000000,"data":{"members":{"service_ticket":"mock-ticket"}}})
                }
            }
            "/account/info" => {
                assert_eq!(url.host_str(), Some("drive.uc.cn"));
                cookie = merge_cookies(&cookie, ["__pus=mock-account-session; Secure"].into_iter());
                json!({"success":true,"data":{"nickname":"mock-user"}})
            }
            "/1/clouddrive/member" => {
                assert_eq!(url.host_str(), Some("pc-api.uc.cn"));
                assert!(
                    url.query_pairs()
                        .any(|(key, value)| key == "pr" && value == "UCBrowser")
                );
                assert!(cookie.contains("__pus=mock-account-session"));
                assert!(!has_download_cookie(&cookie), "member must be allowed to establish the download session");
                if !self.missing_cookie {
                    cookie = merge_cookies(&cookie, ["__puus=mock-download-session; Secure"].into_iter());
                }
                self.reached_member.notify_one();
                if self.invalid_member {
                    json!({"status":401,"code":41001})
                } else {
                    json!({"status":200,"code":0,"data":{}})
                }
            }
            "/" => panic!("login must validate member directly instead of visiting the UC homepage"),
            _ => panic!("unexpected mock URL"),
        };
        Ok((data, cookie))
    }
}

#[test]
fn mock_login_preserves_old_authorization_on_failure_and_cancellation() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let store = std::sync::Arc::new(Store(std::sync::atomic::AtomicUsize::new(0)));
            let mock = Mock::valid();
            let created = create(&mock).await.unwrap();
            let scan = reqwest::Url::parse(created["scanUrl"].as_str().unwrap()).unwrap();
            assert_eq!(scan.host_str(), Some("su.uc.cn"));
            assert_eq!(scan.path(), "/1_n0ZCv");
            assert!(
                scan.query_pairs()
                    .any(|(key, value)| key == "client_id" && value == "381")
            );
            assert!(
                scan.query_pairs()
                    .any(|(key, value)| key == "uc_biz_str" && value == "S:custom|C:titlebar_fix")
            );
            let id = created["id"].as_str().unwrap().to_owned();
            assert_eq!(
                poll(store.as_ref(), id, &mock).await.unwrap()["state"],
                "verified"
            );
            assert_eq!(store.0.load(Ordering::SeqCst), 1);
            for expired_status in [50004002, 50004003] {
                let mock = Mock {
                    expired_status: Some(expired_status),
                    ..Mock::valid()
                };
                let created = create(&mock).await.unwrap();
                let id = created["id"].as_str().unwrap().to_owned();
                assert_eq!(
                    poll(store.as_ref(), id.clone(), &mock).await.unwrap()["state"],
                    "expired",
                    "CAS status {expired_status} must expire the QR session"
                );
                assert_eq!(
                    poll(&UnusedStore, id, &mock).await.unwrap()["state"],
                    "expired",
                    "expired CAS session must remain cancelled"
                );
                assert_eq!(
                    store.0.load(Ordering::SeqCst),
                    1,
                    "expired CAS status {expired_status} cannot replace the old account"
                );
            }
            for mock in [
                Mock {
                    invalid_member: true,
                    ..Mock::valid()
                },
                Mock {
                    missing_cookie: true,
                    ..Mock::valid()
                },
            ] {
                let created = create(&mock).await.unwrap();
                assert!(
                    poll(
                        store.as_ref(),
                        created["id"].as_str().unwrap().into(),
                        &mock
                    )
                    .await
                    .is_err()
                );
                assert_eq!(
                    store.0.load(Ordering::SeqCst),
                    1,
                    "failed checks cannot overwrite old account"
                );
            }
            let mock = Mock {
                waiting: true,
                ..Mock::valid()
            };
            let created = create(&mock).await.unwrap();
            assert_eq!(
                poll(
                    store.as_ref(),
                    created["id"].as_str().unwrap().into(),
                    &mock
                )
                .await
                .unwrap()["state"],
                "waiting"
            );
            assert_eq!(store.0.load(Ordering::SeqCst), 1);
            let mock = std::sync::Arc::new(Mock::valid());
            let created = create(mock.as_ref()).await.unwrap();
            let id = created["id"].as_str().unwrap().to_owned();
            // 模拟播放占有授权锁；轮询已完成网络验证，但关闭扫码框仍必须能取消保存。
            let guard = LOCK.lock().await;
            let task_store = store.clone();
            let task_mock = mock.clone();
            let task_id = id.clone();
            let task = tokio::spawn(async move {
                poll(task_store.as_ref(), task_id, task_mock.as_ref()).await
            });
            mock.reached_member.notified().await;
            tokio::time::timeout(Duration::from_millis(100), uc_qr_cancel(id))
                .await
                .expect("cancel must not wait for authorization lock");
            drop(guard);
            assert_eq!(task.await.unwrap().unwrap()["state"], "expired");
            assert_eq!(
                store.0.load(Ordering::SeqCst),
                1,
                "cancelled pending save cannot install account"
            );
        });
}

#[test]
fn cookie_merge_and_download_session_validation() {
    assert_eq!(
        merge_cookies(
            "__pus=old; flag=1",
            ["__pus=new; Domain=.uc.cn", "__puus=download; Secure"].into_iter()
        ),
        "__pus=new; __puus=download; flag=1"
    );
    assert!(has_download_cookie("__puus=download"));
    assert!(!has_download_cookie("__puus=; other=value"));
    assert!(!has_download_cookie("prefix__puus=download"));
}
