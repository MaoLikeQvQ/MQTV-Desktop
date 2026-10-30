use super::client::{UA, client};
use reqwest::{Client, Url};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::Mutex;

static TRANSFER: std::sync::Mutex<Option<(String, Arc<AtomicU64>)>> = std::sync::Mutex::new(None);

/// 读取当前媒体会话累计收到的上游字节；地址不匹配时返回未知，避免切集后混入旧传输。
pub fn downloaded_bytes(url: &str) -> Option<u64> {
    let transfer = TRANSFER.lock().ok()?;
    transfer
        .as_ref()
        .filter(|(current, _)| current == url)
        .map(|(_, bytes)| bytes.load(Ordering::Relaxed))
}

static PROXY_TASK: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>> =
    std::sync::Mutex::new(None);

// Keep the account cookie in Rust. A random, single-resource loopback endpoint
// supplies byte ranges to WebView; it cannot proxy arbitrary URLs.
/// 探测 HTTPS 视频资源并启动带随机路径的回环代理，将账号 Cookie 保留在原生层。
/// 支持 Range 请求及 HLS 地址改写，仅向夸克域名发送 Cookie；替换旧监听任务，监听最多持续六小时。
pub(super) async fn media_proxy(target: String, credential: String) -> Result<String, String> {
    use std::hash::{BuildHasher, Hasher};
    let target = Url::parse(&target).map_err(|_| "视频地址无效")?;
    if target.scheme() != "https" || !target.username().is_empty() || target.password().is_some() {
        return Err("视频地址必须为 HTTPS".into());
    }
    let host = target.host_str().unwrap_or_default();
    let mut probe = client()?
        .get(target.clone())
        .header("User-Agent", UA)
        .header("Referer", "https://pan.quark.cn/")
        .header("Range", "bytes=0-4095");
    if host == "quark.cn" || host.ends_with(".quark.cn") {
        probe = probe.header("Cookie", &credential);
    }
    let mut probe = probe
        .send()
        .await
        .map_err(|_| "视频连接失败，本地授权保留")?;
    if !probe.status().is_success() {
        return Err(format!(
            "视频服务 HTTP {}，本地授权保留",
            probe.status().as_u16()
        ));
    }
    let prefix_bytes = probe
        .chunk()
        .await
        .map_err(|_| "视频探测失败")?
        .ok_or("视频响应为空")?;
    let root_is_playlist = prefix_bytes.starts_with(b"#EXTM3U");
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
    let downloaded = Arc::new(AtomicU64::new(0));
    let counter = downloaded.clone();
    let task = spawn_proxy(
        listener,
        address,
        prefix,
        targets,
        credential,
        root_is_playlist,
        counter,
    );
    let mut previous = PROXY_TASK.lock().map_err(|_| "播放通道状态异常")?;
    if let Some(previous) = previous.replace(task) {
        previous.abort();
    }
    *TRANSFER.lock().map_err(|_| "播放流量状态异常")? = Some((output.clone(), downloaded));
    Ok(output)
}

/// 接受的媒体连接归监听任务所有；父任务取消或超时退出时，一并取消全部下载连接。
fn spawn_proxy(
    listener: tokio::net::TcpListener,
    address: std::net::SocketAddr,
    prefix: String,
    targets: Arc<Mutex<Vec<Url>>>,
    credential: String,
    root_is_playlist: bool,
    counter: Arc<AtomicU64>,
) -> tokio::task::JoinHandle<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(6 * 3600);
        while let Ok(Ok((mut socket, _))) =
            tokio::time::timeout_at(deadline, listener.accept()).await
        {
            let targets = targets.clone();
            let downloaded = counter.clone();
            let credential = credential.clone();
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
                request = request
                    .header("User-Agent", UA)
                    .header("Referer", "https://pan.quark.cn/");
                let host = target.host_str().unwrap_or_default();
                if host == "quark.cn" || host.ends_with(".quark.cn") {
                    request = request.header("Cookie", credential);
                }
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
                        downloaded.fetch_add(chunk.len() as u64, Ordering::Relaxed);
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
                            if url.scheme() != "https"
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
                            if url.scheme() != "https"
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
                    downloaded.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                    if socket.write_all(&chunk).await.is_err() {
                        break;
                    }
                }
            });
        }
    })
}

/// 停止媒体监听及其全部已接受连接，不访问或修改账号数据。
pub(super) fn stop() {
    if let Ok(mut transfer) = TRANSFER.lock() {
        *transfer = None;
    }
    if let Ok(mut task) = PROXY_TASK.lock() {
        if let Some(task) = task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
#[path = "../tests/proxy_traffic.rs"]
mod traffic_tests;
