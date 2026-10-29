use super::{CredentialStore, LOCK};
use serde_json::{Value, json};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
#[derive(Clone)]
struct Login {
    id: String,
    token: String,
    cookie: String,
    expires: Instant,
    last_poll: Instant,
}
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SESSION: Mutex<Option<Login>> = Mutex::const_new(None);
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
/// 使用当前时间的纳秒数生成扫码接口的请求标识。
fn request_id() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string()
}
/// 发送扫码登录 GET 请求，校验 HTTP 状态并返回 JSON 与合并后的 Cookie。
async fn request(url: &str, cookie: &str) -> Result<(Value, String), String> {
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "网络初始化失败")?
        .get(url)
        .header("User-Agent", UA)
        .header("Referer", "https://pan.quark.cn/")
        .header("Cookie", cookie)
        .send()
        .await
        .map_err(|_| "扫码请求网络失败，请重试")?;
    if !response.status().is_success() {
        return Err(format!(
            "扫码服务暂不可用（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let mut pairs = std::collections::BTreeMap::new();
    for part in cookie.split(';').chain(
        response
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|v| v.split(';').next()),
    ) {
        if let Some((name, value)) = part.trim().split_once('=') {
            pairs.insert(name.to_string(), value.to_string());
        }
    }
    let merged = pairs
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ");
    Ok((
        response.json().await.map_err(|_| "扫码响应格式无效")?,
        merged,
    ))
}
/// 申请扫码令牌并创建有效期为 180 秒的内存会话，返回扫码地址；仅最新一轮生成可写入会话。
pub async fn quark_qr_create() -> Result<Value, String> {
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let id = request_id();
    let (data,cookie)=request(&format!("https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id={id}"),"").await?;
    let token = data["data"]["members"]["token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or("夸克未返回扫码令牌")?
        .to_string();
    let mut url = reqwest::Url::parse("https://su.quark.cn/4_eMHBJ").map_err(|_| "扫码地址无效")?;
    url.query_pairs_mut().extend_pairs([
        ("token", token.as_str()),
        ("client_id", "532"),
        ("ssb", "weblogin"),
        ("uc_param_str", ""),
        (
            "uc_biz_str",
            "S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0",
        ),
    ]);
    let mut session = SESSION.lock().await;
    if GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation {
        return Err("二维码生成已取消".into());
    }
    *session = Some(Login {
        id: id.clone(),
        token,
        cookie,
        expires: Instant::now() + Duration::from_secs(180),
        last_poll: Instant::now() - Duration::from_secs(3),
    });
    Ok(json!({"id":id,"scanUrl":url.as_str(),"state":"waiting"}))
}
/// 取消与指定标识匹配的扫码会话，阻止该会话继续完成授权保存。
pub async fn quark_qr_cancel(id: String) {
    let mut session = SESSION.lock().await;
    if session.as_ref().is_some_and(|s| s.id == id) {
        *session = None;
    }
}
/// 轮询指定扫码会话，处理过期状态并限制轮询间隔；确认登录后交换、验证账号并保存授权。
/// 保存前再次检查会话仍有效，避免对话框关闭后写入授权。
pub async fn quark_qr_poll(store: &dyn CredentialStore, id: String) -> Result<Value, String> {
    let login = {
        let mut session = SESSION.lock().await;
        let Some(login) = session.as_mut().filter(|s| s.id == id) else {
            return Ok(json!({"state":"expired"}));
        };
        if Instant::now() >= login.expires {
            *session = None;
            return Ok(json!({"state":"expired"}));
        }
        if login.last_poll.elapsed() < Duration::from_millis(2500) {
            return Ok(json!({"state":"waiting"}));
        }
        login.last_poll = Instant::now();
        login.clone()
    };
    let mut url =
        reqwest::Url::parse("https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken")
            .map_err(|_| "扫码地址无效")?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", "532"),
        ("v", "1.2"),
        ("token", login.token.as_str()),
        ("request_id", request_id().as_str()),
    ]);
    let (data, cookie) = request(url.as_str(), &login.cookie).await?;
    let Some(ticket) = data["data"]["members"]["service_ticket"].as_str() else {
        if data["status"] != 50004001 {
            return Err("扫码查询未完成，请重试或重新生成二维码".into());
        }
        let mut session = SESSION.lock().await;
        if let Some(s) = session.as_mut().filter(|s| s.id == id) {
            s.cookie = cookie;
        }
        return Ok(json!({"state":"waiting"}));
    };
    let mut account_url =
        reqwest::Url::parse("https://pan.quark.cn/account/info").map_err(|_| "账号地址无效")?;
    account_url
        .query_pairs_mut()
        .extend_pairs([("st", ticket), ("lw", "scan")]);
    let (account, cookie) = request(account_url.as_str(), &cookie).await?;
    if account["success"] != true {
        return Err("扫码已确认，但凭证交换失败".into());
    }
    let (check, cookie) = request(
        "https://pan.quark.cn/account/info?fr=pc&platform=pc",
        &cookie,
    )
    .await?;
    let name = check["data"]["nickname"]
        .as_str()
        .filter(|n| !n.trim().is_empty())
        .ok_or("已扫码，但独立账号验证失败")?;
    if check["success"] != true {
        return Err("账号验证失败".into());
    }
    // Closing the dialog cancels installation even if a network request was in flight.
    let mut session = SESSION.lock().await;
    if !session
        .as_ref()
        .is_some_and(|s| s.id == id && Instant::now() < s.expires)
    {
        return Ok(json!({"state":"expired"}));
    }
    let _guard = LOCK.lock().await;
    store.install_login(&id, name, &cookie)?;
    *session = None;
    Ok(json!({"state":"verified"}))
}

#[cfg(test)]
#[path = "../tests/login.rs"]
mod tests;
