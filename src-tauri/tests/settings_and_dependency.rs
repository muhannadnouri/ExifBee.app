//! Settings persistence/migration/recovery and the ExifTool status shown to the user (S1-T04).

mod common;

use common::{system_exiftool, TempDir};
use exifbee_lib::domain::error::ErrorKind;
use exifbee_lib::service::dependency::check;
use exifbee_lib::service::settings::{migrate, Settings, SettingsStore, SETTINGS_FILE};
use std::fs;
use std::path::PathBuf;

fn kept_files(dir: &TempDir) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(&dir.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

// @req NFR-007
#[test]
fn missing_settings_start_with_defaults_and_no_warning() {
    let dir = TempDir::new("settings-missing");
    let store = SettingsStore::load(&dir.0.join("not-created-yet"));
    assert_eq!(store.settings, Settings::default());
    assert_eq!(store.warning, None);
}

// @req NFR-007, FR-002
#[test]
fn override_persists_across_loads_and_can_be_reset() {
    let dir = TempDir::new("settings-roundtrip");
    let mut store = SettingsStore::load(&dir.0);
    let chosen = PathBuf::from("/usr/bin/exiftool");
    store
        .save(Settings {
            exiftool_override: Some(chosen.clone()),
        })
        .unwrap();

    let reloaded = SettingsStore::load(&dir.0);
    assert_eq!(reloaded.settings.exiftool_override, Some(chosen));
    assert_eq!(reloaded.warning, None);
    let on_disk: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.0.join(SETTINGS_FILE)).unwrap()).unwrap();
    assert_eq!(on_disk["version"], 1);
    // The atomic write leaves no temp file behind.
    assert_eq!(kept_files(&dir), vec![SETTINGS_FILE.to_string()]);

    let mut reloaded = reloaded;
    reloaded.save(Settings::default()).unwrap();
    assert_eq!(SettingsStore::load(&dir.0).settings.exiftool_override, None);
}

// @req NFR-007
#[test]
fn corrupt_or_unsupported_settings_recover_with_a_warning_and_keep_the_old_file() {
    for (case, contents) in [
        ("truncated JSON", r#"{"version": 1, "exiftoolOver"#),
        ("not an object", "[1, 2, 3]"),
        ("no version", r#"{"exiftoolOverride": "/usr/bin/exiftool"}"#),
        ("wrong type", r#"{"version": 1, "exiftoolOverride": 42}"#),
        ("unknown field", r#"{"version": 1, "surprise": true}"#),
        (
            "newer version",
            r#"{"version": 99, "exiftoolOverride": null}"#,
        ),
    ] {
        let dir = TempDir::new("settings-corrupt");
        fs::write(dir.0.join(SETTINGS_FILE), contents).unwrap();

        let store = SettingsStore::load(&dir.0);
        assert_eq!(store.settings, Settings::default(), "{case}");
        let warning = store.warning.expect(case);
        assert!(warning.contains("Defaults are in use"), "{case}: {warning}");

        // The unreadable file is moved aside with its contents intact, never deleted.
        let files = kept_files(&dir);
        assert_eq!(files.len(), 1, "{case}: {files:?}");
        assert!(files[0].starts_with("settings.json.unreadable-"), "{case}");
        assert_eq!(
            fs::read_to_string(dir.0.join(&files[0])).unwrap(),
            contents,
            "{case}"
        );
        assert!(warning.contains(&files[0]), "{case}: {warning}");
    }
}

// @req NFR-007
#[test]
fn migration_is_deterministic_for_the_current_version() {
    let v1 = br#"{"version": 1, "exiftoolOverride": "/opt/exiftool/exiftool"}"#;
    assert_eq!(migrate(v1), migrate(v1));
    assert_eq!(
        migrate(v1).unwrap().exiftool_override,
        Some(PathBuf::from("/opt/exiftool/exiftool"))
    );
    assert_eq!(migrate(br#"{"version": 1}"#).unwrap(), Settings::default());
}

// @req FR-001
#[test]
fn status_reports_the_auto_detected_executable() {
    let tool = system_exiftool();
    let (status, resolved) = check(Some(&tool.path));
    assert!(status.is_override);
    assert_eq!(status.path.as_deref(), tool.path.to_str());
    assert_eq!(status.version, Some(tool.version));
    assert_eq!(status.error, None);
    assert!(resolved.is_some());
    assert_eq!(status.minimum_version, "12.76");
}

// @req FR-001, FR-002, UX-005
#[test]
fn a_broken_override_is_reported_not_replaced() {
    let dir = TempDir::new("override-missing");
    let missing = dir.0.join("exiftool");
    let (status, resolved) = check(Some(&missing));
    assert!(resolved.is_none());
    assert!(status.is_override);
    assert_eq!(status.path.as_deref(), missing.to_str());
    let error = status.error.expect("missing override must be explained");
    assert_eq!(error.kind, ErrorKind::DependencyMissing);
    assert!(error
        .message
        .contains("Install it using your Linux package manager"));

    let (relative, _) = check(Some(std::path::Path::new("exiftool")));
    assert_eq!(relative.error.unwrap().kind, ErrorKind::InvalidInput);
}

// @req FR-001, FR-002, UX-005
#[test]
fn a_stale_override_is_reported_missing_not_replaced() {
    let dir = TempDir::new("override-stale");
    let tool = system_exiftool();
    // A working override, e.g. chosen in Settings, whose file is later removed (uninstall, moved
    // install, deleted copy).
    let chosen = dir.0.join("exiftool");
    std::os::unix::fs::symlink(&tool.path, &chosen).unwrap();
    let (before, _) = check(Some(&chosen));
    assert_eq!(before.error, None);
    assert_eq!(
        before.resolved_path.as_deref(),
        tool.identity.canonical_path.to_str()
    );

    fs::remove_file(&chosen).unwrap();
    let (after, resolved) = check(Some(&chosen));
    assert!(resolved.is_none(), "must not fall back to auto-detection");
    assert!(after.is_override);
    assert_eq!(after.path.as_deref(), chosen.to_str());
    assert_eq!(after.error.unwrap().kind, ErrorKind::DependencyMissing);
}
