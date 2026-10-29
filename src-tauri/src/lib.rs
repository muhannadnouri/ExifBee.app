pub mod adapter;
pub mod commands;
pub mod domain;
pub mod service;

use service::settings::SettingsStore;
use std::sync::Mutex;
use tauri::Manager;

/// Builds and runs the app. Startup flow: register the dialog plugin (used from Rust only; no
/// capability grants it to the renderer) → load settings from the OS config dir into managed
/// state (never fails; see `SettingsStore::load`) → expose the narrow command set (SEC-008).
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage::<commands::SettingsState>(Mutex::new(SettingsStore::load(&dir)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::exiftool_status,
            commands::choose_exiftool_override,
            commands::reset_exiftool_override,
            commands::read_selected_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ExifBee");
}

#[cfg(test)]
mod tests {
    // @req OPS-001
    #[test]
    fn tauri_config_compiles_into_desktop_context() {
        let context: tauri::Context = tauri::generate_context!();
        let config = context.config();
        assert_eq!(config.identifier, "app.exifbee");
        let window = &config.app.windows[0];
        assert_eq!(window.title, "ExifBee");
        // 1280×800 at 200% scaling leaves a 640×400 logical screen; the window must fit it.
        assert!(window.min_width.unwrap() <= 640.0 && window.min_height.unwrap() <= 400.0);
    }
}
