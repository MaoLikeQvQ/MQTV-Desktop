//! 独立播放解析任务，不依赖 Tauri、网盘、应用环境或持久化。
mod static_web;

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    time::{Duration, Instant},
};

pub type Headers = BTreeMap<String, String>;
pub type ParseFuture<'a> = Pin<Box<dyn Future<Output = Result<ParseResult, String>> + Send + 'a>>;

/// 动态网页及 Spider 扩展由宿主提供；任务超时或取消时 drop future，宿主必须同步清理关联资源。
pub trait ParseHost: Send + Sync {
    fn parse<'a>(&'a self, parser: &'a Parser, request: &'a ParseRequest) -> ParseFuture<'a>;
}

/// 对应 TV Parse 的 type、url、请求头及名称；URL 为解析入口前缀。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Parser {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: u8,
    pub url: String,
    #[serde(default)]
    pub headers: Headers,
}

#[derive(Clone, Debug)]
pub struct ParseRequest {
    pub url: String,
    pub flag: String,
    pub headers: Headers,
    pub parser: Option<Parser>,
}

impl ParseRequest {
    /// 构造普通媒体/网页任务，默认不指定第三方解析服务。
    pub fn new(url: String) -> Self {
        Self {
            url,
            flag: String::new(),
            headers: Headers::new(),
            parser: None,
        }
    }
}

/// 返回媒体信息及可选单次探测响应；不持久化凭证或媒体响应。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ParseResult {
    pub url: String,
    pub headers: Headers,
    pub from: String,
    #[serde(skip)]
    pub cache_hit: bool,
    #[serde(skip)]
    probe: Option<std::sync::Arc<std::sync::Mutex<Option<MediaProbe>>>>,
}

/// 单次响应交接，保留已读取的前缀；宿主继续消费响应，避免再次探测。
#[derive(Debug)]
pub struct MediaProbe {
    pub response: reqwest::Response,
    pub prefix: Vec<u8>,
}
impl ParseResult {
    /// 动态宿主构造结果；不包含静态探测响应。
    pub fn new(url: String, headers: Headers, from: String) -> Self {
        Self {
            url,
            headers,
            from,
            ..Default::default()
        }
    }

    /// 单次取出响应；缓存命中不携带响应，克隆结果也不能重复消费。

    pub fn take_probe(&self) -> Option<MediaProbe> {
        self.probe.as_ref()?.lock().ok()?.take()
    }
}

