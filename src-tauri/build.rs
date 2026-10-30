/// Declares the app's IPC commands to Tauri's permission system (SPEC S1-T06, SEC-008).
///
/// With an app manifest, every command below needs an explicit `allow-<command>` permission,
/// which only `capabilities/main.json` grants, and only to the `main` window. A command missing
/// here fails the build when it is registered; a command missing from the capability is rejected
/// at runtime. Keep this list, `generate_handler!` in `src/lib.rs` and `Commands` in
/// `src/lib/ipc.ts` identical (checked by `src/lib/ipc.test.ts`).
const COMMANDS: &[&str] = &[
    "app_info",
    "exiftool_status",
    "choose_exiftool_override",
    "reset_exiftool_override",
    "add_files",
    "read_file",
    "add_folder",
    "cancel_scan",
    "set_scan_options",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
