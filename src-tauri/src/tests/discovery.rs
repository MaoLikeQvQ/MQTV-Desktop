use super::*;

#[test]
fn weekly_preserves_chart_order_and_ignores_unrelated_links() {
    let data = parse_weekly(r#"<a href="https://movie.douban.com/subject/99/">新片榜</a>
      <div id="ranking"><div class="name"><a href="https://movie.douban.com/subject/2/"> 第一部 </a></div>
      <div class="name"><a href="https://movie.douban.com/subject/1/">第二部</a></div>
      <div class="name"><a href="https://movie.douban.com/subject/2/">重复</a></div>
      <div class="name"><a href="https://other.example/subject/3/">错误来源</a></div>
      <div class="name"><a href="https://movie.douban.com/subject/bad/">错误ID</a></div></div>"#).unwrap();
    assert_eq!(
        data,
        json!({"subjects": [{"id":"2","title":"第一部"},{"id":"1","title":"第二部"}]})
    );
}

#[test]
fn weekly_rejects_missing_chart_instead_of_returning_empty_success() {
    assert!(parse_weekly("<html>验证页面</html>").is_err());
}

#[test]
#[ignore = "需要真实访问豆瓣，不使用账号"]
fn weekly_network_smoke() {
    let data =
        tauri::async_runtime::block_on(douban_weekly("https://movie.douban.com/chart".into()))
            .expect("真实豆瓣榜单请求失败");
    let subjects = data["subjects"].as_array().unwrap();
    assert!(!subjects.is_empty());
    assert!(subjects.len() <= 10);
    println!("weekly subjects: {}", subjects.len());
}
