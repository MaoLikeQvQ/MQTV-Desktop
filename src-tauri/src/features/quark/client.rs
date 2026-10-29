use reqwest::{Client, Url};
use serde_json::Value;

pub(super) const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

/// 校验后台或线路地址：默认要求 HTTPS，仅回环地址及配置后台的同源地址允许 HTTP。
pub(super) fn backend_url(input: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|_| "后台地址无效")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && (matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                    || url.origin() == crate::config::backend_url()?.origin())))
    {
        return Err("后台需要 HTTPS，仅本机回环地址和环境配置的后台允许 HTTP".into());
    }
    Ok(url)
}
/// 创建超时为 20 秒且禁止自动重定向的夸克 HTTP 客户端。
pub(super) fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "网络初始化失败".into())
}
/// 读取授权数据中的 Cookie，字段缺失时返回空字符串。
pub(super) fn cookie(l: &Value) -> &str {
    l["credential"]["cookie"].as_str().unwrap_or_default()
}

#[cfg(test)]
#[path = "../../tests/quark/client.rs"]
mod tests;
