mod commands;
mod config;
mod features;
mod player_window;
mod request_scope;
mod storage;

use features::quark;
use tauri::{Emitter, Manager};

/// 初始化插件、注册前端可调用的原生命令，并启动 Tauri 应用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            storage::init(app.handle()).map_err(std::io::Error::other)?;
            quark::credentials::init(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            player_window::player_window_open,
            player_window::player_window_ready,
            storage::storage_exit_ready,
            storage::storage_exit_cancel,
            storage::storage_history_update,
            storage::storage_snapshot,
            storage::storage_enable_exit_guard,
            storage::storage_exit,
            storage::storage_import,
            storage::storage_set,
            storage::storage_apply,
            storage::image_cache_read,
            storage::image_cache_write,
            features::adapters::adapter_authorize,
            features::adapters::adapter_search,
            commands::player_requests::adapter_detail,
            commands::player_requests::adapter_play,
            features::scripts::script_status,
            features::scripts::script_inspect,
            features::scripts::script_trust,
            features::scripts::script_search,
            commands::player_requests::script_detail,
            commands::player_requests::script_play,
            features::scripts::script_cancel,
            quark::login::quark_qr_create,
            quark::login::quark_qr_poll,
            quark::login::quark_qr_cancel,
            commands::player_requests::fetch_json,
            commands::player_requests::media_play,
            commands::player_requests::media_downloaded_bytes,
            commands::http::report_search_quality,
            features::discovery::douban_weekly,
            commands::app::app_update_info,
            commands::app::search_parallelism,
            commands::player_requests::fetch_cover,
            commands::player_requests::fetch_image,
            quark::authorization::quark_settings,
            quark::authorization::quark_authorize,
            quark::authorization::quark_authorize_code,
            quark::authorization::quark_validate,
            quark::search::quark_line_search,
            commands::player_requests::quark_line_detail,
            commands::player_requests::quark_line_info,
            commands::player_requests::quark_files,
            commands::player_requests::quark_play,
            quark::playback::quark_downloaded_bytes,
            commands::player_requests::quark_episodes
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested {
                api, code: None, ..
            } if storage::exit_guard_enabled() && !app.webview_windows().is_empty() => {
                api.prevent_exit();
                storage::begin_exit(app);
                if app.emit("storage-exit-requested", ()).is_err() {
                    eprintln!("无法通知窗口保存本地数据，请通过关闭窗口重试退出");
                }
            }
            tauri::RunEvent::WindowEvent {
                ref label,
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } if label == "player" => {
                player_window::stop_requests();
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                if label == "player" {
                    player_window::destroyed();
                }
                storage::window_destroyed(app, &label);
            }
            tauri::RunEvent::Exit => {
                features::scripts::shutdown();
                mqtv_netdisk::quark::shutdown();
            }
            _ => {}
        });
}
