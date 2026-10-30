//! 播放窗口生命周期内的请求取消信号；不取消主窗口请求或最终历史保存。
use std::{future::Future, sync::Mutex};

#[derive(Clone)]
pub(crate) struct Signal(tokio::sync::watch::Sender<bool>);
impl Signal {
    pub(crate) fn new() -> Self {
        Self(tokio::sync::watch::channel(false).0)
    }
    pub(crate) fn cancel(&self) {
        self.0.send_replace(true);
    }
    pub(crate) fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }
    async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        loop {
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}
static PLAYER: Mutex<Option<(u64, Signal)>> = Mutex::new(None);
tokio::task_local! { static CURRENT: Signal; }

/// 创建新的播放任务代际；旧代际请求即刻取消，新窗口不会复活旧请求。
pub(crate) fn start(revision: u64) -> Result<(), String> {
    let mut player = PLAYER.lock().map_err(|_| "播放请求状态异常")?;
    if let Some((_, signal)) = player.as_ref() {
        signal.cancel();
    }
    *player = Some((revision, Signal::new()));
    Ok(())
}

pub(crate) fn cancel() {
    if let Ok(player) = PLAYER.lock() {
        if let Some((_, signal)) = player.as_ref() {
            signal.cancel();
        }
    }
}

/// 脚本进入阻塞线程前显式捕获当前调用信号，避免依赖全局取消代际。
pub(crate) fn current() -> Option<Signal> {
    CURRENT.try_with(Clone::clone).ok()
}

/// 取消优先于结果返回；drop 业务 future 会释放 HTTP 请求、轮询及异步锁。
pub(crate) async fn cancellable<T>(
    signal: Option<Signal>,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if let Some(signal) = signal {
        tokio::select! { biased;
            _ = signal.cancelled() => Err("播放请求已取消".into()),
            result = future => {
                if signal.is_cancelled() { Err("播放请求已取消".into()) } else { result }
            }
        }
    } else {
        future.await
    }
}

/// 原生命令按调用窗口绑定请求范围，main 不绑定 player 信号。
pub(crate) async fn run<T>(
    window: &tauri::WebviewWindow,
    revision: Option<u64>,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if window.label() != "player" {
        return future.await;
    }
    let (active_revision, signal) = PLAYER
        .lock()
        .map_err(|_| "播放请求状态异常")?
        .clone()
        .ok_or("播放窗口请求尚未初始化")?;
    if revision != Some(active_revision) {
        return Err("影片请求已过期".into());
    }
    CURRENT
        .scope(signal.clone(), cancellable(Some(signal), future))
        .await
}

#[cfg(test)]
#[path = "tests/request_scope.rs"]
mod tests;
