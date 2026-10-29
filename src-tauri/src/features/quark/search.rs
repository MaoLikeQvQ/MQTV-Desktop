use super::client::{UA, backend_url, client};
use reqwest::Url;
use scraper::{Html, Selector};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Serialize)]
pub struct SearchResult {
    title: String,
    pub(super) url: String,
    poster: Option<String>,
    remarks: String,
    category: String,
    year: String,
}
/// 从线路 HTML 中提取同主机的影片详情链接并去重，将封面、更新信息、分类和年份关联到对应卡片。
fn parse_search(html: &str, base: &Url) -> Vec<SearchResult> {
    let doc = Html::parse_document(html);
    let selector = Selector::parse("a[href]").unwrap();
    let mut seen = HashSet::new();
    doc.select(&selector)
        .filter_map(|a| {
            let href = a.value().attr("href")?;
            if !href.contains("/voddetail/") {
                return None;
            }
            let url = base.join(href).ok()?;
            if url.host_str() != base.host_str() || !seen.insert(url.to_string()) {
                return None;
            }
            let title = a
                .value()
                .attr("title")
                .map(String::from)
                .unwrap_or_else(|| a.text().collect::<String>().trim().to_string());
            if title.is_empty() {
                seen.remove(url.as_str());
                return None;
            }
            let card = a
                .ancestors()
                .filter_map(scraper::ElementRef::wrap)
                .find(|el| {
                    el.value()
                        .attr("class")
                        .is_some_and(|v| v.split_whitespace().any(|c| c == "module-search-item"))
                });
            let poster = card
                .and_then(|card| card.select(&Selector::parse("img").unwrap()).next())
                .and_then(|img| {
                    img.value()
                        .attr("data-src")
                        .or_else(|| img.value().attr("data-original"))
                        .or_else(|| img.value().attr("src"))
                })
                .and_then(|src| base.join(src).ok())
                .filter(|u| matches!(u.scheme(), "http" | "https"))
                .map(|u| u.to_string());
            let remarks = card
                .and_then(|card| {
                    card.select(&Selector::parse(".video-serial").unwrap())
                        .next()
                })
                .map(|el| el.text().collect::<String>().trim().to_string())
                .unwrap_or_default();
            let tags = card
                .map(|card| {
                    card.select(&Selector::parse(".video-info-aux a").unwrap())
                        .map(|el| el.text().collect::<String>().trim().to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let year = tags
                .iter()
                .find(|t| t.len() == 4 && t.chars().all(|c| c.is_ascii_digit()))
                .cloned()
                .unwrap_or_default();
            let category = tags
                .iter()
                .find(|t| !t.is_empty() && t.as_str() != year)
                .cloned()
                .unwrap_or_default();
            Some(SearchResult {
                title,
                url: url.to_string(),
                poster,
                remarks,
                category,
                year,
            })
        })
        .collect()
}
/// 校验线路地址与搜索词，编码路径片段后请求搜索页，并解析大小校验通过的 HTML。
#[tauri::command]
pub async fn quark_line_search(site: String, keyword: String) -> Result<Vec<SearchResult>, String> {
    let base = backend_url(&site)?;
    if keyword.trim().is_empty() {
        return Err("请输入片名".into());
    }
    let mut url = base
        .join("/index.php/vodsearch/")
        .map_err(|_| "站点地址无效")?;
    url.path_segments_mut()
        .map_err(|_| "站点路径无效")?
        .pop_if_empty()
        .push(&format!("{}----------1---.html", keyword.trim()));
    let r = client()?
        .get(url)
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|_| "线路连接失败")?;
    if !r.status().is_success() {
        return Err(format!("线路 HTTP {}", r.status().as_u16()));
    }
    let html = read_line_body(r).await?;
    Ok(parse_search(&html, &base))
}
/// 读取线路详情页，提取并去重 HTTPS 夸克分享链接；没有可用链接时返回适配提示。
#[tauri::command]
pub async fn quark_line_detail(url: String) -> Result<Vec<String>, String> {
    parse_shares(&line_detail_html(&url).await?)
}
/// 读取同一份详情响应中的简介和夸克分享，供详情页展示，避免重复访问站点。
#[tauri::command]
pub async fn quark_line_info(url: String) -> Result<serde_json::Value, String> {
    let html = line_detail_html(&url).await?;
    Ok(serde_json::json!({"shares": parse_shares(&html)?, "synopsis": parse_synopsis(&html)}))
}
/// 从站点正文区域提取纯文本简介，排除脚本和页面其他区域。
fn parse_synopsis(html: &str) -> String {
    let doc = Html::parse_document(html);
    for selector in [
        ".vod_content",
        ".module-info-introduction-content",
        ".module-info-introduction",
        ".video-info-content",
        ".stui-content__desc",
    ] {
        if let Some(node) = doc.select(&Selector::parse(selector).unwrap()).next() {
            let text = node
                .text()
                .collect::<Vec<_>>()
                .join(" ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if !text.is_empty() {
                return text;
            }
        }
    }
    String::new()
}
/// 请求有大小和状态限制的影片详情 HTML。
async fn line_detail_html(url: &str) -> Result<String, String> {
    let base = backend_url(url)?;
    let r = client()?
        .get(base)
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|_| "详情连接失败")?;
    if !r.status().is_success() {
        return Err("线路详情请求失败".into());
    }
    read_line_body(r).await
}
/// 同时解析链接和站点复制按钮属性，仅保留有效 HTTPS 夸克分享并去重。
fn parse_shares(html: &str) -> Result<Vec<String>, String> {
    let doc = Html::parse_document(html);
    let selector = Selector::parse("a[href], [data-clipboard-text]").unwrap();
    let pattern =
        regex::Regex::new(r"https://pan\.quark\.cn/s/[A-Za-z0-9]+(?:\?pwd=[A-Za-z0-9]+)?").unwrap();
    let mut urls = Vec::new();
    for node in doc.select(&selector) {
        for value in [
            node.value().attr("href"),
            node.value().attr("data-clipboard-text"),
        ]
        .into_iter()
        .flatten()
        {
            for matched in pattern.find_iter(value) {
                let tail = &value[matched.end()..];
                if tail
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                {
                    continue;
                }
                let share = matched.as_str().to_string();
                if !urls.contains(&share) {
                    urls.push(share);
                }
            }
        }
    }
    if urls.is_empty() {
        return Err("该详情未提供可直接读取的夸克分享链接，可能需要其他插件适配".into());
    }
    Ok(urls)
}
/// 分块限制线路响应大小，避免详情页在完整读取后才发现超限。
async fn read_line_body(mut response: reqwest::Response) -> Result<String, String> {
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "线路读取失败")? {
        if data.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("线路响应过大".into());
        }
        data.extend_from_slice(&chunk);
    }
    String::from_utf8(data).map_err(|_| "线路响应不是 UTF-8".into())
}

#[cfg(test)]
#[path = "../../tests/quark/search.rs"]
mod tests;
