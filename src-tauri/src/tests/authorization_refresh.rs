use super::*;

#[tokio::test]
async fn uc_without_own_code_can_claim_with_previously_verified_quark_code() {
    let result = replacement("uc", None, None, Some("quark-verified-code"), |code| async move {
        assert_eq!(code, "quark-verified-code");
        Ok(json!({"provider":"uc","accountId":"new-uc","credential":{"cookie":"artificial=value"}}))
    }).await.unwrap().unwrap();
    assert_eq!(result.code, "quark-verified-code");
    assert_eq!(result.lease["accountId"], "new-uc");
}

#[tokio::test]
async fn own_saved_code_takes_precedence_and_managed_cache_is_not_reused() {
    let old =
        json!({"provider":"quark","accountId":"old-managed","credential":{"cookie":"old=value"}});
    let result = replacement("quark", Some(&old), Some("own-verified-code"), Some("other-code"), |code| async move {
        assert_eq!(code, "own-verified-code");
        Ok(json!({"provider":"quark","accountId":"new-managed","credential":{"cookie":"new=value"}}))
    }).await.unwrap().unwrap();
    assert_eq!(result.lease["accountId"], "new-managed");
    assert_eq!(old["accountId"], "old-managed");
}

#[tokio::test]
async fn local_login_is_protected_without_code_or_network() {
    let old = json!({"provider":"uc","source":"local","accountId":"local-personal","credential":{"cookie":"personal=value"}});
    let result = replacement("uc", Some(&old), None, None, |_| async {
        panic!("local login must not request a managed account");
        #[allow(unreachable_code)]
        Ok(Value::Null)
    })
    .await
    .unwrap();
    assert!(result.is_none());
    assert_eq!(old["credential"]["cookie"], "personal=value");
}

#[tokio::test]
async fn network_and_invalid_response_failures_preserve_old_authorization() {
    let old =
        json!({"provider":"uc","accountId":"old-managed","credential":{"cookie":"old=value"}});
    let before = old.clone();
    let error = replacement("uc", Some(&old), Some("verified-code"), None, |_| async {
        Err("后台无可用账号".into())
    })
    .await
    .err()
    .unwrap();
    assert_eq!(error, "后台无可用账号");
    for invalid in [
        json!({"provider":"quark","accountId":"wrong","credential":{"cookie":"new=value"}}),
        json!({"provider":"uc","accountId":"","credential":{"cookie":"new=value"}}),
        json!({"provider":"uc","accountId":"new","credential":{"cookie":"bad\r\nheader"}}),
    ] {
        assert!(
            replacement("uc", Some(&old), Some("verified-code"), None, |_| async {
                Ok(invalid)
            })
            .await
            .is_err()
        );
    }
    assert_eq!(old, before);
}

#[tokio::test]
async fn missing_saved_code_explains_verification_without_a_request() {
    let error = replacement("uc", None, Some(" "), None, |_| async {
        panic!("missing code must not issue a request");
        #[allow(unreachable_code)]
        Ok(Value::Null)
    })
    .await
    .err()
    .unwrap();
    assert!(error.contains("请先在基础设置中验证"));
}

/// 本机后台 fixture 检查真正的 POST 请求体，使用人工授权码且不读取本机凭据。
fn backend(
    status: u16,
    payload: Value,
    expected_code: &'static str,
) -> (reqwest::Url, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = reqwest::Url::parse(&format!(
        "http://{}/api/authorizations/uc",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    listener.set_nonblocking(true).unwrap();
    let worker = std::thread::spawn(move || {
        let start = std::time::Instant::now();
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && start.elapsed().as_secs() < 3 =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(5))
                }
                Err(error) => panic!("local backend did not receive request: {error}"),
            }
        };
        // macOS 的 accept 可能继承监听套接字的非阻塞模式，读请求前显式恢复阻塞。
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0; 4096];
        let (header_end, length) = loop {
            let count = socket.read(&mut chunk).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                assert!(headers.starts_with("POST /api/authorizations/uc HTTP/1.1"));
                assert!(!headers.to_ascii_lowercase().contains("cookie:"));
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|length| length.trim().parse().unwrap())
                    })
                    .unwrap();
                break (end + 4, length);
            }
        };
        while bytes.len() < header_end + length {
            let count = socket.read(&mut chunk).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
        }
        let request: Value =
            serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
        assert_eq!(
            request,
            json!({"authorizationCode":expected_code,"excludeAccountIds":[]})
        );
        let body = payload.to_string();
        write!(socket, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    (endpoint, worker)
}

#[tokio::test]
async fn real_post_uses_peer_code_and_backend_failure_leaves_previous_lease_untouched() {
    let old = json!({"provider":"uc","accountId":"old","credential":{"cookie":"old=value"}});
    let before = old.clone();
    let (endpoint, worker) = backend(
        200,
        json!({"provider":"uc","accountId":"new","credential":{"cookie":"new=value"}}),
        "quark-verified-code",
    );
    let refreshed = replacement(
        "uc",
        Some(&old),
        None,
        Some("quark-verified-code"),
        |code| request_at(endpoint, code),
    )
    .await
    .unwrap()
    .unwrap();
    worker.join().unwrap();
    assert_eq!(refreshed.lease["accountId"], "new");
    assert_eq!(refreshed.code, "quark-verified-code");
    assert_eq!(old, before);

    let (endpoint, worker) = backend(
        503,
        json!({"error":"no enabled account"}),
        "own-verified-code",
    );
    let error = replacement("uc", Some(&old), Some("own-verified-code"), None, |code| {
        request_at(endpoint, code)
    })
    .await
    .err()
    .unwrap();
    worker.join().unwrap();
    assert!(error.contains("HTTP 503"));
    assert!(error.contains("原授权已保留"));
    assert_eq!(old, before);
}
