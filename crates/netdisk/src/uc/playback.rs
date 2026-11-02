use super::{
    CredentialStore,
    client::api,
    files::{cached_file, invalidate_share, share_id, share_token},
    proxy::media_proxy,
};
use reqwest::Url;
use serde_json::{Value, json};

// 短期复用本应用播放目录；删除目录导致转存失败时清除，显式重试重新查找。
static FOLDERS: std::sync::Mutex<Vec<(String, String, std::time::Instant)>> =
    std::sync::Mutex::new(Vec::new());

/// 复用同账号五分钟内确认的 MQTV 目录；首次查找仍以网盘实际目录为准。
async fn playback_folder(store: &dyn CredentialStore, account: &str) -> Result<String, String> {
    {
        let mut folders = FOLDERS.lock().map_err(|_| "播放目录缓存不可用")?;
        folders.retain(|(id, _, time)| id == account && time.elapsed().as_secs() < 300);
        if let Some((_, folder, _)) = folders.first() {
            return Ok(folder.clone());
        }
    }
    let mut folder = None;
    for page in 1..=1000 {
        let folders = api(store, &format!("file/sort?pr=UCBrowser&fr=pc&pdir_fid=0&_page={page}&_size=100&_sort=file_type:asc,file_name:asc"), None).await?;
        let list = folders["data"]["list"]
            .as_array()
            .ok_or("UC账号目录格式无效")?;
        folder = list
            .iter()
            .find(|file| file["file_name"] == "MQTV" && file["dir"] == true)
            .and_then(|file| file["fid"].as_str())
            .map(String::from);
        if folder.is_some() || list.len() < 100 {
            break;
        }
        if page == 1000 {
            return Err("UC账号目录超过查询上限，请整理根目录后重试".into());
        }
    }
    let folder = match folder {
        Some(id) => id,
        None => {
            let created = api(
                store,
                "file?pr=UCBrowser&fr=pc",
                Some(
                    json!({"pdir_fid":"0","file_name":"MQTV","dir_path":"","dir_init_lock":false}),
                ),
            )
            .await?;
            created["data"]["fid"]
                .as_str()
                .ok_or("创建 MQTV 播放目录失败")?
                .to_string()
        }
    };
    FOLDERS.lock().map_err(|_| "播放目录缓存不可用")?.push((
        account.into(),
        folder.clone(),
        std::time::Instant::now(),
    ));
    Ok(folder)
}

