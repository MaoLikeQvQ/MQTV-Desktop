//! JS/Python 脚本的自动准备、摘要绑定、状态与原生命令。
mod javascript;
pub(crate) mod media;
mod python;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::path::PathBuf;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
pub struct ScriptBundle {
    pub entry: String,
    pub modules: BTreeMap<String, String>,
    pub ext: Value,
    pub digest: String,
}
#[derive(Serialize, Deserialize)]
struct Installed {
    bundle: ScriptBundle,
    #[serde(default)]
    storage: Map<String, Value>,
}
static LOCKS: OnceLock<Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
static PLAY_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 校验远程插件地址，拒绝非 HTTP(S) 协议和 URL 中的凭证。
fn script_url(input: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(input).map_err(|_| "脚本地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("脚本仅支持不含凭证的 HTTP(S) 地址".into());
    }
    Ok(url)
}
/// 按来源配置隔离本地缓存，修改 api/ext 后首次调用重新下载。
fn identity(source: &Value) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(&json!({"key":source["key"],"resourceUrl":source["resourceUrl"],"api":source["api"],"ext":source["ext"],"type":source["type"]})).unwrap()))
}
/// 只识别明确声明的 type=3 JS/Python 入口，不把 CSP 当作脚本。
fn language(source: &Value) -> Result<&'static str, String> {
    if source["type"].as_u64() != Some(3) {
        return Err("此来源不是脚本插件".into());
    }
    let url = script_url(source["api"].as_str().ok_or("缺少脚本地址")?)?;
    match url.path().to_ascii_lowercase() {
        p if p.ends_with(".js") => Ok("javascript"),
        p if p.ends_with(".py") => Ok("python"),
        _ => Err("尚不支持此脚本入口格式".into()),
    }
}
#[derive(Serialize, Deserialize)]
struct ScriptState {
    digest: String,
    storage: Map<String, Value>,
}

