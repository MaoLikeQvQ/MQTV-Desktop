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
