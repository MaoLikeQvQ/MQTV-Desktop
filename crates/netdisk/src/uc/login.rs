use super::{CredentialStore, LOCK};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

#[derive(Clone)]
struct Login {
    id: String,
    generation: u64,
    token: String,
    cookie: String,
    expires: Instant,
    last_poll: Instant,
}
static GENERATION: AtomicU64 = AtomicU64::new(0);
static SESSION: Mutex<Option<Login>> = Mutex::const_new(None);
const CAS_CLIENT_ID: &str = "381";
const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

fn request_id() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

/// 扫码传输与账号存储分离；测试替换传输即可验证完整状态流，不访问真实账号。
trait Transport: Sync {
    fn request(
        &self,
        url: &str,
        cookie: &str,
        form: Option<&str>,
    ) -> impl std::future::Future<Output = Result<(Value, String), String>> + Send;
}
struct Http;
impl Transport for Http {
    async fn request(
        &self,
        url: &str,
        cookie: &str,
        form: Option<&str>,
    ) -> Result<(Value, String), String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "UC网络初始化失败")?;
        let request = if let Some(form) = form {
            client
                .post(url)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(form.to_owned())
        } else {
            client.get(url)
        };
        let mut response = request
            .header("User-Agent", UA)
            .header("Referer", "https://drive.uc.cn/")
            .header("Origin", "https://drive.uc.cn")
            .header("Cookie", cookie)
            .send()
            .await
            .map_err(|_| "UC扫码请求网络失败，请重试")?;
        if !response.status().is_success() {
            return Err(format!(
                "UC扫码服务暂不可用（HTTP {}）",
                response.status().as_u16()
            ));
        }
        let merged = merge_cookies(
            cookie,
            response
                .headers()
                .get_all("set-cookie")
                .iter()
                .filter_map(|value| value.to_str().ok()),
        );
        if reqwest::Url::parse(url).is_ok_and(|url| url.path() == "/") {
            return Ok((Value::Null, merged));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "UC扫码响应读取失败")? {
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err("UC扫码响应过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((
            serde_json::from_slice(&bytes).map_err(|_| "UC扫码响应格式无效")?,
            merged,
        ))
    }
}

/// 按官网协议构造 CAS 表单；二维码确认页必须使用相同的客户端标识。
fn cas_form(token: Option<&str>) -> String {
    let mut form = reqwest::Url::parse("https://api.open.uc.cn/").expect("static CAS URL");
    form.query_pairs_mut().extend_pairs([
        ("client_id", CAS_CLIENT_ID),
        ("v", "1.2"),
        ("request_id", request_id().as_str()),
    ]);
    if let Some(token) = token {
        form.query_pairs_mut().append_pair("token", token);
    }
    form.query().unwrap().to_owned()
}

fn merge_cookies<'a>(cookie: &str, headers: impl Iterator<Item = &'a str>) -> String {
    let mut pairs = std::collections::BTreeMap::new();
    for pair in cookie
        .split(';')
        .chain(headers.filter_map(|value| value.split(';').next()))
    {
        if let Some((name, value)) = pair.trim().split_once('=') {
            if !name.is_empty() {
                pairs.insert(name.to_owned(), value.to_owned());
            }
        }
    }
    pairs
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn has_download_cookie(cookie: &str) -> bool {
    cookie
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .any(|(key, value)| key == "__puus" && !value.is_empty())
}

/// 申请 UC 扫码令牌并创建三分钟会话；生成新码会使旧会话立即失效。
pub async fn uc_qr_create() -> Result<Value, String> {
    create(&Http).await
}
async fn create(transport: &impl Transport) -> Result<Value, String> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut session = SESSION.lock().await;
        if GENERATION.load(Ordering::SeqCst) != generation {
            return Err("二维码生成已取消".into());
        }
        *session = None;
    }
    let id = request_id();
    let (data, cookie) = transport
        .request(
            "https://api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin",
            "",
            Some(&cas_form(None)),
        )
        .await?;
    let token = data["data"]["members"]["token"]
        .as_str()
        .filter(|value| !value.is_empty())
        .filter(|_| data["status"] == 2000000)
        .ok_or("UC未返回有效扫码令牌")?
        .to_owned();
    let mut url = reqwest::Url::parse("https://su.uc.cn/1_n0ZCv").map_err(|_| "UC扫码地址无效")?;
    url.query_pairs_mut().extend_pairs([
        (
            "uc_param_str",
            "dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt",
        ),
        ("token", token.as_str()),
        ("client_id", CAS_CLIENT_ID),
        ("uc_biz_str", "S:custom|C:titlebar_fix"),
    ]);
    let mut session = SESSION.lock().await;
    if GENERATION.load(Ordering::SeqCst) != generation {
        return Err("二维码生成已取消".into());
    }
    *session = Some(Login {
        id: id.clone(),
        generation,
        token,
        cookie,
        expires: Instant::now() + Duration::from_secs(180),
        last_poll: Instant::now() - Duration::from_secs(3),
    });
    Ok(json!({"id":id,"scanUrl":url.as_str(),"state":"waiting"}))
}

