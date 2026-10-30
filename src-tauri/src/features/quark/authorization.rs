use super::{
    client::{UA, client, cookie},
    credentials::{LOCK, Settings, load, save},
};
use serde_json::{Value, json};

/// 提取供前端展示的授权状态与账号元信息，不返回 Cookie 和授权码。
fn metadata(s: &Settings) -> Value {
    json!({"backend":s.backend,"cached":s.lease.is_some(),"accountId":s.lease.as_ref().and_then(|l|l.get("accountId")),"verifiedAt":s.lease.as_ref().and_then(|l|l.get("verifiedAt")),"name":s.lease.as_ref().and_then(|l|l.get("name")),"local":s.lease.as_ref().is_some_and(|l|l["source"] == "local")})
}
/// 读取环境配置后台的授权状态；保留旧命令参数，但拒绝覆盖环境配置。
#[tauri::command]
pub async fn quark_settings(backend: Option<String>) -> Result<Value, String> {
    let configured = crate::config::backend_url()?;
    if let Some(backend) = backend {
        if reqwest::Url::parse(&backend).map_err(|_| "后台地址无效")? != configured {
            return Err("授权后台由 VITE_API_BASE_URL 统一配置，不能单独修改".into());
        }
    }
    let _guard = LOCK.lock().await;
    let s = load()?;
    save(&s)?;
    Ok(metadata(&s))
}
/// 优先复用缓存授权；无缓存时使用内测授权码向后台领取账号，校验响应后保存。
/// excluded 指定本次领取需要排除的账号，调用方负责持有授权锁。
pub(super) async fn lease(s: &mut Settings, excluded: &[String]) -> Result<Value, String> {
    if let Some(cached) = &s.lease {
        return Ok(cached.clone());
    }
    let code = s
        .authorization_code
        .as_deref()
        .filter(|c| !c.is_empty())
        .ok_or("请在授权管理中输入内测授权码，或使用扫码授权")?;
    let url = crate::config::backend_endpoint("/api/authorizations/quark")?;
    let r = client()?
        .post(url)
        .json(&json!({"authorizationCode":code,"excludeAccountIds":excluded}))
        .send()
        .await
        .map_err(|_| "授权服务连接失败；不会清除本地授权")?;
    if r.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("内测授权码缺失或错误".into());
    }
    if !r.status().is_success() {
        return Err(format!(
            "领取授权失败（HTTP {}），请检查后台启用账号",
            r.status().as_u16()
        ));
    }
    let data: Value = r.json().await.map_err(|_| "授权响应无效")?;
    if data["provider"] != "quark"
        || data["credential"]["cookie"]
            .as_str()
            .filter(|x| !x.is_empty())
            .is_none()
        || data["accountId"].as_str().is_none()
    {
        return Err("授权响应字段不完整".into());
    }
    s.lease = Some(data.clone());
    save(s)?;
    Ok(data)
}
/// 在授权锁内获取或复用账号授权，并返回元信息及是否复用缓存。
#[tauri::command]
pub async fn quark_authorize() -> Result<Value, String> {
    let _guard = LOCK.lock().await;
    let mut s = load()?;
    let cached = s.lease.is_some();
    lease(&mut s, &[]).await?;
    let mut result = metadata(&s);
    result["reused"] = json!(cached);
    Ok(result)
}
/// 校验内测授权码并领取对应账号；仅在领取成功后保存替换后的授权设置。
#[tauri::command]
pub async fn quark_authorize_code(authorization_code: String) -> Result<Value, String> {
    let code = authorization_code.trim();
    if code.is_empty() || code.len() > 128 {
        return Err("请输入有效的内测授权码".into());
    }
    let _guard = LOCK.lock().await;
    let mut settings = load()?;
    // Build the replacement in memory; only lease() succeeding persists it.
    settings.authorization_code = Some(code.to_string());
    settings.lease = None;
    lease(&mut settings, &[]).await?;
    Ok(metadata(&settings))
}
// No normal search/play request calls the backend again while a lease is cached.
/// 处理已确认失效的授权：本地扫码账号要求重新扫码，后台账号清除缓存后排除旧账号重新领取。
/// 调用方负责持有授权锁；普通网络或业务错误不应调用此函数。
pub(super) async fn refresh_invalid(s: &mut Settings) -> Result<(), String> {
    if s.lease.as_ref().is_some_and(|l| l["source"] == "local") {
        return Err("本地扫码授权已失效，请在授权管理中重新扫码".into());
    }
    let excluded = s
        .lease
        .as_ref()
        .and_then(|l| l["accountId"].as_str())
        .map(|id| vec![id.to_string()])
        .unwrap_or_default();
    s.lease = None;
    save(s)?;
    lease(s, &excluded).await?;
    Ok(())
}
/// 向夸克验证当前账号；仅明确失效时刷新授权，网络或响应异常保留本地授权。
#[tauri::command]
pub async fn quark_validate() -> Result<Value, String> {
    let _guard = LOCK.lock().await;
    let mut s = load()?;
    let l = lease(&mut s, &[]).await?;
    let check = client()?
        .get("https://pan.quark.cn/account/info?fr=pc&platform=pc")
        .header("Cookie", cookie(&l))
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|_| "账号验证网络失败，本地授权保留")?;
    let invalid = check.status() == 401;
    if !invalid && !check.status().is_success() {
        return Err("账号验证服务暂不可用，本地授权保留".into());
    }
    let data: Value = check
        .json()
        .await
        .map_err(|_| "账号验证响应格式无效，本地授权保留")?;
    if invalid || data["code"] == 401 || data["status"] == 401 {
        refresh_invalid(&mut s).await?;
        return Ok(
            json!({"valid":false,"reassigned":true,"message":"原授权已失效，已领取另一授权，请重新验证"}),
        );
    }
    if data["success"] != true {
        return Err("账号验证未明确成功，本地授权保留".into());
    }
    Ok(json!({"valid":true,"accountId":l["accountId"]}))
}

#[cfg(test)]
#[path = "../../tests/quark/authorization.rs"]
mod code_authorization_tests;
