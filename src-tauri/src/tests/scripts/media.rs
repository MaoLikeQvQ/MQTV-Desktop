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
            let (body, mime) = if index < 2 {
                (
                    b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:1,\nsegment.ts\n"
                        .to_vec(),
                    "application/vnd.apple.mpegurl",
                )
            } else {
                if index == 2 {
                    assert!(text.to_ascii_lowercase().contains("range: bytes=0-3"));
                }
                (b"data".to_vec(), "application/octet-stream")
            };
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
            socket.write_all(&body).unwrap();
        }
    });
    let url = start(
        format!("http://{address}/master.m3u8"),
        json!({"Referer":"https://fixture.invalid/"}),
    )
    .await
    .unwrap();
    let client = reqwest::Client::new();
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
    stop();
    server.join().unwrap();
    assert!(client.get(&url).send().await.is_err());
    assert!(validated_headers(json!({"Host":"other"})).is_err());
    assert!(validated_headers(json!({"X-Test":"bad\r\nInjected: true"})).is_err());
}