/// 调用方持有共享授权锁；复用转存记录，或将分享文件保存到 MQTV 目录并等待转存完成。
/// 随后请求视频地址并启动本地媒体代理，仅向前端返回代理地址。
pub async fn uc_play(
    store: &dyn CredentialStore,
    share: String,
    parent: String,
    passcode: Option<String>,
    fid: String,
    page: Option<u32>,
) -> Result<Value, String> {
    let mut settings = store.load()?;
    let id = share_id(&share)?;
    let key = format!("{}:{id}:{fid}", settings.id);
    let saved_fid = if let Some(saved) = settings.saved.get(&key) {
        saved.clone()
    } else {
        let passcode = passcode.unwrap_or_default();
        let stoken = share_token(store, &share, &passcode).await?;
        let page = page.unwrap_or(1).max(1);
        let cached = cached_file(store, &share, &passcode, &parent, page, &fid)?;
        let file = if let Some(file) = cached {
            file
        } else {
            let mut query = Url::parse("https://placeholder/").unwrap();
            query.query_pairs_mut().extend_pairs([
                ("pr", "UCBrowser"),
                ("fr", "pc"),
                ("pwd_id", &id),
                ("stoken", stoken.as_str()),
                ("pdir_fid", &parent),
                ("_page", &page.to_string()),
                ("_size", "100"),
                ("_sort", "file_type:asc,file_name:asc"),
            ]);
            let detail = api(
                store,
                &format!("share/sharepage/detail?{}", query.query().unwrap()),
                None,
            )
            .await?;
            detail["data"]["list"]
                .as_array()
                .and_then(|list| list.iter().find(|f| f["fid"] == fid))
                .cloned()
                .ok_or("文件已变化，请刷新目录")?
        };
        if file["dir"] == true {
            return Err("请选择视频文件".into());
        }
        let fid_token = file["share_fid_token"].as_str().ok_or("分享文件令牌缺失")?;
        let folder = playback_folder(store, &settings.id).await?;
        let result = api(store, "share/sharepage/save?pr=UCBrowser&fr=pc",Some(json!({"fid_list":[fid],"fid_token_list":[fid_token],"to_pdir_fid":folder,"pwd_id":id,"stoken":stoken,"pdir_fid":parent,"scene":"link"}))).await.map_err(|error| {
            invalidate_share(&share);
            if let Ok(mut folders) = FOLDERS.lock() { folders.clear(); }
            error
        })?;
        let task = result["data"]["task_id"]
            .as_str()
            .ok_or("保存任务未返回 ID")?;
        let mut saved = None;
        for retry in 0..20 {
            // 首次立即查询，未完成时再按间隔轮询，不重复提交转存。
            if retry > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            let mut query = Url::parse("https://placeholder/").unwrap();
            query.query_pairs_mut().extend_pairs([
                ("pr", "UCBrowser"),
                ("fr", "pc"),
                ("task_id", task),
                ("retry_index", &retry.to_string()),
            ]);
            let status = api(store, &format!("task?{}", query.query().unwrap()), None).await?;
            if let Some(fid) = saved_task_fid(&status)? {
                saved = Some(fid.to_string());
                break;
            }
        }
        let saved = saved.ok_or("文件保存尚未完成，请稍后重新选择播放")?;
        settings = store.load()?;
        settings.saved.insert(key, saved.clone());
        store.save(&settings)?;
        saved
    };
    // UC 下载鉴权依赖 __puus；受管 Cookie 缺少会话时先由 member 接口补齐。
    if !has_download_cookie(&store.load()?.cookie) {
        api(store, "member?pr=UCBrowser&fr=pc&uc_param_str=", None).await?;
        if !has_download_cookie(&store.load()?.cookie) {
            return Err("UC下载会话不完整，请重新授权".into());
        }
    }
    // UC 使用下载接口和客户端 UA 获取原画地址；下载 Cookie 由接口响应更新。
    let playback = api(
        store,
        "file/download?pr=UCBrowser&fr=pc&uc_param_str=&entry=ft",
        Some(json!({"fids":[saved_fid]})),
    )
    .await?;
    let target = download_target(&playback)?;
    let latest = store.load()?;
    let url = media_proxy(target.into(), latest.cookie).await?;
    Ok(json!({"url":url}))
}

/// UC任务状态2为完成、3为失败；保存结果可能位于save_as子对象或data根部。
fn saved_task_fid(status: &Value) -> Result<Option<&str>, String> {
    if !status["data"].is_object() {
        return Err("UC保存任务响应无效".into());
    }
    if status["data"]["status"] == 3 {
        return Err("UC保存任务失败".into());
    }
    Ok(status["data"]["save_as"]["save_as_top_fids"][0]
        .as_str()
        .or_else(|| status["data"]["save_as_top_fids"][0].as_str())
        .filter(|fid| !fid.is_empty()))
}
fn download_target(playback: &Value) -> Result<&str, String> {
    playback["data"]
        .as_array()
        .and_then(|list| list.first())
        .and_then(|file| file["download_url"].as_str())
        .filter(|url| !url.is_empty())
        .ok_or_else(|| "UC账号未返回下载地址，可能受账号权益或文件格式限制".into())
}
fn has_download_cookie(cookie: &str) -> bool {
    cookie
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .any(|(key, value)| key == "__puus" && !value.is_empty())
}

#[cfg(test)]
#[path = "../tests/uc/playback.rs"]
mod tests;
