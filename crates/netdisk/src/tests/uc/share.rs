#[test]
fn share_validation() {
    assert_eq!(
        super::files::share_id("https://drive.uc.cn/s/abc123").unwrap(),
        "abc123"
    );
    for invalid in [
        "https://pan.baidu.com/s/abc",
        "https://drive.uc.cn.evil.test/s/abc",
        "http://drive.uc.cn/s/abc",
        "https://user:secret@drive.uc.cn/s/abc",
        "https://drive.uc.cn:8443/s/abc",
        "https://drive.uc.cn/s/abc-def",
    ] {
        assert!(super::files::share_id(invalid).is_err());
    }
}
