/// 请求不含凭证的 HTTP(S) 地址并解析 JSON，限制超时为 15 秒、重定向为 5 次、响应为 8 MiB。
#[tauri::command]
pub async fn fetch_json(url: String) -> Result<serde_json::Value, String> {
    let bytes = get_bytes(url, "application/json").await?;
    serde_json::from_slice(&bytes).map_err(|_| "响应不是有效 JSON".into())
}

/// 统一读取无凭证 HTTP(S) 响应，保留超时、状态、重定向和大小校验，供原生 JSON 与网页解析复用。
pub(crate) async fn get_bytes(url: String, accept: &str) -> Result<Vec<u8>, String> {
    let url = reqwest::Url::parse(&url).map_err(|_| "地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅支持不含凭证的 HTTP 地址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, accept)
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0 MQTV/0.1")
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("响应内容过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// 向配置后台提交匿名搜索评分，仅允许固定接口及有界搜索事件，不携带账号凭证。
#[tauri::command]
pub async fn report_search_quality(events: Vec<serde_json::Value>) -> Result<(), String> {
    if events.is_empty()
        || events.len() > 20
        || events.iter().any(|event| event["kind"] != "search")
    {
        return Err("无效搜索统计批次".into());
    }
    let body =
        serde_json::to_vec(&serde_json::json!({"events": events})).map_err(|_| "统计序列化失败")?;
    if body.len() > 32 * 1024 {
        return Err("统计批次过大".into());
    }
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "统计连接初始化失败")?
        .post(crate::config::backend_endpoint("/api/resources/quality")?)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| "统计上报连接失败")?;
    if !response.status().is_success() {
        return Err(format!("统计上报 HTTP {}", response.status().as_u16()));
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "统计响应读取失败")? {
        if bytes.len() + chunk.len() > 4096 {
            return Err("统计响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let result: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "统计响应无效")?;
    if result["accepted"] != true {
        return Err("后台未确认接收统计".into());
    }
    Ok(())
}
