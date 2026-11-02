use super::*;

#[test]
fn combines_providers_in_source_order_without_duplicates_or_lookalikes() {
    let html = r#"<a href='https://pan.quark.cn/s/q123'>q</a><div data-clipboard-text='https://drive.uc.cn/s/u123?pwd=AB12'></div><a href='https://drive.uc.cn/s/u123?pwd=AB12'>repeat</a><a href='https://drive.uc.cn.evil.invalid/s/bad'>evil</a><a href='https://drive.uc.cn/s/bad-id'>malformed</a>"#;
    assert_eq!(
        parse_shares(html, true),
        vec![
            "https://pan.quark.cn/s/q123",
            "https://drive.uc.cn/s/u123?pwd=AB12"
        ]
    );
    assert_eq!(
        parse_shares(html, false),
        vec!["https://drive.uc.cn/s/u123?pwd=AB12"]
    );
    assert!(parse_shares("<a href='https://pan.quark.cn/s/only'>q</a>", false).is_empty());
}