/// 取消匹配的会话；网络请求返回或等待授权锁结束后仍会重新检查取消状态。
pub async fn uc_qr_cancel(id: String) {
    let mut session = SESSION.lock().await;
    if session.as_ref().is_some_and(|login| login.id == id) {
        *session = None;
    }
}

/// 轮询确认状态，交换票据并验证独立网盘账号；Cookie 与票据始终保留在库内。
/// 调用方不要持有 LOCK；保存阶段由本函数持锁，取消无需等待该锁。
pub async fn uc_qr_poll(store: &dyn CredentialStore, id: String) -> Result<Value, String> {
    poll(store, id, &Http).await
}
async fn poll(
    store: &dyn CredentialStore,
    id: String,
    transport: &impl Transport,
) -> Result<Value, String> {
    let login = {
        let mut session = SESSION.lock().await;
        let Some(login) = session.as_mut().filter(|login| login.id == id) else {
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
    let (data, cookie) = transport
        .request(
            "https://api.open.uc.cn/cas/ajax/getServiceTicketByQrcodeToken",
            &login.cookie,
            Some(&cas_form(Some(&login.token))),
        )
        .await?;
    if data["status"] == 50004002 || data["status"] == 50004003 {
        uc_qr_cancel(id).await;
        return Ok(json!({"state":"expired"}));
    }
    if data["status"] == 50004001 {
        let mut session = SESSION.lock().await;
        if let Some(login) = session.as_mut().filter(|login| login.id == id) {
            login.cookie = cookie;
        }
        return Ok(json!({"state":"waiting"}));
    }
    let ticket = data["data"]["members"]["service_ticket"]
        .as_str()
        .filter(|value| !value.is_empty())
        .filter(|_| data["status"] == 2000000)
        .ok_or("UC扫码查询未完成，请重试或重新生成二维码")?;
    let mut url =
        reqwest::Url::parse("https://drive.uc.cn/account/info").map_err(|_| "UC账号地址无效")?;
    url.query_pairs_mut().append_pair("st", ticket);
    let (exchanged, cookie) = transport.request(url.as_str(), &cookie, None).await?;
    if exchanged["success"] != true {
        return Err("UC扫码已确认，但凭证交换失败".into());
    }
    let (profile, cookie) = transport
        .request(
            "https://drive.uc.cn/account/info?fr=pc&platform=pc",
            &cookie,
            None,
        )
        .await?;
    let name = profile["data"]["nickname"]
        .as_str()
        .or_else(|| profile["data"]["nick_name"].as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or("UC独立账号验证失败")?;
    if profile["success"] != true {
        return Err("UC独立账号验证失败".into());
    }
    // member 验证网盘身份并可能下发 __puus；首页重定向不应阻断已确认的扫码会话。
    let (member, cookie) = transport
        .request(
            "https://pc-api.uc.cn/1/clouddrive/member?pr=UCBrowser&fr=pc&uc_param_str=",
            &cookie,
            None,
        )
        .await?;
    if member["code"] != 0 || !member["data"].is_object() || !has_download_cookie(&cookie) {
        return Err("UC网盘会话验证失败，请重新扫码".into());
    }
    // 不持会话锁等待授权锁，使关闭对话框可以立刻取消待保存的扫码结果。
    let _guard = LOCK.lock().await;
    let mut session = SESSION.lock().await;
    if !session.as_ref().is_some_and(|login| {
        login.id == id
            && login.generation == GENERATION.load(Ordering::SeqCst)
            && Instant::now() < login.expires
    }) {
        return Ok(json!({"state":"expired"}));
    }
    store.install_login(&id, name, &cookie)?;
    *session = None;
    Ok(json!({"state":"verified"}))
}

#[cfg(test)]
#[path = "../tests/uc/login.rs"]
mod tests;
