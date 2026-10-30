use super::*;
use serde_json::json;

#[tokio::test]
async fn hls_headers_relative_keys_ranges_and_stop_are_preserved() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        for index in 0..4 {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0; 8192];
            let count = socket.read(&mut buffer).unwrap();
            let text = String::from_utf8_lossy(&buffer[..count]);
            assert!(
                text.to_ascii_lowercase()
                    .contains("referer: https://fixture.invalid/")
            );
            let (body, mime) = if index == 0 || index == 3 {
                (
                    b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:1,\nsegment.ts\n"
                        .to_vec(),
                    "application/vnd.apple.mpegurl",
                )
            } else {
                if index == 1 {
                    assert!(text.to_ascii_lowercase().contains("range: bytes=0-3"));
                }
                (b"data".to_vec(), "application/octet-stream")
            };
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
            socket.write_all(&body).unwrap();
        }
    });
    let mut request = mqtv_parser::ParseRequest::new(format!("http://{address}/master.m3u8"));
    request.headers.insert("Referer".into(), "https://fixture.invalid/".into());
    let parsed = mqtv_parser::ParseJob::default().start(request, Default::default(), None).await.unwrap();
    let url = start_parsed(parsed).await.unwrap();
    let client = reqwest::Client::new();
    assert_eq!(downloaded_bytes(&url), Some(0));
    assert_eq!(downloaded_bytes("http://127.0.0.1/other-session"), None);
    let text = client.get(&url).send().await.unwrap().text().await.unwrap();
    let segment = text.lines().find(|l| l.starts_with("http")).unwrap();
    let key = text
        .split("URI=\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    assert!(segment.starts_with("http://127.0.0.1:"));
    assert!(!text.contains(&address.to_string()));
    assert_eq!(
        client
            .get(segment)
            .header("Range", "bytes=0-3")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "data"
    );
    assert_eq!(
        client.get(key).send().await.unwrap().text().await.unwrap(),
        "data"
    );
    assert_eq!(downloaded_bytes(&url), Some(8));
    // 第二次读取清单必须访问上游，不能冻结直播清单。
    assert!(client.get(&url).send().await.unwrap().text().await.unwrap().contains("#EXTM3U"));
    stop();
    assert_eq!(downloaded_bytes(&url), None);
    server.join().unwrap();
    assert!(client.get(&url).send().await.is_err());
    assert!(validated_headers(json!({"Host":"other"})).is_err());
    assert!(validated_headers(json!({"X-Test":"bad\r\nInjected: true"})).is_err());
}