/// 取消当前任务及其网络 future，可在窗口关闭/切集时使用。
#[derive(Clone)]
pub struct Cancellation(tokio::sync::watch::Sender<bool>);
impl Default for Cancellation {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(false).0)
    }
}
impl Cancellation {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }
    async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        loop {
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

/// 参考 TV ParseJob 的类型分派、单次结果、总超时和取消；宿主扩展不在库内执行 Android 代码。
pub struct ParseJob {
    timeout: Duration,
    clients: std::sync::OnceLock<Result<(reqwest::Client, reqwest::Client), String>>,
    cache: std::sync::Mutex<Vec<(String, Instant, ParseResult)>>,
}
impl Default for ParseJob {
    fn default() -> Self {
        Self::new(Duration::from_secs(20))
    }
}
impl ParseJob {
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            clients: Default::default(),
            cache: Default::default(),
        }
    }

    /// 删除指定选集的缓存；缓存结果无法准备媒体时由宿主调用。
    pub fn invalidate(&self, request: &ParseRequest) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.retain(|(key, _, _)| key != &Self::cache_key(request));
        }
    }

    fn cache_key(request: &ParseRequest) -> String {
        serde_json::to_string(&(
            &request.url,
            &request.flag,
            &request.headers,
            &request.parser,
        ))
        .unwrap()
    }

    /// 执行一个选集任务；0=网页，1=JSON，2/3=宿主 Spider 扩展，4=宿主组合解析。
    pub async fn start(
        &self,
        request: ParseRequest,
        cancel: Cancellation,
        host: Option<&dyn ParseHost>,
    ) -> Result<ParseResult, String> {
        tokio::select! { biased;
            _ = cancel.cancelled() => Err("播放解析已取消".into()),
            result = tokio::time::timeout(self.timeout, self.cached_execute(&request, host)) =>
                result.map_err(|_| "播放解析超时".to_string())?,
        }
    }

    async fn cached_execute(
        &self,
        request: &ParseRequest,
        host: Option<&dyn ParseHost>,
    ) -> Result<ParseResult, String> {
        // 动态宿主可能有独立账号状态，没有稳定身份时不缓存。
        let cacheable = host.is_none() && request.parser.as_ref().is_none_or(|p| p.kind <= 1);
        let key = Self::cache_key(request);
        if cacheable {
            let mut cache = self.cache.lock().map_err(|_| "解析缓存状态异常")?;
            cache.retain(|(_, time, _)| time.elapsed() < Duration::from_secs(60));
            if let Some(index) = cache.iter().position(|(k, _, _)| k == &key) {
                let entry = cache.remove(index);
                let mut result = entry.2.clone();
                result.cache_hit = true;
                cache.push(entry);
                return Ok(result);
            }
        }
        let result = self.execute(request, host).await?;
        if cacheable {
            let mut saved = result.clone();
            saved.probe = None;
            let mut cache = self.cache.lock().map_err(|_| "解析缓存状态异常")?;
            cache.retain(|(k, time, _)| k != &key && time.elapsed() < Duration::from_secs(60));
            if cache.len() >= 128 {
                cache.remove(0);
            }
            cache.push((key, Instant::now(), saved));
        }
        Ok(result)
    }

    async fn execute(
        &self,
        request: &ParseRequest,
        host: Option<&dyn ParseHost>,
    ) -> Result<ParseResult, String> {
        static_web::validated_url(&request.url)?;
        let parser = request.parser.clone().unwrap_or_default();
        let mut headers = request.headers.clone();
        headers.extend(parser.headers.clone());
        let header_map = headers
            .iter()
            .map(|(key, value)| {
                let key = reqwest::header::HeaderName::from_bytes(key.as_bytes())
                    .map_err(|_| "解析请求头名称无效")?;
                if matches!(
                    key.as_str(),
                    "host" | "content-length" | "connection" | "transfer-encoding"
                ) {
                    return Err("不允许的解析请求头");
                }
                let value = reqwest::header::HeaderValue::from_str(value)
                    .map_err(|_| "解析请求头值无效")?;
                Ok((key, value))
            })
            .collect::<Result<reqwest::header::HeaderMap, &str>>()?;
        // 客户端不存请求头或 Cookie；请求头始终按任务注入，连接池可安全复用。
        let clients = self
            .clients
            .get_or_init(|| {
                let build = |redirect| {
                    reqwest::Client::builder()
                        .timeout(self.timeout)
                        .redirect(redirect)
                        .build()
                        .map_err(|_| "无法创建解析请求".to_string())
                };
                Ok((
                    build(reqwest::redirect::Policy::limited(5))?,
                    build(reqwest::redirect::Policy::none())?,
                ))
            })
            .as_ref()
            .map_err(Clone::clone)?;
        let client = if headers.is_empty() {
            &clients.0
        } else {
            &clients.1
        };
        let result = match parser.kind {
            0 => {
                let target = format!("{}{}", parser.url, request.url);
                match static_web::resolve(client, target, header_map.clone()).await {
                    Ok((url, probe)) => ParseResult {
                        url,
                        probe: probe.map(|p| std::sync::Arc::new(std::sync::Mutex::new(Some(p)))),
                        cache_hit: false,
                        headers,
                        from: parser.name,
                    },
                    Err(error) => {
                        if let Some(host) = host {
                            host.parse(&parser, request).await?
                        } else {
                            return Err(error);
                        }
                    }
                }
            }
            1 => {
                let target = static_web::validated_url(&format!("{}{}", parser.url, request.url))?;
                let mut response = client
                    .get(target)
                    .headers(header_map.clone())
                    .send()
                    .await
                    .map_err(|_| "JSON 解析连接失败")?;
                if !response.status().is_success() {
                    return Err(format!("JSON 解析 HTTP {}", response.status().as_u16()));
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|_| "JSON 解析读取失败")?
                {
                    if bytes.len() + chunk.len() > 1024 * 1024 {
                        return Err("JSON 解析响应过大".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let value: serde_json::Value =
                    serde_json::from_slice(&bytes).map_err(|_| "JSON 解析响应无效")?;
                let url = value["url"]
                    .as_str()
                    .or_else(|| value["data"]["url"].as_str())
                    .ok_or("JSON 解析未返回地址")?;
                // 复用响应探测，拒绝把 JSON 返回的网页当媒体成功。
                let (url, probe) = static_web::resolve(client, url.into(), header_map).await?;
                ParseResult {
                    url,
                    probe: probe.map(|p| std::sync::Arc::new(std::sync::Mutex::new(Some(p)))),
                    cache_hit: false,
                    headers,
                    from: parser.name,
                }
            }
            2..=4 => {
                host.ok_or("此解析类型需要宿主提供动态/Spider 扩展")?
                    .parse(&parser, request)
                    .await?
            }
            _ => return Err("不支持的解析类型".into()),
        };
        static_web::validated_url(&result.url)?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "tests/job.rs"]
mod tests;
