// Increment for each desktop release; tvadmin compares this with versionCode.
const APP_BUILD: u32 = 100;

/// 读取应用版本、构建号、平台、架构和系统版本，供前端匹配更新包；不支持的平台或架构返回错误。
#[tauri::command]
pub fn app_update_info(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let platform = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => return Err("当前系统暂不支持版本更新".into()),
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        _ => return Err("当前架构暂不支持版本更新".into()),
    };
    let mut command = if platform == "macos" {
        let mut cmd = std::process::Command::new("/usr/bin/sw_vers");
        cmd.arg("-productVersion");
        cmd
    } else {
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[System.Environment]::OSVersion.Version.ToString()",
        ]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        cmd
    };
    let output = command
        .output()
        .map_err(|e| format!("读取系统版本失败：{e}"))?;
    let os = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success()
        || os.is_empty()
        || os.split('.').count() > 4
        || !os
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
    {
        return Err("无法识别系统版本".into());
    }
    Ok(serde_json::json!({
        "platform": platform, "arch": arch, "osVersion": os,
        "packageName": app.config().identifier,
        "versionName": app.package_info().version.to_string(), "versionCode": APP_BUILD
    }))
}

/// 读取系统提供的可用并行线程数，供前端决定搜索并发数量。
#[tauri::command]
pub fn search_parallelism() -> Result<usize, String> {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .map_err(|error| format!("无法读取设备并行能力：{error}"))
}
