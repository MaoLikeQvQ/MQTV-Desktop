use super::CredentialStore;
use reqwest::Client;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
pub(super) const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

/// 复用超时为 20 秒且禁止自动重定向的连接池；每次请求独立附加当前账号 Cookie。
pub(super) fn client() -> Result<Client, String> {
    static CLIENT: std::sync::OnceLock<Result<Client, String>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "网络初始化失败".into())
        })
        .clone()
}
/// 调用夸克网盘接口，优先使用本地已保存的 Cookie，并合并保存响应更新的 Cookie。
/// 明确的 401 响应返回 AUTH_INVALID，其他请求失败不会触发重新领取授权。
pub(super) async fn api(
    store: &dyn CredentialStore,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut stored = store.load()?;
    let active_cookie = stored.cookie.clone();
    let url = format!("https://drive-pc.quark.cn/1/clouddrive/{path}");
    let request = if let Some(body) = body {
        client()?.post(&url).json(&body)
    } else {
        client()?.get(&url)
    };
    let r = request
        .header("Cookie", &active_cookie)
        .header("User-Agent", UA)
        .header("Referer", "https://pan.quark.cn/")
        .send()
        .await
        .map_err(|_| "夸克网络请求失败；本地授权保留")?;
    let mut pairs: std::collections::BTreeMap<String, String> = active_cookie
        .split(';')
        .filter_map(|part| {
            part.trim()
                .split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect();
    let mut changed = false;
    for value in r.headers().get_all("set-cookie") {
        if let Ok(value) = value.to_str() {
            if let Some((name, value)) = value.split(';').next().unwrap_or_default().split_once('=')
            {
                pairs.insert(name.trim().to_string(), value.to_string());
                changed = true;
            }
        }
    }
    if changed {
        stored.cookie = pairs
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        store.save(&stored)?;
    }
    let status = r.status().as_u16();
    let data = r.json::<Value>().await.ok();
    decode_api_response(status, path, data)
}

/// 统一解释 HTTP 与夸克业务状态，只有明确的 401 才标记为授权失效。
pub fn decode_api_response(status: u16, path: &str, data: Option<Value>) -> Result<Value, String> {
    if status == 401 || data.as_ref().is_some_and(|value| value["status"] == 401) {
        return Err("AUTH_INVALID".into());
    }
    if path.starts_with("share/") {
        let code = data.as_ref().and_then(|value| value["code"].as_i64().or_else(|| value["code"].as_str().and_then(|code| code.parse().ok())));
        let reason = match code {
            Some(41004) => Some("分享中的文件已删除或不存在"),
            Some(41006) => Some("分享不存在或已失效"),
            _ if status == 404 => Some("分享地址无法访问（HTTP 404）"),
            _ => None,
        };
        if let Some(reason) = reason {
            return Err(format!("{reason}，请切换影片来源；当前授权已保留"));
        }
    }
    if !(200..300).contains(&status) {
        return Err(format!(
            "夸克 {} HTTP {}；不会重新领取授权",
            path.split('?').next().unwrap_or("request"),
            status
        ));
    }
    let data = data.ok_or("夸克响应格式无效")?;
    if data["status"] == 401 {
        return Err("AUTH_INVALID".into());
    }
    if data["status"].as_i64().is_some_and(|s| s != 200)
        || data["code"].as_i64().is_some_and(|s| s != 0)
    {
        return Err(format!(
            "夸克请求未成功（代码 {}）；不视为账号失效",
            data["code"]
        ));
    }
    Ok(data)
}

#[cfg(test)]
#[path = "../tests/client.rs"]
mod tests;