/// 仅从当前本地缓存读取脚本和运行状态，校验摘要；不读取或迁移旧目录。
fn load(_app: &tauri::AppHandle, source: &Value) -> Result<Installed, String> {
    let id = identity(source);
    let bytes = crate::storage::secret_load(&format!("script:{id}"))?.ok_or("脚本尚未缓存")?;
    let state: ScriptState = serde_json::from_slice(&bytes).map_err(|_| "脚本状态损坏")?;
    if state.digest.len() != 64 || !state.digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("脚本摘要无效".into());
    }
    let path = crate::storage::data_root()?
        .join("scripts")
        .join(&id)
        .join(format!("{}.json", state.digest));
    let bytes = std::fs::read(path).map_err(|_| "无法读取本地脚本缓存")?;
    let bundle: ScriptBundle = serde_json::from_slice(&bytes).map_err(|_| "脚本缓存损坏")?;
    if bundle.digest != state.digest || bundle_digest(&bundle) != state.digest {
        return Err("脚本缓存内容与摘要不一致，请重新检查".into());
    }
    Ok(Installed {
        bundle,
        storage: state.storage,
    })
}
/// 将全部可执行内容绑定到稳定摘要，缓存读取时重新核对。
fn bundle_digest(bundle: &ScriptBundle) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(
                &json!({"entry":bundle.entry,"modules":bundle.modules,"ext":bundle.ext})
            )
            .unwrap()
        )
    )
}
/// 源码首次完整落盘，后续复用同一文件；运行状态单独保存，失败不切换缓存版本。
fn save(_app: &tauri::AppHandle, source: &Value, installed: &Installed) -> Result<(), String> {
    if bundle_digest(&installed.bundle) != installed.bundle.digest {
        return Err("脚本缓存摘要无效".into());
    }
    let id = identity(source);
    let path = crate::storage::data_root()?
        .join("scripts")
        .join(&id)
        .join(format!("{}.json", installed.bundle.digest));
    let bytes = serde_json::to_vec(&installed.bundle).map_err(|_| "脚本缓存编码失败")?;
    if std::fs::read(&path).ok().as_ref() != Some(&bytes) {
        crate::storage::write_file(&path, &bytes)?;
    }
    let state = ScriptState {
        digest: installed.bundle.digest.clone(),
        storage: installed.storage.clone(),
    };
    crate::storage::secret_save(
        &format!("script:{id}"),
        &serde_json::to_vec(&state).map_err(|_| "脚本状态编码失败")?,
    )
}
/// 来源级互斥，首次使用只准备一份缓存，禁止同来源并发覆盖运行状态。
fn source_lock(source: &Value) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "脚本状态锁异常")?;
    Ok(locks.entry(identity(source)).or_default().clone())
}
/// 获取 UTF-8 源码，限制响应并拒绝 HTML 错误页面。
async fn download(url: &reqwest::Url) -> Result<String, String> {
    let bytes = crate::commands::http::get_bytes(
        url.to_string(),
        "text/plain, application/javascript, */*",
    )
    .await?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("单个脚本超过 2 MiB".into());
    }
    let code = String::from_utf8(bytes).map_err(|_| "脚本不是 UTF-8 文本")?;
    let start = code
        .trim_start_matches('\u{feff}')
        .trim_start()
        .to_ascii_lowercase();
    if start.is_empty() || start.starts_with('<') {
        return Err("脚本地址返回了空内容或 HTML 页面".into());
    }
    Ok(code)
}
/// 下载入口及静态模块；只允许相对模块和 HTTP 地址，不解释 Node/Android 模块。
async fn inspect(source: &Value) -> Result<ScriptBundle, String> {
    let kind = language(source)?;
    let entry = script_url(source["api"].as_str().unwrap())?;
    let mut queue = vec![entry.clone()];
    let mut modules = BTreeMap::new();
    let mut total = 0;
    while let Some(url) = queue.pop() {
        if modules.contains_key(url.as_str()) {
            continue;
        }
        if modules.len() >= 24 {
            return Err("脚本模块超过 24 个".into());
        }
        let code = download(&url).await?;
        total += code.len();
        if total > 8 * 1024 * 1024 {
            return Err("脚本及依赖超过 8 MiB".into());
        }
        if kind == "javascript" {
            let module_name = url.to_string();
            let module_code = code.clone();
            let imports = tauri::async_runtime::spawn_blocking(move || {
                javascript::static_imports(&module_name, &module_code)
            })
            .await
            .map_err(|_| "脚本检查任务异常")??;
            for specifier in imports {
                if !(specifier.starts_with('.')
                    || specifier.starts_with('/')
                    || specifier.starts_with("http"))
                {
                    return Err(format!("尚不支持的脚本模块：{specifier}"));
                }
                let next = url.join(&specifier).map_err(|_| "脚本模块地址无效")?;
                script_url(next.as_str())?;
                queue.push(next);
            }
        }
        modules.insert(url.to_string(), code);
    }
    let mut ext = source
        .get("ext")
        .cloned()
        .unwrap_or(Value::String(String::new()));
    if kind == "javascript" {
        if let Some(address) = ext
            .as_str()
            .filter(|v| v.starts_with("http://") || v.starts_with("https://"))
        {
            ext = Value::String(download(&script_url(address)?).await?);
        }
    }
    let digest = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!({"entry":entry.as_str(),"modules":modules,"ext":ext}))
                .unwrap()
        )
    );
    Ok(ScriptBundle {
        entry: entry.to_string(),
        modules,
        ext,
        digest,
    })
}
/// 列出来源的运行时可用状态；内容在首次调用时自动检查，不要求手动授权。
#[tauri::command]
pub async fn script_status(app: tauri::AppHandle, sources: Vec<Value>) -> Result<Value, String> {
    let python = python::runtime_path(&app).is_ok();
    let items: Vec<Value> = sources.iter().filter(|s| language(s).is_ok()).map(|s| {
        let available = language(s).ok() != Some("python") || python;
        json!({"key":s["key"],"ready":available,"reason":if !available {"内置 Python 运行时尚未准备"} else {"运行环境已就绪；首次调用自动检查脚本，来源连通性待实际验证"}})
    }).collect();
    Ok(json!({"javascript":true,"python":python,"sources":items}))
}
/// 检查并缓存脚本固定版本；无需手动授权，内容变化时清空旧版本状态，不执行下载的代码。
#[tauri::command]
pub async fn script_inspect(app: tauri::AppHandle, source: Value) -> Result<Value, String> {
    let lock = source_lock(&source)?;
    let _guard = lock.lock().await;
    let bundle = inspect(&source).await?;
    let old = load(&app, &source).ok();
    let unchanged = old
        .as_ref()
        .is_some_and(|v| v.bundle.digest == bundle.digest);
    let result =
        json!({"digest":bundle.digest,"files":bundle.modules.len(),"language":language(&source)?});
    save(
        &app,
        &source,
        &Installed {
            bundle,
            storage: if unchanged {
                old.unwrap().storage
            } else {
                Map::new()
            },
        },
    )?;
    Ok(result)
}
/// 保留命令契约，仅核对已缓存摘要；正常调用无需授权。
#[tauri::command]
pub async fn script_trust(
    app: tauri::AppHandle,
    source: Value,
    digest: String,
) -> Result<(), String> {
    let lock = source_lock(&source)?;
    let _guard = lock.lock().await;
    let installed = load(&app, &source)?;
    if installed.bundle.digest != digest {
        return Err("脚本版本已变化，请重新检查".into());
    }
    Ok(())
}
/// 首次调用下载并缓存源码，后续及重启后复用本地快照，不访问旧数据目录。
async fn prepare(app: &tauri::AppHandle, source: &Value) -> Result<Installed, String> {
    let id = identity(source);
    if crate::storage::secret_load(&format!("script:{id}"))?.is_some() {
        return load(app, source);
    }
    let installed = Installed {
        bundle: inspect(source).await?,
        storage: Map::new(),
    };
    save(app, source, &installed)?;
    Ok(installed)
}

