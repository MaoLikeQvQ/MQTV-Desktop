use serde_json::Value;
const UA: &str = "Mozilla/5.0 MQTV";
/// 建立不跟随重定向的媒体客户端，避免跨站泄露插件请求头。
fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建媒体请求".into())
}
use reqwest::{Client, Url};
use tokio::sync::Mutex;

static PROXY_TASK: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>> =
    std::sync::Mutex::new(None);

static START_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 使等待探测的旧播放请求失效，不中断当前已起播媒体。
pub(crate) fn invalidate_pending() {
    START_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// 启动随机回环媒体代理；仅转发已登记资源，保留 HLS 与 Range。
pub(crate) async fn start(target: String, headers: Value) -> Result<String, String> {
    let generation = START_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let headers = validated_headers(headers)?;
    use std::hash::{BuildHasher, Hasher};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let target = Url::parse(&target).map_err(|_| "视频地址无效")?;
    if !matches!(target.scheme(), "http" | "https")
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err("视频地址必须为 HTTP(S)".into());
    }
    let probe = client()?
        .get(target.clone())
        .header("User-Agent", UA)
        .headers(headers.clone())
        .header("Range", "bytes=0-4095");
    let mut probe = probe
        .send()
        .await
        .map_err(|_| "视频连接失败，插件播放失败")?;
    if !probe.status().is_success() {
        return Err(format!(
            "视频服务 HTTP {}，插件播放失败",
            probe.status().as_u16()
        ));
    }
    let prefix_bytes = probe
        .chunk()
        .await
        .map_err(|_| "视频探测失败")?
        .ok_or("视频响应为空")?;
    let content_type = probe
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("text/html")
        || String::from_utf8_lossy(&prefix_bytes)
            .trim_start()
            .starts_with('<')
    {
        return Err("播放地址返回网页，当前未支持网页嗅探".into());
    }
    let root_is_playlist = prefix_bytes.starts_with(b"#EXTM3U") || content_type.contains("mpegurl");
    let token = format!(
        "{:016x}{:016x}",
        std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish(),
        std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish()
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "无法启动本地播放通道")?;
    let address = listener.local_addr().map_err(|_| "无法读取播放端口")?;
    let prefix = format!("/{token}/");
    let extension = if root_is_playlist { "m3u8" } else { "mp4" };
    let output = format!("http://{address}{prefix}0/stream.{extension}");
    let targets = std::sync::Arc::new(Mutex::new(vec![target]));
    let task = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(6 * 3600);
        while let Ok(Ok((mut socket, _))) =
            tokio::time::timeout_at(deadline, listener.accept()).await
        {
            let targets = targets.clone();
            let headers = headers.clone();
            let prefix = prefix.clone();
            while connections.try_join_next().is_some() {}
            connections.spawn(async move {
                let mut request = Vec::new();
                loop {
                    let mut buf = [0u8; 1024];
                    let n = match tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        socket.read(&mut buf),
                    )
                    .await
                    {
                        Ok(Ok(n)) if n > 0 => n,
                        _ => return,
                    };
                    request.extend_from_slice(&buf[..n]);
                    if request.len() > 16384 {
                        return;
                    }
                    if request.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&request);
                let mut lines = text.lines();
                let first = lines.next().unwrap_or_default();
                let parts: Vec<_> = first.split_whitespace().collect();
                if parts.len() != 3
                    || !parts[1].starts_with(&prefix)
                    || !matches!(parts[0], "GET" | "HEAD")
                {
                    let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    return;
                }
                let index = parts[1]
                    .strip_prefix(&prefix)
                    .and_then(|p| p.split('/').next())
                    .and_then(|p| p.parse::<usize>().ok());
                let target = {
                    let urls = targets.lock().await;
                    index.and_then(|i| urls.get(i).cloned())
                };
                let Some(target) = target else {
                    return;
                };
                let Ok(http) = Client::builder()
                    .timeout(std::time::Duration::from_secs(120))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                else {
                    return;
                };
                let mut request = if parts[0] == "HEAD" {
                    http.head(target.clone())
                } else {
                    http.get(target.clone())
                };
                request = request.header("User-Agent", UA).headers(headers.clone());
                if target.origin() != targets.lock().await[0].origin() { request = request.header("Cookie", "").header("Authorization", ""); }
                for line in lines {
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("range")
                            && !(index == Some(0) && root_is_playlist)
                            && !target.path().ends_with(".m3u8")
                        {
                            request = request.header("Range", value.trim());
                        }
                    }
                }
                let Ok(mut response) = request.send().await else {
                    let _ = socket.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    return;
                };
                #[cfg(test)]
                println!(
                    "media upstream host={} status={}",
                    target.host_str().unwrap_or_default(),
                    response.status().as_u16()
                );
                let playlist = (index == Some(0) && root_is_playlist)
                    || target.path().ends_with(".m3u8")
                    || response
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|m| m.contains("mpegurl"));
                if playlist && response.status().is_success() && parts[0] != "HEAD" {
                    let mut bytes = Vec::new();
                    while let Ok(Some(chunk)) = response.chunk().await {
                        if bytes.len() + chunk.len() > 1024 * 1024 {
                            return;
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    let Ok(text) = String::from_utf8(bytes) else {
                        return;
                    };
                    if !text.trim_start().starts_with("#EXTM3U") {
                        return;
                    }
                    let mut urls = targets.lock().await;
                    let mut rewritten = String::new();
                    for line in text.lines() {
                        let line = line.trim();
                        if !line.starts_with('#') && !line.is_empty() {
                            let Ok(url) = target.join(line) else {
                                return;
                            };
                            if !matches!(url.scheme(), "http" | "https")
                                || !url.username().is_empty()
                                || url.password().is_some()
                            {
                                return;
                            }
                            let id = urls.iter().position(|v| v == &url).unwrap_or_else(|| {
                                urls.push(url);
                                urls.len() - 1
                            });
                            rewritten
                                .push_str(&format!("http://{address}{prefix}{id}/stream.m3u8"));
                        } else if let Some((before, after)) = line.split_once("URI=\"") {
                            let Some((uri, tail)) = after.split_once('"') else {
                                return;
                            };
                            let Ok(url) = target.join(uri) else {
                                return;
                            };
                            if !matches!(url.scheme(), "http" | "https")
                                || !url.username().is_empty()
                                || url.password().is_some()
                            {
                                return;
                            }
                            let id = urls.iter().position(|v| v == &url).unwrap_or_else(|| {
                                urls.push(url);
                                urls.len() - 1
                            });
                            rewritten.push_str(&format!(
                                "{before}URI=\"http://{address}{prefix}{id}/stream.m3u8\"{tail}"
                            ));
                        } else {
                            rewritten.push_str(line);
                        }
                        rewritten.push('\n');
                    }
                    let headers = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        rewritten.len()
                    );
                    let _ = socket.write_all(headers.as_bytes()).await;
                    let _ = socket.write_all(rewritten.as_bytes()).await;
                    return;
                }
                let status = response.status();
                let mut headers = format!(
                    "HTTP/1.1 {} {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n",
                    status.as_u16(),
                    status.canonical_reason().unwrap_or("")
                );
                for name in [
                    "content-type",
                    "content-length",
                    "content-range",
                    "accept-ranges",
                ] {
                    if let Some(value) = response.headers().get(name).and_then(|v| v.to_str().ok())
                    {
                        headers.push_str(&format!("{name}: {value}\r\n"));
                    }
                }
                headers.push_str("\r\n");
                if socket.write_all(headers.as_bytes()).await.is_err() || parts[0] == "HEAD" {
                    return;
                }
                while let Ok(Some(chunk)) = response.chunk().await {
                    if socket.write_all(&chunk).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    let mut previous = PROXY_TASK.lock().map_err(|_| "播放通道状态异常")?;
    if START_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation {
        task.abort();
        return Err("播放请求已过期".into());
    }
    if let Some(previous) = previous.replace(task) {
        previous.abort();
    }
    Ok(output)
}

/// 校验插件媒体请求头，禁止覆盖代理协议和连接语义。
fn validated_headers(value: Value) -> Result<reqwest::header::HeaderMap, String> {
    let value = if let Some(text) = value.as_str() {
        serde_json::from_str(text).map_err(|_| "播放请求头不是 JSON")?
    } else {
        value
    };
    let map = value.as_object().ok_or("播放请求头必须是对象")?;
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in map {
        if [
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "range",
        ]
        .contains(&name.to_ascii_lowercase().as_str())
        {
            return Err("插件含不允许的播放请求头".into());
        }
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "播放请求头名称无效")?;
        let value = reqwest::header::HeaderValue::from_str(
            value.as_str().ok_or("播放请求头值必须是字符串")?,
        )
        .map_err(|_| "播放请求头值无效")?;
        headers.insert(name, value);
    }
    Ok(headers)
}
/// 关闭当前脚本媒体代理，影片切换和应用取消时使用。
pub(crate) fn stop() {
    invalidate_pending();
    if let Ok(mut task) = PROXY_TASK.lock() {
        if let Some(task) = task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
#[path = "../../tests/scripts/media.rs"]
mod tests;
