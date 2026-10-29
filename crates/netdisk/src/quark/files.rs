use super::{CredentialStore, client::api};
use reqwest::Url;
use serde_json::{Value, json};
use std::collections::HashSet;

// 仅在共享授权锁内访问，按账号、分享和提取码隔离；令牌与文件令牌不返回界面。
struct ShareSession {
    account: String,
    share: String,
    passcode: String,
    token: String,
    created: std::time::Instant,
    files: std::collections::HashMap<String, Value>,
}
static SESSIONS: std::sync::Mutex<Vec<ShareSession>> = std::sync::Mutex::new(Vec::new());

/// 读取短期分享令牌；同账号同分享复用，最长五分钟且最多保留十六个分享。
pub(super) async fn share_token(
    store: &dyn CredentialStore,
    share: &str,
    passcode: &str,
) -> Result<String, String> {
    let account = store.load()?.id;
    {
        let mut sessions = SESSIONS.lock().map_err(|_| "分享缓存不可用")?;
        sessions.retain(|session| {
            session.created.elapsed().as_secs() < 300 && session.account == account
        });
        if let Some(session) = sessions
            .iter()
            .find(|s| s.share == share && s.passcode == passcode)
        {
            return Ok(session.token.clone());
        }
    }
    let id = share_id(share)?;
    let result = api(
        store,
        "share/sharepage/token?pr=ucpro&fr=pc",
        Some(json!({"pwd_id":id,"passcode":passcode})),
    )
    .await?;
    let token = result["data"]["stoken"]
        .as_str()
        .ok_or("分享未返回访问令牌，请检查提取码")?
        .to_string();
    let mut sessions = SESSIONS.lock().map_err(|_| "分享缓存不可用")?;
    if sessions.len() >= 16 {
        sessions.remove(0);
    }
    sessions.push(ShareSession {
        account,
        share: share.into(),
        passcode: passcode.into(),
        token: token.clone(),
        created: std::time::Instant::now(),
        files: Default::default(),
    });
    Ok(token)
}

/// 目录请求失败时丢弃分享缓存，使显式重试重新申请令牌。
pub(super) fn invalidate_share(share: &str) {
    if let Ok(mut sessions) = SESSIONS.lock() {
        sessions.retain(|s| s.share != share);
    }
}

/// 复用刚扫描得到的文件转存令牌，限定账号、分享、提取码、目录、页码和有效期。
pub(super) fn cached_file(
    store: &dyn CredentialStore,
    share: &str,
    passcode: &str,
    parent: &str,
    page: u32,
    fid: &str,
) -> Result<Option<Value>, String> {
    let account = store.load()?.id;
    let sessions = SESSIONS.lock().map_err(|_| "分享缓存不可用")?;
    Ok(sessions
        .iter()
        .find(|s| {
            s.account == account
                && s.share == share
                && s.passcode == passcode
                && s.created.elapsed().as_secs() < 300
        })
        .and_then(|s| s.files.get(&format!("{parent}:{page}:{fid}")))
        .cloned())
}

