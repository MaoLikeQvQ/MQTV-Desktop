use reqwest::Client;
use serde_json::Value;

pub(super) const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";

/// 创建超时为 20 秒且禁止自动重定向的UC HTTP 客户端。
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

/// 合并 UC 响应轮换的 Cookie，同名字段以最新响应为准。
pub(super) fn merge_cookies(current: &str, updates: &[String]) -> String {
    let mut pairs: std::collections::BTreeMap<String, String> = current
        .split(';')
        .filter_map(|part| {
            part.trim()
                .split_once('=')
                .map(|(key, value)| (key.to_string(), value.to_string()))
        })
        .collect();
    for raw in updates {
        if let Some((key, value)) = raw.split(';').next().unwrap_or_default().split_once('=') {
            if !key.trim().is_empty() {
                pairs.insert(key.trim().to_string(), value.to_string());
            }
        }
    }
    pairs
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}
