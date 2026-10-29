use super::*;
#[test]
fn parses_index_and_pagination_without_initializing_home() {
    assert_eq!(
        parse_index(r#"[[12,"动画","12集",2025,"春","字幕组"]]"#, "动画").unwrap()["list"][0]["vod_id"],
        "12"
    );
    let (episodes,next) = parse_page(r#"<article><h2>第1集</h2><video data-apireq="%7B%22id%22%3A1%7D"></video></article><div class="nav-previous"><a href="/page/2/?cat=12">下一页</a></div>"#, &http_url(SITE).unwrap()).unwrap();
    assert_eq!(episodes[0].1, r#"{"id":1}"#);
    assert_eq!(next.unwrap().host_str(), Some("anime1.me"));
    assert!(
        parse_page(
            r#"<div class="nav-previous"><a href="https://evil.test/">next</a></div>"#,
            &http_url(SITE).unwrap()
        )
        .is_err()
    );
}
#[test]
fn combines_media_cookies_and_blocks_unrelated_media_hosts() {
    let mut headers = HeaderMap::new();
    headers.append("set-cookie", "a=1; Path=/".parse().unwrap());
    headers.append("set-cookie", "b=2; Secure".parse().unwrap());
    let (url, h) = playback(r#"{"s":[{"src":"//v.anime1.me/a.mp4"}]}"#, &headers).unwrap();
    assert_eq!(url, "https://v.anime1.me/a.mp4");
    assert_eq!(h["Cookie"], "a=1; b=2");
    assert!(playback(r#"{"s":[{"src":"https://evil.test/a.mp4"}]}"#, &headers).is_err());
}
