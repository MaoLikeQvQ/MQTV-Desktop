use scraper::{Html, Selector};
use serde_json::{Value, json};
use std::collections::HashSet;

/// 只解析豆瓣一周口碑榜区域，按原始排名提取影片 ID 与标题；结构变化时明确报错。
fn parse_weekly(html: &str) -> Result<Value, String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("#ranking .name a[href]").unwrap();
    let mut seen = HashSet::new();
    let subjects: Vec<Value> = document
        .select(&selector)
        .filter_map(|link| {
            let url = reqwest::Url::parse(link.value().attr("href")?).ok()?;
            if url.scheme() != "https"
                || url.host_str() != Some("movie.douban.com")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return None;
            }
            let segments: Vec<_> = url
                .path_segments()?
                .filter(|part| !part.is_empty())
                .collect();
            if segments.len() != 2 || segments[0] != "subject" {
                return None;
            }
            let id = segments[1];
            let title = link.text().collect::<String>().trim().to_string();
            if id.is_empty()
                || !id.bytes().all(|ch| ch.is_ascii_digit())
                || title.is_empty()
                || !seen.insert(id.to_string())
            {
                return None;
            }
            Some(json!({ "id": id, "title": title }))
        })
        .take(10)
        .collect();
    if subjects.is_empty() {
        return Err("豆瓣一周口碑榜暂不可用或页面格式已变化".into());
    }
    Ok(json!({ "subjects": subjects }))
}

/// 直接读取豆瓣真实一周口碑榜，不登录、不使用后台代理、不替换为热门电影。
#[tauri::command]
pub async fn douban_weekly(url: String) -> Result<Value, String> {
    let bytes = crate::commands::http::get_bytes(url, "text/html").await?;
    let html = std::str::from_utf8(&bytes).map_err(|_| "豆瓣榜单编码异常".to_string())?;
    parse_weekly(html)
}

#[cfg(test)]
#[path = "../tests/discovery.rs"]
mod tests;
