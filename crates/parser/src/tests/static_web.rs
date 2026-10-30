use super::*;

#[test]
fn extracts_relative_player_config_and_preserves_signed_query() {
    let base = Url::parse("https://media.example/share/episode").unwrap();
    assert_eq!(
        extract(
            r#"<script>const url = "/20241005/episode/index.m3u8?sign=a&x=1";</script>"#,
            &base
        )
        .unwrap(),
        "https://media.example/20241005/episode/index.m3u8?sign=a&x=1"
    );
    assert_eq!(
        extract(
            r#"<video><source src="//cdn.example/a.mp4?a=1&amp;b=2"></video>"#,
            &base
        )
        .unwrap(),
        "https://cdn.example/a.mp4?a=1&b=2"
    );
    assert_eq!(
        extract(
            r#"<script>var player={"url":"https:\/\/cdn.example\/a.m3u8"};</script>"#,
            &base
        )
        .unwrap(),
        "https://cdn.example/a.m3u8"
    );
}

#[test]
fn refuses_dynamic_ambiguous_and_credential_urls() {
    let base = Url::parse("https://media.example/page").unwrap();
    for html in [
        "<script>const url = decrypt(data);</script>",
        r#"<source src="https://cdn.example/a.mp4"><source src="https://cdn.example/b.mp4">"#,
        r#"<source src="https://user:password@cdn.example/a.m3u8">"#,
    ] {
        assert!(extract(html, &base).is_err());
    }
    assert!(validated_url("javascript:alert(1)").is_err());
}
