use reqwest::Url;

/// 读取普通选集的响应类型；网页仅提取静态媒体链接，不执行脚本或携带账号凭证。
pub(crate) async fn resolve(
    client: &reqwest::Client,
    url: String,
    headers: reqwest::header::HeaderMap,
) -> Result<(String, Option<crate::MediaProbe>), String> {
    let url = validated_url(&url)?;
    let mut response = client
        .get(url)
        .headers(headers)
        .header("User-Agent", "Mozilla/5.0 MQTV")
        .send()
        .await
        .map_err(|_| "选集地址连接失败")?;
    if !response.status().is_success() {
        return Err(format!("选集地址 HTTP {}", response.status().as_u16()));
    }
    let base = validated_url(response.url().as_str())?;
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let html = content_type.contains("html");
    let first = response
        .chunk()
        .await
        .map_err(|_| "选集响应读取失败")?
        .ok_or("选集响应为空")?;
    let prefix = String::from_utf8_lossy(&first);
    let looks_html = prefix
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with('<');
    if !html && !looks_html {
        let media = first.starts_with(b"#EXTM3U")
            || content_type.starts_with("video/")
            || content_type.starts_with("audio/")
            || (first.len() >= 8 && &first[4..8] == b"ftyp");
        return if media {
            Ok((
                base.to_string(),
                Some(crate::MediaProbe {
                    response,
                    prefix: first.to_vec(),
                }),
            ))
        } else {
            Err("选集响应不是可识别的媒体或播放网页".into())
        };
    }
    let mut bytes = first.to_vec();
    if bytes.len() > 1024 * 1024 {
        return Err("播放网页超过 1 MiB".into());
    }
    while let Some(chunk) = response.chunk().await.map_err(|_| "播放网页读取失败")? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("播放网页超过 1 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    extract(&String::from_utf8_lossy(&bytes), &base).map(|url| (url, None))
}

/// 只接受无用户信息的 HTTP(S) URL，沿用原生媒体代理的协议边界。
pub(crate) fn validated_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "播放地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("播放地址必须为不含凭证的 HTTP(S)".into());
    }
    Ok(url)
}

/// 从静态脚本字符串或 video/source 属性中提取媒体；多个不同媒体不猜选，避免播放广告或其他集。
fn extract(html: &str, base: &Url) -> Result<String, String> {
    let quoted = regex::Regex::new(r#""((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'"#).unwrap();
    let mut urls = Vec::new();
    for captures in quoted.captures_iter(html) {
        let value = if let Some(value) = captures.get(1) {
            serde_json::from_str::<String>(&format!("\"{}\"", value.as_str())).unwrap_or_default()
        } else {
            captures[2].replace("\\/", "/").replace("\\'", "'")
        };
        let value = value.replace("&amp;", "&");
        let Ok(url) = base.join(value.trim()) else {
            continue;
        };
        if validated_url(url.as_str()).is_err() {
            continue;
        }
        let path = url.path().to_ascii_lowercase();
        if ![".m3u8", ".mp4", ".m4v", ".webm", ".mov"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
        {
            continue;
        }
        if !urls.contains(&url) {
            urls.push(url);
        }
    }
    match urls.as_slice() {
        [url] => Ok(url.to_string()),
        [] => Err("网页未提供可提取的媒体直链，可能需要动态脚本或专用解析器".into()),
        _ => Err("网页包含多个媒体地址，无法确定当前选集".into()),
    }
}

#[cfg(test)]
#[path = "tests/static_web.rs"]
mod tests;
