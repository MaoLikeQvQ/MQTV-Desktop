use super::*;
use scraper::Html;

const SITE: &str = "https://anime1.me/";
const INDEX: &str = "https://d1zquzjgwo9yb.cloudfront.net/";
const API: &str = "https://v.anime1.me/api";

async fn get(url: Url) -> Result<String, String> {
    let response = client()?
        .get(url)
        .header("User-Agent", UA)
        .header("Referer", SITE)
        .send()
        .await
        .map_err(|_| "Anime1 连接失败")?;
    Ok(body(response).await?.0)
}
fn parse_index(input: &str, keyword: &str) -> Result<Value, String> {
    let rows: Vec<Vec<Value>> = serde_json::from_str(input).map_err(|_| "Anime1 索引格式无效")?;
    let mut list = Vec::new();
    for row in rows {
        if row.len() < 6 {
            return Err("Anime1 索引字段缺失".into());
        }
        let name = row[1].as_str().ok_or("Anime1 标题格式无效")?;
        if name.to_lowercase().contains(&keyword.to_lowercase()) {
            let id = row[0]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| row[0].to_string());
            if !id.chars().all(|c| c.is_ascii_digit()) || id.is_empty() {
                continue;
            }
            list.push(json!({"vod_id":id,"vod_name":name,"vod_pic":"https://sta.anicdn.com/playerImg/8.jpg","vod_remarks":row[2],"vod_year":row[3]}));
        }
    }
    Ok(json!({"list":list}))
}
/// 独立读取索引，避免依赖先调用首页才能搜索的插件初始化顺序。
pub(super) async fn search(_source: &Source, keyword: &str) -> Result<Value, String> {
    parse_index(&get(http_url(INDEX)?).await?, keyword)
}
fn parse_page(input: &str, base: &Url) -> Result<(Vec<(String, String)>, Option<Url>), String> {
    let doc = Html::parse_document(input);
    let mut episodes = Vec::new();
    for article in doc.select(&selector("article")) {
        let title = article
            .select(&selector("h2"))
            .next()
            .map(text)
            .unwrap_or_else(|| "播放".into());
        for (index, video) in article.select(&selector("video[data-apireq]")).enumerate() {
            let data = video.value().attr("data-apireq").unwrap_or_default();
            if data.is_empty() {
                continue;
            }
            if data.len() > 4096 {
                return Err("Anime1 播放参数过长".into());
            }
            // data-apireq 由页面进行 URI 编码，表单发送前只解码一次。
            let decoded = Url::parse(&format!("https://local.invalid/?d={data}"))
                .map_err(|_| "Anime1 播放参数无效")?
                .query_pairs()
                .find(|(k, _)| k == "d")
                .map(|(_, v)| v.into_owned())
                .ok_or("Anime1 播放参数缺失")?;
            episodes.push((format!("{title} · {}", index + 1), decoded));
        }
    }
    let next = doc
        .select(&selector(".nav-previous a[href]"))
        .next()
        .and_then(|a| a.value().attr("href"))
        .map(|p| base.join(p))
        .transpose()
        .map_err(|_| "Anime1 分页地址无效")?;
    if next.as_ref().is_some_and(|u| u.origin() != base.origin()) {
        return Err("Anime1 分页跳转到其他站点".into());
    }
    Ok((episodes, next))
}
/// 遍历站内分类分页，将播放参数编码为不含 TVBox 分隔符的不透明选集 ID。
pub(super) async fn detail(_source: &Source, id: &str) -> Result<Value, String> {
    use base64::Engine;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Anime1 分类 ID 无效".into());
    }
    let mut url = http_url(SITE)?;
    url.query_pairs_mut().append_pair("cat", id);
    let mut visited = std::collections::HashSet::new();
    let mut seen = std::collections::HashSet::new();
    let mut episodes = Vec::new();
    loop {
        if !visited.insert(url.to_string()) {
            return Err("Anime1 分页出现循环".into());
        }
        if visited.len() > 100 {
            return Err("Anime1 选集分页超过上限".into());
        }
        let html = get(url.clone()).await?;
        let (items, next) = parse_page(&html, &url)?;
        for (name, data) in items {
            if seen.insert(data.clone()) {
                episodes.push(format!(
                    "{}${}",
                    name.replace(['#', '$'], " "),
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
                ));
            }
        }
        match next {
            Some(next) => url = next,
            None => break,
        }
    }
    if episodes.is_empty() {
        return Err("Anime1 未返回可用选集，页面可能已经变更".into());
    }
    episodes.reverse();
    Ok(json!({"list":[{"vod_id":id,"vod_play_from":"Anime1","vod_play_url":episodes.join("#")}]}))
}
fn playback(input: &str, headers: &HeaderMap) -> Result<(String, Value), String> {
    let value: Value = serde_json::from_str(input).map_err(|_| "Anime1 播放响应无效")?;
    let src = value["s"][0]["src"]
        .as_str()
        .ok_or("Anime1 未返回视频地址")?;
    let target = if src.starts_with("//") {
        format!("https:{src}")
    } else {
        src.to_string()
    };
    let url = http_url(&target)?;
    // 仅将 API 媒体会话 Cookie 发给 Anime1 的媒体域，拒绝向任意响应 URL 泄露。
    let host = url.host_str().ok_or("Anime1 视频主机缺失")?;
    if !(host == "anime1.me"
        || host.ends_with(".anime1.me")
        || host == "anicdn.com"
        || host.ends_with(".anicdn.com"))
    {
        return Err("Anime1 返回了未支持的媒体域，需要确认协议变更".into());
    }
    let cookie = headers
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| v.split(';').next())
        .filter(|v| v.contains('='))
        .collect::<Vec<_>>()
        .join("; ");
    Ok((
        target,
        json!({"User-Agent":UA,"Referer":SITE,"Cookie":cookie}),
    ))
}
/// 提交页面参数，合并响应媒体 Cookie；账号 Cookie 仅发送到固定 API。
pub(super) async fn play(source: &Source, id: &str) -> Result<(String, Value), String> {
    use base64::Engine;
    let data = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(id)
        .map_err(|_| "Anime1 选集 ID 无效")?;
    let data = String::from_utf8(data).map_err(|_| "Anime1 播放参数无效")?;
    let auth = authorization(source)?;
    let response = client()?
        .post(API)
        .header("User-Agent", UA)
        .header("Referer", SITE)
        .header("Origin", "https://anime1.me")
        .header("Cookie", auth.cookie)
        .form(&[("d", data)])
        .send()
        .await
        .map_err(|_| "Anime1 播放请求失败")?;
    let (input, headers) = body(response).await?;
    playback(&input, &headers)
}

#[cfg(test)]
#[path = "../../tests/adapters/anime1.rs"]
mod tests;