/// 自动准备固定版本并在后台执行，同来源串行；过期调用不写入缓存。
async fn execute(
    app: tauri::AppHandle,
    source: Value,
    action: &'static str,
    args: Value,
) -> Result<Value, String> {
    let signal = crate::request_scope::current();
    let generation = GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    let lock = source_lock(&source)?;
    let _guard = lock.lock().await;
    if signal.as_ref().is_some_and(|signal| signal.is_cancelled())
        || GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation
    {
        return Err("插件调用已取消".into());
    }
    let kind = language(&source)?;
    let runtime = if kind == "python" {
        Some(python::runtime_path(&app)?)
    } else {
        None
    };
    let mut installed = prepare(&app, &source).await?;
    if signal.as_ref().is_some_and(|signal| signal.is_cancelled())
        || GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation
    {
        return Err("插件调用已取消".into());
    }
    let resource = app
        .path()
        .resource_dir()
        .map_err(|_| "无法读取运行时目录")?;
    let worker_signal = signal.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let value = if let Some(runtime) = runtime {
            python::execute_scoped(
                &runtime,
                &resource,
                &installed.bundle,
                action,
                &args,
                &mut installed.storage,
                generation,
                worker_signal,
            )
        } else {
            javascript::execute_scoped(
                &installed.bundle,
                action,
                &args,
                &mut installed.storage,
                worker_signal,
            )
        }?;
        Ok::<_, String>((value, installed))
    })
    .await
    .map_err(|_| "插件任务异常")??;
    if signal.as_ref().is_some_and(|signal| signal.is_cancelled())
        || GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation
    {
        return Err("插件调用已取消".into());
    }
    if serde_json::to_vec(&result.1.storage)
        .map_err(|_| "插件缓存无效")?
        .len()
        > 1024 * 1024
    {
        return Err("插件缓存超过 1 MiB".into());
    }
    save(&app, &source, &result.1)?;
    Ok(result.0)
}
/// 在本地缓存的插件中搜索片名，并校验输出列表。
#[tauri::command]
pub async fn script_search(
    app: tauri::AppHandle,
    source: Value,
    keyword: String,
) -> Result<Value, String> {
    let value = execute(app, source, "search", json!({"keyword":keyword})).await?;
    if !value["list"].is_array() {
        return Err("脚本搜索响应缺少列表".into());
    }
    Ok(value)
}
/// 从插件读取影片详情，保留原始选集标识。
pub async fn script_detail(
    app: tauri::AppHandle,
    source: Value,
    id: String,
) -> Result<Value, String> {
    let value = execute(app, source, "detail", json!({"id":id})).await?;
    if !value["list"].is_array() {
        return Err("脚本详情响应缺少列表".into());
    }
    Ok(value)
}
/// 拒绝非零或未知的解析标记，兼容数字、字符串和布尔形式。
fn needs_web_parser(value: &Value) -> bool {
    ["parse", "jx"].iter().any(|key| match value.get(*key) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_i64() != Some(0),
        Some(Value::String(s)) => !matches!(s.trim(), "" | "0"),
        _ => true,
    }) || value
        .get("playUrl")
        .and_then(Value::as_str)
        .is_some_and(|url| !url.trim().is_empty())
}
/// 调用插件播放解析，拒绝需要网页嗅探的结果并代理必要的媒体请求头。
pub async fn script_play(
    app: tauri::AppHandle,
    source: Value,
    flag: String,
    id: String,
    flags: Vec<String>,
) -> Result<Value, String> {
    let request = PLAY_REQUEST.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    media::invalidate_pending();
    let mut value = execute(
        app.clone(),
        source.clone(),
        "play",
        json!({"flag":flag,"id":id,"flags":flags}),
    )
    .await?;
    if PLAY_REQUEST.load(std::sync::atomic::Ordering::SeqCst) != request {
        return Err("播放请求已过期".into());
    }
    if needs_web_parser(&value) {
        return Err("此播放结果需要网页解析，当前尚未支持".into());
    }
    let mut url = value["url"]
        .as_str()
        .ok_or("插件未返回播放地址")?
        .to_string();
    if url.starts_with("mqtv-python-proxy:") {
        let parsed = reqwest::Url::parse(&url).map_err(|_| "插件代理地址无效")?;
        let params: Map<String, Value> = parsed
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), Value::String(v.into_owned())))
            .collect();
        let proxy = execute(app, source, "proxy", json!({"params":params})).await?;
        if let Some(media) = proxy.get(2).and_then(|v| v.get("mqtvMedia")) {
            value = media.clone();
            url = value["url"].as_str().ok_or("代理缺少媒体地址")?.into();
        } else {
            return Err("此 Python 自定义代理响应尚未支持".into());
        }
    }
    if PLAY_REQUEST.load(std::sync::atomic::Ordering::SeqCst) != request {
        return Err("播放请求已过期".into());
    }
    let parsed = script_url(&url)?;
    let host = parsed.host_str().unwrap_or_default();
    if host == "pan.quark.cn" && parsed.path().starts_with("/s/") && parsed.scheme() == "https" {
        return Ok(json!({"url":url}));
    }
    if [
        "pan.quark.cn",
        "pan.baidu.com",
        "drive.uc.cn",
        "fast.uc.cn",
        "alipan.com",
        "aliyundrive.com",
        "cloud.189.cn",
        "caiyun.139.com",
        "yun.139.com",
        "115.com",
        "115cdn.com",
        "123pan.com",
        "123684.com",
        "123865.com",
        "123912.com",
        "123pan.cn",
        "pan.xunlei.com",
        "weiyun.com",
        "lanzou.com",
        "lanzoui.com",
        "lanzoux.com",
        "lanzoub.com",
        "lanzouj.com",
        "ctfile.com",
        "feijipan.com",
    ]
    .iter()
    .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
    {
        return Err("插件返回不支持的网盘分享页，目前仅支持夸克网盘".into());
    }
    let headers = value
        .get("header")
        .or_else(|| value.get("headers"))
        .cloned()
        .unwrap_or(json!({}));
    Ok(json!({"url":media::start(url,headers).await?}))
}
/// 取消待处理调用并关闭脚本媒体代理，保留本地脚本缓存。
#[tauri::command]
pub async fn script_cancel() {
    shutdown();
}
/// 应用退出时同步标记取消，使脚本 worker 及时终止并关闭媒体通道。
pub(crate) fn shutdown() {
    PLAY_REQUEST.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    media::stop();
}

#[cfg(test)]
#[path = "../../tests/scripts/manager.rs"]
mod tests;
