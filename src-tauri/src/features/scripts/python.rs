//! 随包 CPython worker：限定输出、超时、环境与资源路径，不回退系统解释器。
use super::{GENERATION, ScriptBundle};
use serde_json::{Map, Value, json};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tauri::Manager;

/// 只查找应用自带解释器；开发时使用当前 checkout 的准备产物。
pub(super) fn runtime_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    } else {
        app.path()
            .resource_dir()
            .map_err(|_| "无法读取运行时目录")?
    };
    let path = root.join(if cfg!(windows) {
        "runtime/python/python.exe"
    } else {
        "runtime/python/bin/python3"
    });
    if !path.is_file() {
        return Err("应用内置 Python 未准备，请运行运行时准备命令后重新打包".into());
    }
    Ok(path)
}
/// 有限读取 worker 输出；超过限制立即报错并由主线程终止进程。
fn bounded<R: Read>(mut input: R, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取 Python 输出失败")?;
    if bytes.len() > limit {
        Err("Python 插件输出超限".into())
    } else {
        Ok(bytes)
    }
}
/// 在独立进程执行一次请求，轮询取消与截止时间，失败不保留插件缓存。
pub(super) fn execute(
    runtime: &Path,
    resource: &Path,
    bundle: &ScriptBundle,
    action: &str,
    args: &Value,
    storage: &mut Map<String, Value>,
    generation: u64,
) -> Result<Value, String> {
    let worker = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime/python/worker.py")
    } else {
        resource.join("runtime/worker/worker.py")
    };
    if !worker.is_file() {
        return Err("Python 宿主文件缺失".into());
    }
    let work = std::env::temp_dir().join(format!(
        "mqtv-worker-{}-{}",
        std::process::id(),
        bundle.digest.get(..16).unwrap_or("plugin")
    ));
    std::fs::create_dir_all(&work).map_err(|_| "无法创建插件工作目录")?;
    let mut command = Command::new(runtime);
    command
        .args(["-I", "-B"])
        .arg(worker)
        .current_dir(&work)
        .env_clear();
    // Windows 启动解释器可能需要系统目录；不继承令牌、代理或应用配置。
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "无法启动内置 Python")?;
    let request =
        serde_json::to_vec(&json!({"bundle":bundle,"action":action,"args":args,"storage":storage}))
            .map_err(|_| "插件请求编码失败")?;
    if request.len() > 16 * 1024 * 1024 {
        let _ = child.kill();
        let _ = child.wait();
        return Err("插件请求超过 16 MiB".into());
    }
    let mut stdin = child.stdin.take().ok_or("Python 输入通道缺失")?;
    let stdout = child.stdout.take().ok_or("Python 输出通道缺失")?;
    let stderr = child.stderr.take().ok_or("Python 日志通道缺失")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let writes = sender.clone();
    std::thread::spawn(move || {
        let result = stdin
            .write_all(&request)
            .map(|_| None)
            .map_err(|_| "Python 请求发送失败".to_string());
        let _ = writes.send((0, result));
    });
    let output = sender.clone();
    std::thread::spawn(move || {
        let result = bounded(stdout, 8 * 1024 * 1024).map(Some);
        let _ = output.send((1, result));
    });
    std::thread::spawn(move || {
        let result = bounded(stderr, 64 * 1024).map(|_| None);
        let _ = sender.send((2, result));
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut bytes = None;
    let mut completed = 0;
    let mut status = None;
    loop {
        if Instant::now() > deadline
            || GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Python 插件调用超时或已取消".into());
        }
        match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok((kind, Ok(value))) => {
                completed += 1;
                if kind == 1 {
                    bytes = value;
                }
            }
            Ok((_, Err(error))) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) if completed < 3 => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Python 输出线程异常".into());
            }
            Err(_) => std::thread::sleep(Duration::from_millis(25)),
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Python 进程状态异常".into());
                }
            }
        }
        if status.is_some() && completed == 3 {
            break;
        }
    }
    let status = status.ok_or("Python 未正常退出")?;
    let bytes = bytes.ok_or("Python 未返回输出")?;
    if !status.success() {
        return Err("Python 插件进程异常退出".into());
    }
    let response: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Python 插件响应不是有效 JSON")?;
    if let Some(error) = response["error"].as_str() {
        return Err(error.to_string());
    }
    *storage = response["storage"]
        .as_object()
        .ok_or("Python 缓存响应无效")?
        .clone();
    response
        .get("result")
        .cloned()
        .ok_or_else(|| "Python 未返回执行结果".into())
}

#[cfg(test)]
#[path = "../../tests/scripts/python.rs"]
mod tests;
