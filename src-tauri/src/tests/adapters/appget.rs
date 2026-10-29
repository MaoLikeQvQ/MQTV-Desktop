use super::*;
#[test]
fn sends_external_auth_and_decodes_encrypted_http_responses() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let mut input = source();
    input.key = "http-external-auth".into();
    input.ext["url"] = json!(format!("http://{address}"));
    let server_config = Config::read(&input).unwrap();
    let server = std::thread::spawn(move || {
        for step in 0..2 {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let (head, payload) = loop {
                let mut buffer = [0; 4096];
                let n = socket.read(&mut buffer).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    let size = head
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + size {
                        break (head, bytes[end + 4..end + 4 + size].to_vec());
                    }
                }
            };
            assert!(
                head.to_lowercase()
                    .contains("app-user-token: external-fixture")
            );
            assert!(!head.contains("subscription-is-not-auth"));
            let value = if step == 0 {
                assert!(head.starts_with("POST /api.php/getappapi.index/searchList "));
                assert_eq!(
                    serde_json::from_slice::<Value>(&payload).unwrap()["keywords"],
                    "动画"
                );
                json!({"search_list":[{"vod_id":42,"vod_name":"动画"}]})
            } else {
                assert!(head.starts_with("POST /api.php/getappapi.index/vodParse "));
                let fields: HashMap<_, _> = reqwest::Url::parse(&format!(
                    "https://fixture.test/?{}",
                    String::from_utf8(payload).unwrap()
                ))
                .unwrap()
                .query_pairs()
                .into_owned()
                .collect();
                assert_eq!(fields["parse_api"], "fixture-parser");
                let time = head
                    .lines()
                    .find_map(|line| line.strip_prefix("app-api-verify-time: "))
                    .unwrap();
                let sign = head
                    .lines()
                    .find_map(|line| line.strip_prefix("app-api-verify-sign: "))
                    .unwrap();
                assert_eq!(sign, server_config.encrypt(time.as_bytes()).unwrap());
                json!({"json":"{\"url\":\"https://media.test/a.mp4\"}"})
            };
            let response =
                json!({"data":server_config.encrypt(value.to_string().as_bytes()).unwrap()})
                    .to_string();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
        }
    });
    adapter_authorize(
        input.clone(),
        Some(Authorization {
            token: "external-fixture".into(),
            ..Default::default()
        }),
    )
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        assert_eq!(
            search(&input, "动画").await.unwrap()["list"][0]["vod_id"],
            42
        );
        let result = request(
            &input,
            "/getappapi.index/vodParse",
            json!({"parse_api":"fixture-parser","url":"encoded-fixture","token":"episode-fixture"}),
            true,
        )
        .await
        .unwrap();
        assert!(result["json"].as_str().unwrap().contains("media.test"));
    });
    adapter_authorize(input, None).unwrap();
    server.join().unwrap();
}
fn source() -> Source {
    Source {
        key: "appget-test".into(),
        api: "csp_AppGet".into(),
        kind: 3,
        ext: json!({"url":"https://example.test","dataKey":"0123456789abcdef","dataIv":"fedcba9876543210","token":"subscription-is-not-auth"}),
    }
}
#[test]
fn interoperates_with_aes_cbc_pkcs7_and_does_not_read_feed_credentials() {
    let cfg = Config::read(&source()).unwrap();
    let cipher = cfg.encrypt(br#"{"ok":true}"#).unwrap();
    assert_eq!(cfg.decrypt(&cipher).unwrap(), json!({"ok":true}));
    assert!(cfg.decrypt("invalid").is_err());
    assert!(authorization(&source()).unwrap().token.is_empty());
    assert!(
        headers(&Authorization::default(), "1", None)
            .get("app-user-token")
            .is_none()
    );
}
#[test]
fn episodes_contain_positions_not_temporary_tokens() {
    let data = json!({"vod":{"vod_name":"影片"},"vod_play_list":[{"player_info":{"show":"高清"},"urls":[{"name":"第一集","url":"https://media.test/a.mp4","token":"secret-test"}]}]});
    let parsed = parse_detail(&data, "42").unwrap();
    let list = parsed["list"][0]["vod_play_url"].as_str().unwrap();
    let id = list.split_once('$').unwrap().1;
    assert_eq!(
        serde_json::from_slice::<Value>(&URL_SAFE_NO_PAD.decode(id).unwrap()).unwrap(),
        json!(["42", 0, 0, "第一集"])
    );
    assert!(!parsed.to_string().contains("secret-test"));
    assert!(media_result(json!({"url":"https://example.test/player","parse":1})).is_err());
    assert!(media_result(json!({"url":"https://example.test/player","parse":"1"})).is_err());
    assert!(media_result(json!({"url":"https://example.test/player","parse":true})).is_err());
    assert!(media_result(json!({"url":"https://pan.quark.cn/s/test"})).is_err());
}
