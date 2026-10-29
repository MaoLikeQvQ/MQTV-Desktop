use super::*;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};

struct Config {
    base: Url,
    key: Vec<u8>,
    iv: Vec<u8>,
}
impl Config {
    fn read(source: &Source) -> Result<Self, String> {
        let ext = config(source)?;
        let base = http_url(
            ext["url"]
                .as_str()
                .or_else(|| ext["site"].as_str())
                .ok_or("AppGet 缺少站点地址")?,
        )?;
        let key = ext["dataKey"]
            .as_str()
            .unwrap_or_default()
            .as_bytes()
            .to_vec();
        let iv = ext["dataIv"]
            .as_str()
            .unwrap_or_default()
            .as_bytes()
            .to_vec();
        if ![16, 24, 32].contains(&key.len()) || iv.len() != 16 {
            return Err("AppGet dataKey/dataIv 长度无效".into());
        }
        Ok(Self { base, key, iv })
    }
    fn encrypt(&self, plain: &[u8]) -> Result<String, String> {
        macro_rules! encrypt {
            ($cipher:ty) => {
                cbc::Encryptor::<$cipher>::new_from_slices(&self.key, &self.iv)
                    .map_err(|_| "AppGet 密钥无效")?
                    .encrypt_padded_vec_mut::<Pkcs7>(plain)
            };
        }
        Ok(STANDARD.encode(match self.key.len() {
            16 => encrypt!(aes::Aes128),
            24 => encrypt!(aes::Aes192),
            _ => encrypt!(aes::Aes256),
        }))
    }
    fn decrypt(&self, encoded: &str) -> Result<Value, String> {
        let data = STANDARD
            .decode(
                encoded
                    .chars()
                    .filter(|c| !c.is_ascii_whitespace())
                    .collect::<String>(),
            )
            .map_err(|_| "AppGet 密文编码无效")?;
        macro_rules! decrypt {
            ($cipher:ty) => {
                cbc::Decryptor::<$cipher>::new_from_slices(&self.key, &self.iv)
                    .map_err(|_| "AppGet 密钥无效")?
                    .decrypt_padded_vec_mut::<Pkcs7>(&data)
                    .map_err(|_| "AppGet 解密失败，请核对协议配置")?
            };
        }
        let plain = match self.key.len() {
            16 => decrypt!(aes::Aes128),
            24 => decrypt!(aes::Aes192),
            _ => decrypt!(aes::Aes256),
        };
        serde_json::from_slice(&plain).map_err(|_| "AppGet 解密内容不是有效 JSON".into())
    }
}
fn headers(auth: &Authorization, time: &str, sign: Option<String>) -> Value {
    let mut headers = json!({"User-Agent":if auth.user_agent.is_empty() { "okhttp/3.14.9" } else { &auth.user_agent },
        "app-user-device-id":auth.device_id,"app-version-code":auth.version,"app-api-verify-time":time,"app-ui-mode":"light","Content-Type":"application/x-www-form-urlencoded"});
    if !auth.token.is_empty() {
        headers["app-user-token"] = json!(auth.token);
    }
    if let Some(sign) = sign {
        headers["app-api-verify-sign"] = json!(sign);
    }
    headers
}
async fn request(source: &Source, path: &str, payload: Value, form: bool) -> Result<Value, String> {
    let cfg = Config::read(source)?;
    let auth = authorization(source)?;
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间无效")?
        .as_secs()
        .to_string();
    let url = cfg
        .base
        .join(&format!("/api.php{path}"))
        .map_err(|_| "AppGet 接口地址无效")?;
    let mut req = client()?.post(url);
    let sign = if form {
        Some(cfg.encrypt(time.as_bytes())?)
    } else {
        None
    };
    for (k, v) in headers(&auth, &time, sign)
        .as_object()
        .ok_or("请求头无效")?
    {
        req = req.header(k, v.as_str().unwrap_or_default());
    }
    req = if form {
        let fields = payload
            .as_object()
            .ok_or("AppGet 播放参数格式无效")?
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
            .collect::<HashMap<_, _>>();
        req.form(&fields)
    } else {
        req.body(payload.to_string())
    };
    let response = req.send().await.map_err(|_| "AppGet 请求失败")?;
    let envelope: Value =
        serde_json::from_str(&body(response).await?.0).map_err(|_| "AppGet 响应不是 JSON")?;
    cfg.decrypt(
        envelope["data"]
            .as_str()
            .ok_or("AppGet 未返回加密 data，可能需要外部授权或协议已变更")?,
    )
}
/// 使用配置指定的 AppGet 协议搜索，不接受订阅中的账号令牌作为授权来源。
pub(super) async fn search(source: &Source, keyword: &str) -> Result<Value, String> {
    let data = request(
        source,
        "/getappapi.index/searchList",
        json!({"keywords":keyword,"type_id":"0","page":"1"}),
        false,
    )
    .await?;
    let list = data["search_list"]
        .as_array()
        .ok_or("AppGet 搜索列表格式无效")?;
    Ok(json!({"list":list}))
}
fn episode_id(vod: &str, group: usize, episode: usize, name: &str) -> String {
    URL_SAFE_NO_PAD.encode(json!([vod, group, episode, name]).to_string())
}
fn parse_detail(data: &Value, id: &str) -> Result<Value, String> {
    let mut vod = data
        .get("vod")
        .or_else(|| data["list"].get(0))
        .filter(|v| v.is_object())
        .ok_or("AppGet 详情格式无效")?
        .clone();
    let groups = data["vod_play_list"]
        .as_array()
        .ok_or("AppGet 选集分组缺失")?;
    let mut names = Vec::new();
    let mut lines = Vec::new();
    for (g, group) in groups.iter().enumerate() {
        let items = group["urls"].as_array().ok_or("AppGet 选集列表无效")?;
        if items.is_empty() {
            continue;
        }
        names.push(
            group["player_info"]["show"]
                .as_str()
                .unwrap_or("播放")
                .replace(['#', '$'], " "),
        );
        lines.push(
            items
                .iter()
                .enumerate()
                .map(|(e, item)| {
                    format!(
                        "{}${}",
                        item["name"]
                            .as_str()
                            .unwrap_or("播放")
                            .replace(['#', '$'], " "),
                        episode_id(id, g, e, item["name"].as_str().unwrap_or_default())
                    )
                })
                .collect::<Vec<_>>()
                .join("#"),
        );
    }
    vod["vod_id"] = json!(id);
    vod["vod_play_from"] = json!(names.join("$$$"));
    vod["vod_play_url"] = json!(lines.join("$$$"));
    Ok(json!({"list":[vod]}))
}
/// 仅把影片与选集位置放入历史；播放时重读详情取得短期令牌。
pub(super) async fn detail(source: &Source, id: &str) -> Result<Value, String> {
    parse_detail(
        &request(
            source,
            "/getappapi.index/vodDetail",
            json!({"vod_id":id}),
            false,
        )
        .await?,
        id,
    )
}
fn media_result(value: Value) -> Result<(String, Value), String> {
    let value = if let Some(s) = value.as_str() {
        serde_json::from_str(s).map_err(|_| "AppGet 播放 JSON 无效")?
    } else {
        value
    };
    if value
        .get("parse")
        .is_some_and(|v| !v.is_null() && v != &json!(0) && v != &json!("0") && v != &json!(false))
    {
        return Err("AppGet 返回网页解析任务，当前适配器不执行网页嗅探".into());
    }
    let url = value["url"]
        .as_str()
        .ok_or("AppGet 未返回视频地址")?
        .to_string();
    let parsed = http_url(&url)?;
    if matches!(
        parsed.host_str(),
        Some("pan.quark.cn" | "drive.uc.cn" | "pan.baidu.com")
    ) {
        return Err("AppGet 返回网盘分享页，需要网盘适配".into());
    }
    let mut headers = value
        .get("headers")
        .or_else(|| value.get("header"))
        .cloned()
        .unwrap_or(json!({}));
    if let Some(s) = headers.as_str() {
        headers = serde_json::from_str(s).map_err(|_| "AppGet 媒体请求头无效")?;
    }
    Ok((url, headers))
}
/// 播放时重新获取详情和解析令牌；解析配置交给站点 vodParse 接口处理。
pub(super) async fn play(source: &Source, id: &str) -> Result<(String, Value), String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(id)
        .map_err(|_| "AppGet 选集 ID 无效")?;
    let (vod, g, e, name): (String, usize, usize, String) =
        serde_json::from_slice(&bytes).map_err(|_| "AppGet 选集位置无效")?;
    let data = request(
        source,
        "/getappapi.index/vodDetail",
        json!({"vod_id":vod}),
        false,
    )
    .await?;
    let group = data["vod_play_list"]
        .get(g)
        .ok_or("播放线路已变化，请刷新详情")?;
    let item = group["urls"].get(e).ok_or("选集已变化，请刷新详情")?;
    if item["name"].as_str().unwrap_or_default() != name {
        return Err("选集顺序已变化，请刷新详情重新选择".into());
    }
    let url = item["url"].as_str().ok_or("AppGet 选集地址缺失")?;
    let parser = item["parse_api_url"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| group["player_info"]["parse"].as_str())
        .unwrap_or_default();
    // 已知直连媒体无需发起站点解析；其他地址必须走协议解析，不能把网页假装成视频。
    if parser.is_empty() {
        let path = http_url(url)?.path().to_lowercase();
        if [".m3u8", ".mp4", ".mkv", ".webm"]
            .iter()
            .any(|ext| path.ends_with(ext))
        {
            return media_result(json!({"url":url}));
        }
        return Err("AppGet 缺少播放解析配置".into());
    }
    let cfg = Config::read(source)?;
    let result = request(source, "/getappapi.index/vodParse", json!({"parse_api":parser,"url":cfg.encrypt(url.as_bytes())?,"token":item["token"].as_str().unwrap_or_default()}), true).await?;
    media_result(result.get("json").cloned().unwrap_or(result))
}

#[cfg(test)]
#[path = "../../tests/adapters/appget.rs"]
mod tests;
