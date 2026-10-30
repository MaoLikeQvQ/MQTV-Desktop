use super::*;
use std::time::Duration;

#[tokio::test]
async fn cancellation_drops_pending_work_and_does_not_poll_a_pre_cancelled_operation() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let signal = Signal::new();
    let dropped = Arc::new(AtomicBool::new(false));
    let tracked = dropped.clone();
    let task = tauri::async_runtime::spawn(cancellable(Some(signal.clone()), async move {
        let _guard = Dropped(tracked);
        std::future::pending::<Result<(), String>>().await
    }));
    tokio::task::yield_now().await;
    signal.cancel();
    assert!(task.await.unwrap().is_err());
    // 已取消信号先于业务future被轮询。
    let invoked = Arc::new(AtomicBool::new(false));
    let inside = invoked.clone();
    let result = cancellable(Some(signal), async move {
        inside.store(true, Ordering::SeqCst);
        Ok(())
    })
    .await;
    assert!(result.is_err());
    assert!(!invoked.load(Ordering::SeqCst));
    // 作用域之外的主窗口任务正常完成。
    assert_eq!(cancellable(None, async { Ok(42) }).await.unwrap(), 42);
}

#[tokio::test]
async fn cancelling_a_slow_http_request_closes_the_actual_local_connection() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (accepted, ready) = tokio::sync::oneshot::channel();
    let server = tauri::async_runtime::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0; 4096];
        assert!(socket.read(&mut buffer).await.unwrap() > 0);
        let _ = accepted.send(());
        // 发送响应头但一直不结束body，取消时应关闭实际连接。
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\npart")
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), socket.read(&mut buffer))
            .await
            .unwrap()
            .unwrap()
    });
    let signal = Signal::new();
    let request = tauri::async_runtime::spawn(cancellable(Some(signal.clone()), async move {
        let response = reqwest::Client::new()
            .get(format!("http://{address}/slow"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        response
            .bytes()
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }));
    ready.await.unwrap();
    signal.cancel();
    assert!(request.await.unwrap().is_err());
    assert_eq!(server.await.unwrap(), 0);
}

#[tokio::test]
async fn new_window_generation_cannot_revive_a_cancelled_request() {
    start(1).unwrap();
    let first = PLAYER.lock().unwrap().clone().unwrap().1;
    cancel();
    start(1).unwrap();
    let next = PLAYER.lock().unwrap().clone().unwrap().1;
    assert!(first.is_cancelled());
    assert!(!next.is_cancelled());
    assert!(cancellable(Some(first), async { Ok(()) }).await.is_err());
    assert!(cancellable(Some(next), async { Ok(()) }).await.is_ok());
    cancel();
}
