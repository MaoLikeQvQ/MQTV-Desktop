use super::*;

#[test]
fn rejects_unimplemented_plugins_and_isolates_auth_configuration() {
    let mut source = Source {
        key: "same".into(),
        api: "csp_Anime1".into(),
        kind: 3,
        ext: Value::Null,
    };
    adapter_authorize(
        source.clone(),
        Some(Authorization {
            token: "external-test".into(),
            ..Default::default()
        }),
    )
    .unwrap();
    assert_eq!(authorization(&source).unwrap().token, "external-test");
    source.ext = json!({"changed":true});
    assert!(authorization(&source).unwrap().token.is_empty());
    source.api = "csp_Anime1Guard".into();
    assert!(adapter(&source).is_err());
    assert!(http_url("https://user:pass@example.test/").is_err());
    assert!(http_url("http://remote.test/").is_err());
}

#[test]
fn rejects_header_injection() {
    let source = Source {
        key: "invalid".into(),
        api: "csp_AppGet".into(),
        kind: 3,
        ext: Value::Null,
    };
    assert!(
        adapter_authorize(
            source,
            Some(Authorization {
                token: "bad\r\nX-Leak: true".into(),
                ..Default::default()
            })
        )
        .is_err()
    );
}
