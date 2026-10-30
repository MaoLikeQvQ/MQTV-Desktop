use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

struct PendingHost(AtomicBool);
struct Cleanup<'a>(&'a AtomicBool);
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
impl ParseHost for PendingHost {
    fn parse<'a>(&'a self, _: &'a Parser, _: &'a ParseRequest) -> ParseFuture<'a> {
        Box::pin(async move {
            let _cleanup = Cleanup(&self.0);
            std::future::pending().await
        })
    }
}

fn extension_request() -> ParseRequest {
    let mut request = ParseRequest::new("https://media.example/episode".into());
    request.parser = Some(Parser {
        kind: 2,
        ..Default::default()
    });
    request
}

#[tokio::test]
async fn cancellation_drops_running_host_work() {
    let host = PendingHost(AtomicBool::new(false));
    let cancel = Cancellation::default();
    let trigger = cancel.clone();
    let work = async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        trigger.cancel();
    };
    let job = ParseJob::default();
    let (result, _) = tokio::join!(job.start(extension_request(), cancel, Some(&host)), work);
    assert!(result.unwrap_err().contains("取消"));
    assert!(host.0.load(Ordering::SeqCst));
}

#[tokio::test]
async fn timeout_drops_host_work_and_missing_host_is_explicit() {
    let host = PendingHost(AtomicBool::new(false));
    let error = ParseJob::new(Duration::from_millis(20))
        .start(extension_request(), Cancellation::default(), Some(&host))
        .await
        .unwrap_err();
    assert!(error.contains("超时"));
    assert!(host.0.load(Ordering::SeqCst));
    assert!(
        ParseJob::default()
            .start(extension_request(), Cancellation::default(), None)
            .await
            .unwrap_err()
            .contains("宿主")
    );
}

#[tokio::test]
async fn cancellation_is_terminal() {
    let cancel = Cancellation::default();
    cancel.cancel();
    assert!(
        ParseJob::default()
            .start(extension_request(), cancel, None)
            .await
            .unwrap_err()
            .contains("取消")
    );
}

#[tokio::test]
async fn resolves_json_service_result_and_probes_media() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        for index in 0..2 {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let length = socket.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..length]);
            let (body, mime) = if index == 0 {
                assert!(request.contains("/parse?url=https://page.example/1"));
                (
                    format!(r#"{{"data":{{"url":"http://{address}/video.m3u8"}}}}"#),
                    "application/json",
                )
            } else {
                (
                    "#EXTM3U\n#EXTINF:1,\nsegment.ts\n".into(),
                    "application/vnd.apple.mpegurl",
                )
            };
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    let mut request = ParseRequest::new("https://page.example/1".into());
    request.parser = Some(Parser {
        kind: 1,
        name: "fixture".into(),
        url: format!("http://{address}/parse?url="),
        headers: Headers::new(),
    });
    let result = ParseJob::default()
        .start(request, Cancellation::default(), None)
        .await
        .unwrap();
    assert_eq!(result.url, format!("http://{address}/video.m3u8"));
    assert_eq!(result.from, "fixture");
    server.join().unwrap();
}

#[tokio::test]
async fn cache_is_bounded_expires_and_isolates_request_headers() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        for expected in ["one", "two", "one", "one", "one"] {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let n = socket.read(&mut buffer).unwrap();
            assert!(
                String::from_utf8_lossy(&buffer[..n])
                    .to_lowercase()
                    .contains(&format!("x-session: {expected}"))
            );
            let body = "#EXTM3U\n#EXTINF:1,\nsegment.ts\n";
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    let job = ParseJob::default();
    let mut request = ParseRequest::new(format!("http://{address}/master.m3u8"));
    request.headers.insert("X-Session".into(), "one".into());
    let first = job
        .start(request.clone(), Default::default(), None)
        .await
        .unwrap();
    assert!(!first.cache_hit);
    assert!(first.take_probe().is_some());
    assert!(first.take_probe().is_none());
    let hit = job
        .start(request.clone(), Default::default(), None)
        .await
        .unwrap();
    assert!(hit.cache_hit);
    assert!(hit.take_probe().is_none());
    let mut other = request.clone();
    other.headers.insert("X-Session".into(), "two".into());
    assert!(
        !job.start(other, Default::default(), None)
            .await
            .unwrap()
            .cache_hit
    );
    for (_, time, _) in job.cache.lock().unwrap().iter_mut() {
        *time = Instant::now() - Duration::from_secs(61);
    }
    assert!(
        !job.start(request.clone(), Default::default(), None)
            .await
            .unwrap()
            .cache_hit
    );
    job.invalidate(&request);
    assert!(
        !job.start(request.clone(), Default::default(), None)
            .await
            .unwrap()
            .cache_hit
    );
    // 以已成功解析结果填充缓存，验证容量淘汰而不访问外部网络。
    {
        let mut cache = job.cache.lock().unwrap();
        cache.clear();
        for index in 0..128 {
            cache.push((format!("fixture-{index}"), Instant::now(), hit.clone()));
        }
    }
    assert!(
        !job.start(request.clone(), Default::default(), None)
            .await
            .unwrap()
            .cache_hit
    );
    assert_eq!(job.cache.lock().unwrap().len(), 128);
    assert!(
        !job.cache
            .lock()
            .unwrap()
            .iter()
            .any(|(key, _, _)| key == "fixture-0")
    );
    server.join().unwrap();
    // 本选集无缓存且上游已关闭：失败不应挤出任何成功记录。
    request.flag = "uncached".into();
    assert!(job.start(request, Default::default(), None).await.is_err());
    assert_eq!(job.cache.lock().unwrap().len(), 128);
}

#[tokio::test]
async fn pooled_connection_keeps_headers_scoped_to_each_request() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        // 两次解析必须复用同一 TCP 连接；错误地新建客户端会导致读取超时。
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        for expected in ["one", "two"] {
            let mut buffer = Vec::new();
            while !buffer.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                buffer.push(byte[0]);
            }
            assert!(
                String::from_utf8_lossy(&buffer)
                    .to_lowercase()
                    .contains(&format!("x-session: {expected}"))
            );
            let body = r#"<video src="/video.m3u8"></video>"#;
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    let job = ParseJob::default();
    for session in ["one", "two"] {
        let mut request = ParseRequest::new(format!("http://{address}/page"));
        request.headers.insert("X-Session".into(), session.into());
        assert!(
            !job.start(request, Default::default(), None)
                .await
                .unwrap()
                .cache_hit
        );
    }
    server.join().unwrap();
}
