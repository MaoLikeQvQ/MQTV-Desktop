// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 启动桌面应用，交由库入口初始化 Tauri 运行时。
fn main() {
    tauri_app_lib::run()
}
