mod commands;
mod config;
mod features;

use features::quark;

/// 初始化插件、注册前端可调用的原生命令，并启动 Tauri 应用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            features::adapters::adapter_authorize,
            features::adapters::adapter_search,
            features::adapters::adapter_detail,
            features::adapters::adapter_play,
            features::scripts::script_status,
            features::scripts::script_inspect,
            features::scripts::script_trust,
            features::scripts::script_search,
            features::scripts::script_detail,
            features::scripts::script_play,
            features::scripts::script_cancel,
            quark::login::quark_qr_create,
            quark::login::quark_qr_poll,
            quark::login::quark_qr_cancel,
            commands::http::fetch_json,
            commands::http::report_search_quality,
            features::discovery::douban_weekly,
            commands::app::app_update_info,
            commands::app::search_parallelism,
            commands::images::fetch_cover,
            commands::images::fetch_image,
            quark::authorization::quark_settings,
            quark::authorization::quark_authorize,
            quark::authorization::quark_authorize_code,
            quark::authorization::quark_validate,
            quark::search::quark_line_search,
            quark::search::quark_line_detail,
            quark::search::quark_line_info,
            quark::files::quark_files,
            quark::playback::quark_play,
            quark::playback::quark_downloaded_bytes,
            quark::files::quark_episodes
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                features::scripts::shutdown();
                mqtv_netdisk::quark::shutdown();
            }
        });
}
