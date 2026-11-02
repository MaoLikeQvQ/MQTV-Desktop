//! 主动刷新后台租约；授权码和 Cookie 始终留在原生层。
use serde_json::{Value, json};

pub(super) struct Replacement {
    pub(super) code: String,
    pub(super) lease: Value,
}

/// 仅后台账号需要领取；请求和校验完成前不修改调用方的旧授权。
pub(super) async fn replacement<F, Fut>(
    provider: &str,
    current: Option<&Value>,
    own_code: Option<&str>,
    fallback_code: Option<&str>,
    fetch: F,
) -> Result<Option<Replacement>, String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    if current.is_some_and(|lease| lease["source"] == "local") {
        return Ok(None);
    }
    let code = own_code
        .filter(|code| !code.trim().is_empty())
        .or(fallback_code.filter(|code| !code.trim().is_empty()))
        .map(str::trim)
        .filter(|code| code.len() <= 128)
        .ok_or("没有已验证的内测授权码，请先使用授权码验证后再刷新")?
        .to_owned();
    let lease = fetch(code.clone()).await?;
    let cookie = lease["credential"]["cookie"].as_str().unwrap_or_default();
    if lease["provider"] != provider
        || lease["accountId"]
            .as_str()
            .is_none_or(|id| id.trim().is_empty())
        || cookie.is_empty()
        || cookie.contains(['\r', '\n'])
    {
        return Err("后台授权响应无效，原授权已保留".into());
    }
    Ok(Some(Replacement { code, lease }))
}

/// 主动请求环境配置的后台，每次都领取；网络或业务失败不清除本地账号。
pub(super) async fn request(provider: &str, code: String) -> Result<Value, String> {
    let endpoint = crate::config::backend_endpoint(&format!("/api/authorizations/{provider}"))?;
    request_at(endpoint, code).await
}

/// 使用指定后台端点执行真实传输；测试仅将端点替换为本机 HTTP 服务。
async fn request_at(endpoint: reqwest::Url, code: String) -> Result<Value, String> {
    let mut response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "授权网络初始化失败，原授权已保留")?
        .post(endpoint)
        .json(&json!({"authorizationCode":code,"excludeAccountIds":[]}))
        .send()
        .await
        .map_err(|_| "授权服务连接失败，原授权已保留")?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("内测授权码已失效，请重新验证；原授权已保留".into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "后台暂无可领取授权或服务异常（HTTP {}），原授权已保留",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "授权响应读取失败，原授权已保留")?
    {
        if bytes.len() + chunk.len() > 65536 {
            return Err("授权响应过大，原授权已保留".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "授权响应格式无效，原授权已保留".into())
}

#[cfg(test)]
#[path = "../tests/authorization_refresh.rs"]
mod tests;
