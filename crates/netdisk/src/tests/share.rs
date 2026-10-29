#[test]
fn share_validation() {
    assert_eq!(
        super::files::share_id("https://pan.quark.cn/s/abc123").unwrap(),
        "abc123"
    );
    assert!(super::files::share_id("https://pan.baidu.com/s/abc").is_err());
}
