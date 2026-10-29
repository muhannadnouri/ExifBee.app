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
        assert_eq!(config.app.windows[0].title, "ExifBee");
    }
}
