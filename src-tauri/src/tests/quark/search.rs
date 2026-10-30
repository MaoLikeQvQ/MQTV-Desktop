use super::super::files::share_id;
use super::*;
#[test]
fn reads_clipboard_links_with_codes_and_deduplicates() {
    let html = r#"<div data-clipboard-text='https://pan.quark.cn/s/abc123?pwd=AB12'></div><a href='https://pan.quark.cn/s/abc123?pwd=AB12'>重复</a><div data-clipboard-text='https://pan.quark.cn.evil.test/s/no'></div>"#;
    assert_eq!(
        parse_shares(html).unwrap(),
        vec!["https://pan.quark.cn/s/abc123?pwd=AB12"]
    );
    assert!(parse_shares("没有链接").is_err());
}
/// 验证线路搜索结果去除重复链接，并排除其他主机的详情链接。
#[test]
fn parses_line_results_without_duplicates() {
    let base = Url::parse("https://www.wogg.net/").unwrap();
    let result = parse_search(
        "<a href='/voddetail/1.html' title='影片一'></a><a href='/voddetail/1.html'>重复</a><a href='https://other.test/voddetail/2'>恶意</a>",
        &base,
    );
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].title, "影片一");
}
/// 验证影片标题、封面、更新信息、分类和年份取自同一搜索卡片。
#[test]
fn reads_search_card_metadata_from_the_same_movie() {
    let html = "<div class='module-search-item'><a href='/voddetail/1.html' title='影片'><img data-src='/cover.jpg'></a><a class='video-serial'>更新至第12集</a><div class='video-info-aux'><a>动漫</a><a>2023</a></div></div>";
    let result = parse_search(html, &Url::parse("https://www.wogg.net/").unwrap());
    assert_eq!(
        result[0].poster.as_deref(),
        Some("https://www.wogg.net/cover.jpg")
    );
    assert_eq!(result[0].remarks, "更新至第12集");
    assert_eq!(result[0].category, "动漫");
    assert_eq!(result[0].year, "2023");
}
/// 验证拒绝非夸克分享及不受允许的 HTTP 后台，并接受配置后台与回环地址。
#[test]
fn rejects_non_quark_shares_and_insecure_backends() {
    assert!(share_id("https://evil.test/s/123").is_err());
    assert!(backend_url("http://remote.test").is_err());
    assert!(backend_url(crate::config::backend_url().unwrap().as_str()).is_ok());
    let mut lookalike = crate::config::backend_url().unwrap();
    let host = format!("{}.evil.test", lookalike.host_str().unwrap());
    lookalike.set_host(Some(&host)).unwrap();
    lookalike.set_scheme("http").unwrap();
    assert!(backend_url(lookalike.as_str()).is_err());
    assert!(backend_url("http://127.0.0.1:3101").is_ok());
    assert_eq!(share_id("https://pan.quark.cn/s/abc123").unwrap(), "abc123");
}

#[test]
fn reads_synopsis_from_detail_content_only() {
    assert_eq!(
        parse_synopsis(
            "<nav>导航</nav><div class='module-info-introduction-content'><p>故事 简介</p></div>"
        ),
        "故事 简介"
    );
    assert_eq!(parse_synopsis("<nav>导航</nav>"), "");
}
