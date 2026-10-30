use super::*;

#[test]
fn transfer_count_is_scoped_to_the_current_media_session() {
    let old = Arc::new(AtomicU64::new(1024));
    *TRANSFER.lock().unwrap() = Some(("http://127.0.0.1/old".into(), old.clone()));
    assert_eq!(downloaded_bytes("http://127.0.0.1/old"), Some(1024));
    let current = Arc::new(AtomicU64::new(0));
    *TRANSFER.lock().unwrap() = Some(("http://127.0.0.1/current".into(), current.clone()));
    old.fetch_add(4096, Ordering::Relaxed);
    current.fetch_add(2048, Ordering::Relaxed);
    assert_eq!(downloaded_bytes("http://127.0.0.1/old"), None);
    assert_eq!(downloaded_bytes("http://127.0.0.1/current"), Some(2048));
    stop();
    assert_eq!(downloaded_bytes("http://127.0.0.1/current"), None);
}

#[test]
fn cancelling_proxy_owner_closes_existing_downstream_and_upstream_connections() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let upstream_address = upstream.local_addr().unwrap();
                let (disconnected, mut closed) = tokio::sync::mpsc::channel(2);
                let server = tokio::spawn(async move {
                    let mut requests = tokio::task::JoinSet::new();
                    for _ in 0..2 {
                        let (mut socket, _) = upstream.accept().await.unwrap();
                        let disconnected = disconnected.clone();
                        requests.spawn(async move {
                            let mut header = Vec::new();
                            while !header.ends_with(b"\r\n\r\n") {
                                let mut byte = [0];
                                assert_eq!(socket.read(&mut byte).await.unwrap(), 1);
                                header.push(byte[0]);
                            }
                            // 保持响应体未结束，确保取消时存在正在下载的 HTTP 请求。
                            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\nfilm").await.unwrap();
                            let mut byte = [0];
                            let result = socket.read(&mut byte).await;
                            assert!(matches!(result, Ok(0)) || result.is_err());
                            disconnected.send(()).await.unwrap();
                        });
                    }
                    while let Some(result) = requests.join_next().await { result.unwrap(); }
                });
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let targets = Arc::new(Mutex::new(vec![Url::parse(&format!("http://{upstream_address}/film.mp4")).unwrap()]));
                // 直接测试监听生命周期，不放宽正式入口的 HTTPS 检查，不使用真实账号或代理全局状态。
                let task = spawn_proxy(listener, address, "/test/".into(), targets,
                    String::new(), false, Arc::new(AtomicU64::new(0)));
                let http = Client::new();
                let mut responses = Vec::new();
                for _ in 0..2 {
                    let mut response = http.get(format!("http://{address}/test/0/stream.mp4")).send().await.unwrap();
                    assert_eq!(response.chunk().await.unwrap().unwrap().as_ref(), b"film");
                    responses.push(response);
                }
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
                for mut response in responses {
                    assert!(response.chunk().await.is_err(), "unfinished response must end when its owner stops");
                }
                for _ in 0..2 { closed.recv().await.expect("upstream request closed"); }
                server.await.unwrap();
                assert!(tokio::net::TcpStream::connect(address).await.is_err());
            }).await.expect("proxy cancellation must promptly close all active connections");
        });
}
