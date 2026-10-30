//! 为跨模块播放请求绑定调用窗口的取消作用域；原业务函数保留给主流程和隔离测试。
use crate::{
    features::{adapters, quark, scripts},
    request_scope,
};
use serde_json::Value;
use tauri::{AppHandle, WebviewWindow};

/// 读取普通网页、插件或网盘当前媒体会话的累计下载字节，无法匹配时返回未知。
#[tauri::command]
pub(crate) fn media_downloaded_bytes(url: String) -> Option<u64> {
    scripts::media::downloaded_bytes(&url)
        .or_else(|| mqtv_netdisk::quark::downloaded_bytes(&url))
}

/// 普通媒体复用已登记目标的回环代理，避免 WebView 的跨域请求被上游拒绝；不注入网盘凭证。
#[tauri::command]
pub(crate) async fn media_play(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    url: String,
) -> Result<String, String> {
    request_scope::run(
        &window,
        playback_revision,
        async {
            super::media::play(url).await
        },
    ).await
}

/// 下载普通 JSON；播放窗口销毁时取消详情请求，主窗口搜索不受影响。
#[tauri::command]
pub(crate) async fn fetch_json(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    url: String,
) -> Result<Value, String> {
    request_scope::run(&window, playback_revision, super::http::fetch_json(url)).await
}

/// 下载封面并将请求归属调用窗口，取消时丢弃完整下载 future。
#[tauri::command]
pub(crate) async fn fetch_cover(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    url: String,
    direct: Option<bool>,
) -> Result<Vec<u8>, String> {
    request_scope::run(
        &window,
        playback_revision,
        super::images::fetch_cover(url, direct),
    )
    .await
}

/// 下载图片并将请求归属调用窗口，不影响其他窗口的图片加载。
#[tauri::command]
pub(crate) async fn fetch_image(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    url: String,
) -> Result<Vec<u8>, String> {
    request_scope::run(&window, playback_revision, super::images::fetch_image(url)).await
}

/// 在窗口作用域内读取原生来源详情，保留来源协议和参数契约。
#[tauri::command]
pub(crate) async fn adapter_detail(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    source: adapters::Source,
    id: String,
) -> Result<Value, String> {
    request_scope::run(
        &window,
        playback_revision,
        adapters::adapter_detail(source, id),
    )
    .await
}

/// 在窗口作用域内解析原生来源播放并准备媒体代理。
#[tauri::command]
pub(crate) async fn adapter_play(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    source: adapters::Source,
    id: String,
) -> Result<Value, String> {
    request_scope::run(
        &window,
        playback_revision,
        adapters::adapter_play(source, id),
    )
    .await
}

/// 将脚本详情的下载、准备及执行绑定到调用窗口，内部阻塞执行使用同一取消上下文。
#[tauri::command]
pub(crate) async fn script_detail(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    app: AppHandle,
    source: Value,
    id: String,
) -> Result<Value, String> {
    request_scope::run(
        &window,
        playback_revision,
        scripts::script_detail(app, source, id),
    )
    .await
}

/// 将脚本解析与媒体代理准备绑定到调用窗口，取消不影响主窗口脚本搜索。
#[tauri::command]
pub(crate) async fn script_play(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    app: AppHandle,
    source: Value,
    flag: String,
    id: String,
    flags: Vec<String>,
) -> Result<Value, String> {
    request_scope::run(
        &window,
        playback_revision,
        scripts::script_play(app, source, flag, id, flags),
    )
    .await
}

/// 在窗口作用域内提取详情中的网盘分享。
#[tauri::command]
pub(crate) async fn quark_line_detail(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    url: String,
) -> Result<Vec<String>, String> {
    request_scope::run(
        &window,
        playback_revision,
        quark::search::quark_line_detail(url),
    )
    .await
}

/// 在窗口作用域内提取详情简介和网盘分享。
#[tauri::command]
pub(crate) async fn quark_line_info(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    url: String,
) -> Result<Value, String> {
    request_scope::run(
        &window,
        playback_revision,
        quark::search::quark_line_info(url),
    )
    .await
}

/// 将授权锁等待、分享目录请求和认证刷新统一归属调用窗口。
#[tauri::command]
pub(crate) async fn quark_files(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    share: String,
    parent: Option<String>,
    passcode: Option<String>,
    page: Option<u32>,
) -> Result<Value, String> {
    request_scope::run(
        &window,
        playback_revision,
        quark::files::quark_files(share, parent, passcode, page),
    )
    .await
}

/// 在窗口作用域内遍历可播放选集，关闭窗口即取消当前遍历 future。
#[tauri::command]
pub(crate) async fn quark_episodes(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    share: String,
    passcode: Option<String>,
) -> Result<Value, String> {
    request_scope::run(
        &window,
        playback_revision,
        quark::files::quark_episodes(share, passcode),
    )
    .await
}

/// 将转存准备、轮询、媒体探测及代理创建绑定到播放窗口。
#[tauri::command]
pub(crate) async fn quark_play(
    window: WebviewWindow,
    playback_revision: Option<u64>,
    share: String,
    parent: String,
    passcode: Option<String>,
    fid: String,
    page: Option<u32>,
) -> Result<Value, String> {
    request_scope::run(
        &window,
        playback_revision,
        quark::playback::quark_play(share, parent, passcode, fid, page),
    )
    .await
}
