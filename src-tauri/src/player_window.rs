//! 单一播放窗口；主窗口仅传递影片选择，播放状态留在独立窗口。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Selection {
    vod: Value,
    group: Option<Value>,
    resume: Option<Value>,
    resource: String,
}
#[derive(Clone, Serialize)]
pub(crate) struct Request {
    revision: u64,
    selection: Selection,
}
#[derive(Default)]
struct State {
    revision: u64,
    request: Option<Request>,
    ready: bool,
}
static OPEN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static STATE: Mutex<State> = Mutex::new(State {
    revision: 0,
    request: None,
    ready: false,
});

/// 仅主窗口创建/复用固定标签的播放窗口，初始化未完成时保留最新选择。
#[tauri::command]
pub(crate) async fn player_window_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    selection: Selection,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只能从主窗口选择影片".into());
    }
    if selection.vod["vod_name"].as_str().is_none() || selection.vod["source"].as_object().is_none()
    {
        return Err("影片选择数据无效".into());
    }
    // Windows WebView2 创建不能运行在同步 IPC/UI 线程；串行阻塞任务负责创建和复用。
    let _opening = OPEN_LOCK.lock().await;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = STATE.lock().map_err(|_| "播放窗口状态异常")?;
        state.revision += 1;
        let request = Request {
            revision: state.revision,
            selection,
        };
        state.request = Some(request.clone());
        crate::request_scope::start(request.revision)?;
        crate::features::scripts::media::stop();
        mqtv_netdisk::quark::shutdown();
        let existing = handle.get_webview_window("player");
        if existing.is_none() {
            state.ready = false;
        }
        drop(state);
        let player = if let Some(player) = existing {
            player
        } else {
            WebviewWindowBuilder::new(
                &handle,
                "player",
                WebviewUrl::App("index.html#player".into()),
            )
            .title("晴雨影视 · 播放")
            // 以 16:9 内容区打开，系统标题栏在内容区之外；保留自由缩放。
            .inner_size(1184.0, 666.0)
            .min_inner_size(640.0, 360.0)
            .theme(Some(tauri::Theme::Dark))
            .build()
            .map_err(|_| "无法创建播放窗口")?
        };
        if STATE.lock().map_err(|_| "播放窗口状态异常")?.ready {
            player
                .emit("player-selection", &request)
                .map_err(|_| "无法切换播放影片")?;
        }
        player.show().map_err(|_| "无法显示播放窗口")?;
        player.unminimize().map_err(|_| "无法恢复播放窗口")?;
        player.set_focus().map_err(|_| "无法激活播放窗口")?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "播放窗口创建任务中断")?
}

/// 先注册事件再握手，返回加载期间最新选择；revision 防止迟到快照覆盖新选择。
#[tauri::command]
pub(crate) fn player_window_ready(window: tauri::WebviewWindow) -> Result<Option<Request>, String> {
    if window.label() != "player" {
        return Err("当前窗口不是播放窗口".into());
    }
    let mut state = STATE.lock().map_err(|_| "播放窗口状态异常")?;
    state.ready = true;
    Ok(state.request.clone())
}

/// 销毁播放窗口时清除就绪状态并停止原生播放通道，主窗口继续运行。
pub(crate) fn stop_requests() {
    crate::request_scope::cancel();
    crate::features::scripts::media::stop();
    mqtv_netdisk::quark::shutdown();
}

pub(crate) fn destroyed() {
    stop_requests();
    if let Ok(mut state) = STATE.lock() {
        state.ready = false;
        state.request = None;
    }
    crate::features::scripts::media::stop();
    mqtv_netdisk::quark::shutdown();
}