/// 校验 HTTPS 夸克分享地址，并提取仅包含 ASCII 字母和数字的分享 ID。
pub fn share_id(input: &str) -> Result<String, String> {
    let url = Url::parse(input).map_err(|_| "分享地址无效")?;
    if url.scheme() != "https" || url.host_str() != Some("pan.quark.cn") {
        return Err("仅支持夸克分享地址".into());
    }
    let id = url
        .path()
        .strip_prefix("/s/")
        .unwrap_or_default()
        .split('/')
        .next()
        .unwrap_or_default();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("分享 ID 无效".into());
    }
    Ok(id.into())
}
/// 获取分享访问令牌并读取指定目录的一页文件，将夸克字段转换为前端所需的文件信息。
async fn share_files(
    store: &dyn CredentialStore,
    share: &str,
    parent: &str,
    passcode: &str,
    page: u32,
) -> Result<Value, String> {
    let id = share_id(share)?;
    let stoken = share_token(store, share, passcode).await?;
    let mut query = Url::parse("https://placeholder/").unwrap();
    query.query_pairs_mut().extend_pairs([
        ("pr", "ucpro"),
        ("fr", "pc"),
        ("pwd_id", &id),
        ("stoken", stoken.as_str()),
        ("pdir_fid", parent),
        ("_page", page.to_string().as_str()),
        ("_size", "100"),
        ("_fetch_total", "1"),
        ("_sort", "file_type:asc,file_name:asc"),
    ]);
    let result = api(
        store,
        &format!("share/sharepage/detail?{}", query.query().unwrap()),
        None,
    )
    .await
    .map_err(|error| {
        invalidate_share(share);
        error
    })?;
    let list = result["data"]["list"]
        .as_array()
        .ok_or("分享文件列表格式无效")?;
    let account = store.load()?.id;
    {
        let mut sessions = SESSIONS.lock().map_err(|_| "分享缓存不可用")?;
        if let Some(session) = sessions
            .iter_mut()
            .find(|s| s.account == account && s.share == share && s.passcode == passcode)
        {
            for file in list {
                if session.files.len() >= 2000 {
                    break;
                }
                if let Some(fid) = file["fid"].as_str() {
                    session
                        .files
                        .insert(format!("{parent}:{page}:{fid}"), file.clone());
                }
            }
        }
    }
    Ok(
        json!({"share":share,"parent":parent,"files":list.iter().map(|f|json!({"id":f["fid"],"name":f["file_name"],"folder":f["dir"],"size":f["size"],"video":f["category"]=="video"||f["obj_category"]=="video"})).collect::<Vec<_>>(),"total":result["metadata"]["_total"],"pageSize":100}),
    )
}
/// 使用宿主已准备的账号读取一页分享目录；授权失效交由宿主处理。
pub async fn quark_files(
    store: &dyn CredentialStore,
    share: String,
    parent: Option<String>,
    passcode: Option<String>,
    page: Option<u32>,
) -> Result<Value, String> {
    share_files(
        store,
        &share,
        &parent.unwrap_or_else(|| "0".into()),
        &passcode.unwrap_or_default(),
        page.unwrap_or(1).max(1),
    )
    .await
}

/// 广度优先遍历分享目录并分页收集视频选集，保留目录和页码以供播放时定位。
/// 限制目录数量及单目录页数；明确授权失效返回宿主，由宿主决定刷新。
pub async fn quark_episodes(
    store: &dyn CredentialStore,
    share: String,
    passcode: Option<String>,
) -> Result<Value, String> {
    let mut queue = std::collections::VecDeque::from([("0".to_string(), String::new())]);
    let mut seen = HashSet::new();
    let mut episodes = Vec::new();
    while let Some((parent, path)) = queue.pop_front() {
        if !seen.insert(parent.clone()) {
            continue;
        }
        if seen.len() > 1000 {
            return Err("分享目录数量超过解析上限，请选择范围更小的资源".into());
        }
        let mut page = 1;
        loop {
            let listing = share_files(
                store,
                &share,
                &parent,
                passcode.as_deref().unwrap_or_default(),
                page,
            )
            .await?;
            let files = listing["files"].as_array().ok_or("文件列表格式无效")?;
            for file in files {
                let id = file["id"].as_str().ok_or("文件 ID 缺失")?;
                let name = file["name"].as_str().unwrap_or("未命名");
                if file["folder"] == true {
                    queue.push_back((id.to_string(), format!("{path}{name} / ")));
                } else if file["video"] == true
                    || ["mp4", "mkv", "mov", "avi", "ts", "flv", "webm", "m4v"]
                        .iter()
                        .any(|ext| name.to_lowercase().ends_with(&format!(".{ext}")))
                {
                    episodes.push(
                        json!({"id":id,"name":name,"path":format!("{path}{name}"),"size":file["size"],"parent":parent,"page":page}),
                    );
                }
            }
            if files.len() < 100
                || listing["total"]
                    .as_u64()
                    .is_some_and(|n| u64::from(page) * 100 >= n)
            {
                break;
            }
            page += 1;
            if page > 1000 {
                return Err("分享文件数量超过解析上限".into());
            }
        }
    }
    if episodes.is_empty() {
        return Err("该夸克资源没有可播放选集".into());
    }
    Ok(json!({"episodes":episodes}))
}

#[cfg(test)]
#[path = "../tests/files.rs"]
mod tests;
