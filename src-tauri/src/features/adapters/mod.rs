//! 自有站点适配器；只实现已确认协议，不下载或执行订阅中的 Android 插件。
mod anime1;
mod appget;

use reqwest::{Client, Url, header::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const MAX_BODY: usize = 4 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Source {
    key: String,
    api: String,
    #[serde(rename = "type")]
    kind: u32,
    #[serde(default)]
    ext: Value,
}
/// 外部注入的账号信息仅保存在当前进程，既不写订阅也不返回给 React。
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Authorization {
    #[serde(default)]
    token: String,
    #[serde(default)]
    cookie: String,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    user_agent: String,
}
static AUTH: OnceLock<Mutex<HashMap<String, Authorization>>> = OnceLock::new();

fn identity(source: &Source) -> String {
    json!([source.key, source.api, source.kind, source.ext]).to_string()
}
fn authorization(source: &Source) -> Result<Authorization, String> {
    Ok(AUTH
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "授权状态不可用")?
        .get(&identity(source))
        .cloned()
        .unwrap_or_default())
}
fn adapter(source: &Source) -> Result<&str, String> {
    if source.kind != 3 {
        return Err("仅支持 type 3 原生适配来源".into());
    }
    match source.api.as_str() {
        "csp_Anime1" => Ok("anime1"),
        "csp_AppGet" => Ok("appget"),
        _ => Err("该插件尚未实现原生适配".into()),
    }
}
/// 注入或撤销当前来源的外部账号授权；来源配置改变后不会沿用旧凭证。
#[tauri::command]
pub(crate) fn adapter_authorize(
    source: Source,
    authorization: Option<Authorization>,
) -> Result<(), String> {
    adapter(&source)?;
    if let Some(ref a) = authorization {
        for value in [&a.token, &a.cookie, &a.device_id, &a.version, &a.user_agent] {
            if value.len() > 16384 || reqwest::header::HeaderValue::from_str(value).is_err() {
                return Err("授权字段包含无效请求头或超过长度限制".into());
            }
        }
    }
    let mut auth = AUTH
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "授权状态不可用")?;
    let id = identity(&source);
    if let Some(value) = authorization {
        if auth.len() >= 128 && !auth.contains_key(&id) {
            return Err("会话授权数量已达上限，请先撤销不用的授权".into());
        }
        auth.insert(id, value);
    } else {
        auth.remove(&id);
    }
    Ok(())
}
fn config(source: &Source) -> Result<Value, String> {
    match &source.ext {
        Value::Object(_) => Ok(source.ext.clone()),
        Value::String(s) => serde_json::from_str(s).map_err(|_| "适配器需要 JSON 扩展配置".into()),
        _ => Err("适配器缺少扩展配置".into()),
    }
}
fn http_url(value: &str) -> Result<Url, String> {
    let u = Url::parse(value).map_err(|_| "来源地址无效")?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || !(u.scheme() == "https"
            || (u.scheme() == "http"
                && matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
    {
        return Err("适配器地址需要 HTTPS，测试时仅允许回环 HTTP".into());
    }
    Ok(u)
}
fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "创建适配请求失败".into())
}
async fn body(mut response: reqwest::Response) -> Result<(String, HeaderMap), String> {
    if !response.status().is_success() {
        return Err(format!("来源 HTTP {}", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err("来源响应超过 4 MiB".into());
    }
    let headers = response.headers().clone();
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取来源响应失败")? {
        if data.len() + chunk.len() > MAX_BODY {
            return Err("来源响应超过 4 MiB".into());
        }
        data.extend_from_slice(&chunk);
    }
    Ok((
        String::from_utf8(data).map_err(|_| "来源响应不是 UTF-8")?,
        headers,
    ))
}
fn selector(value: &str) -> scraper::Selector {
    scraper::Selector::parse(value).expect("固定选择器有效")
}
fn text(node: scraper::ElementRef<'_>) -> String {
    node.text().collect::<String>().trim().to_string()
}
/// 搜索原生适配来源；不会领取或替换外部账号授权。
#[tauri::command]
pub(crate) async fn adapter_search(source: Source, keyword: String) -> Result<Value, String> {
    let keyword = keyword.trim();
    if keyword.is_empty() || keyword.len() > 1024 {
        return Err("请输入有效片名".into());
    }
    match adapter(&source)? {
        "anime1" => anime1::search(&source, keyword).await,
        _ => appget::search(&source, keyword).await,
    }
}
/// 返回统一影片详情及选集 ID，不把账号凭证嵌入选集或播放历史。
pub(crate) async fn adapter_detail(source: Source, id: String) -> Result<Value, String> {
    if id.len() > 4096 {
        return Err("影片 ID 过长".into());
    }
    match adapter(&source)? {
        "anime1" => anime1::detail(&source, &id).await,
        _ => appget::detail(&source, &id).await,
    }
}
/// 在原生层解析媒体及请求头，通过现有本地代理只返回回环播放地址。
pub(crate) async fn adapter_play(source: Source, id: String) -> Result<Value, String> {
    if id.len() > 4096 {
        return Err("选集 ID 过长".into());
    }
    let (url, headers) = match adapter(&source)? {
        "anime1" => anime1::play(&source, &id).await?,
        _ => appget::play(&source, &id).await?,
    };
    http_url(&url)?;
    Ok(json!({"url":super::scripts::media::start(url, headers).await?}))
}

#[cfg(test)]
#[path = "../../tests/adapters/mod.rs"]
mod tests;
