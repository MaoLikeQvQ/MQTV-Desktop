// Anime covers load directly; existing discovery requests retain their proxy route.
// Return bytes so WKWebView can display a local blob without cross-origin image restrictions.
/// 下载受支持来源的封面并返回图片字节；默认经后台代理，直连时补充来源对应的请求头。
pub async fn fetch_cover(url: String, direct: Option<bool>) -> Result<Vec<u8>, String> {
    let target = reqwest::Url::parse(&url).map_err(|_| "封面地址无效".to_string())?;
    let host = target.host_str().unwrap_or_default();
    let direct = direct.unwrap_or(false);
    let bangumi = direct && host == "lain.bgm.tv";
    if target.scheme() != "https"
        || !(host == "doubanio.com" || host.ends_with(".doubanio.com") || bangumi)
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err("封面来源不支持".into());
    }
    let request_url = if direct {
        target.clone()
    } else {
        let mut proxy = crate::config::backend_endpoint("/api/proxy")?;
        proxy.query_pairs_mut().append_pair("url", target.as_str());
        proxy
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(request_url);
    if direct {
        request = request
            .header(reqwest::header::USER_AGENT, "Mozilla/5.0 MQTV/0.1")
            .header(
                reqwest::header::REFERER,
                if bangumi {
                    "https://bgm.tv/"
                } else {
                    "https://movie.douban.com/"
                },
            );
    }
    download_image(request).await
}

/// 从不含凭证的 HTTP(S) 地址下载图片，供前端创建本地图片资源。
pub async fn fetch_image(url: String) -> Result<Vec<u8>, String> {
    let target = reqwest::Url::parse(&url).map_err(|_| "图片地址无效".to_string())?;
    if !matches!(target.scheme(), "http" | "https")
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err("仅支持不含凭证的 HTTP 图片地址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;
    download_image(
        client
            .get(target)
            .header(reqwest::header::USER_AGENT, "Mozilla/5.0 MQTV/0.1"),
    )
    .await
}

/// 执行图片请求并校验成功状态及支持的图片 MIME 类型，读取时将内容限制为 4 MiB。
async fn download_image(request: reqwest::RequestBuilder) -> Result<Vec<u8>, String> {
    let mut response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("封面 HTTP {}", response.status()));
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !matches!(
        mime.split(';').next(),
        Some("image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif")
    ) {
        return Err("封面格式不支持".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("封面过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
