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
    let folders = api(
        store,
        "file/sort?pr=ucpro&fr=pc&pdir_fid=0&_page=1&_size=100&_sort=file_type:asc,file_name:asc",
        None,
    )
    .await?;
    let folder = folders["data"]["list"]
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|f| f["file_name"] == "MQTV" && f["dir"] == true)
        })
        .and_then(|f| f["fid"].as_str())
        .map(String::from);
    let folder = match folder {
        Some(id) => id,
        None => {
            let created = api(
                store,
                "file?pr=ucpro&fr=pc",
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
pub async fn quark_play(
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
                ("pr", "ucpro"),
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
        let result = api(store, "share/sharepage/save?pr=ucpro&fr=pc",Some(json!({"fid_list":[fid],"fid_token_list":[fid_token],"to_pdir_fid":folder,"pwd_id":id,"stoken":stoken,"pdir_fid":parent,"scene":"link"}))).await.map_err(|error| {
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
                ("pr", "ucpro"),
                ("fr", "pc"),
                ("task_id", task),
                ("retry_index", &retry.to_string()),
            ]);
            let status = api(store, &format!("task?{}", query.query().unwrap()), None).await?;
            if let Some(fid) = status["data"]["save_as"]["save_as_top_fids"][0]
                .as_str()
                .or_else(|| status["data"]["save_as_top_fids"][0].as_str())
            {
                saved = Some(fid.to_string());
                break;
            }
            if status["data"]["status"] == 2 {
                return Err("夸克保存任务失败".into());
            }
        }
        let saved = saved.ok_or("文件保存尚未完成，请稍后重新选择播放")?;
        settings = store.load()?;
        settings.saved.insert(key, saved.clone());
        store.save(&settings)?;
        saved
    };
    let playback = api(
        store,
        "file/v2/play?pr=ucpro&fr=pc",
        Some(
            json!({"fid":saved_fid,"resolutions":"normal,low,high,super,2k,4k","supports":"fmp4"}),
        ),
    )
    .await?;
    let target = playback["data"]["video_list"]
        .as_array()
        .and_then(|list| list.iter().find_map(|v| v["video_info"]["url"].as_str()))
        .ok_or("账号未返回视频地址，可能受账号权益或文件格式限制")?;
    let latest = store.load()?;
    let url = media_proxy(target.into(), latest.cookie).await?;
    Ok(json!({"url":url}))
}
