pub mod adapter;
pub mod commands;
pub mod domain;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![commands::read_selected_file])
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
