use super::*;
use serde_json::json;

#[test]
fn legacy_missing_and_corrupt_files_are_distinct() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authorization.json");
    assert!(read_legacy(&path).unwrap().is_none());
    fs::write(&path, b"{broken").unwrap();
    assert!(read_legacy(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"{broken");
}

#[test]
fn legacy_fields_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authorization.json");
    let fixture = json!({"backend":"https://example.invalid/", "authorization_code":"test-code",
        "lease":{"accountId":"test", "credential":{"cookie":"test-cookie"}}, "saved":{"file":"saved-file"}});
    fs::write(&path, serde_json::to_vec(&fixture).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(read_legacy(&path).unwrap().unwrap()).unwrap(),
        fixture
    );
}

#[test]
fn plaintext_cleanup_is_retryable_and_never_deletes_conflicting_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authorization.json");
    let fixture = json!({"backend":"https://example.invalid/", "authorization_code":"test-code", "lease":null});
    fs::write(&path, serde_json::to_vec(&fixture).unwrap()).unwrap();
    let expected = serde_json::to_vec(&read_legacy(&path).unwrap().unwrap()).unwrap();
    assert!(cleanup_legacy(&path, &expected, b"different").is_err());
    assert!(path.exists());
    let mut changed = fixture.clone();
    changed["authorization_code"] = json!("new-code");
    fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(cleanup_legacy(&path, &expected, &expected).is_err());
    assert!(path.exists());
    fs::write(&path, serde_json::to_vec(&fixture).unwrap()).unwrap();
    // 模拟数据库提交后首次清理未执行；下次启动仍可校验后清理。
    cleanup_legacy(&path, &expected, &expected).unwrap();
    assert!(!path.exists());
}
