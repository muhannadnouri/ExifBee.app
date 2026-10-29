//! App settings in one versioned JSON file under the OS app-config directory (SPEC §4.2, NFR-007).
//! Loading never fails: a missing file means defaults; an unreadable or unsupported file is moved
//! aside (never deleted) and reported as a warning, so the user's data is kept and the app starts.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SETTINGS_FILE: &str = "settings.json";
pub const SETTINGS_VERSION: u64 = 1;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    /// Absolute ExifTool executable chosen by the user; `None` means auto-detection.
    #[serde(default)]
    pub exiftool_override: Option<PathBuf>,
}

/// File layout: `{ "version": N, ...Settings fields }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OnDisk<'a> {
    version: u64,
    #[serde(flatten)]
    settings: &'a Settings,
}

#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    pub settings: Settings,
    /// Set when the stored file could not be used; shown to the user once at startup.
    pub warning: Option<String>,
}

impl SettingsStore {
    /// Loads `<dir>/settings.json` at startup; never fails, so the app always opens.
    ///
    /// Outcomes:
    /// - missing file → defaults, no warning (first run);
    /// - valid current version → those settings;
    /// - anything else (unreadable, invalid JSON, unknown fields, wrong types, unknown or newer
    ///   version) → defaults plus a warning, and the file is renamed to
    ///   `settings.json.unreadable-<unix-seconds>` so nothing the user had is lost and the next
    ///   save cannot overwrite it.
    ///
    /// `dir` is the OS app-config directory (`~/.config/app.exifbee` on Linux), resolved by
    /// `lib::run`; it does not need to exist yet.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(SETTINGS_FILE);
        let (settings, warning) = match fs::read(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => (Settings::default(), None),
            Err(error) => (
                Settings::default(),
                Some(set_aside(&path, &error.to_string())),
            ),
            Ok(bytes) => match migrate(&bytes) {
                Ok(settings) => (settings, None),
                Err(reason) => (Settings::default(), Some(set_aside(&path, &reason))),
            },
        };
        Self {
            path,
            settings,
            warning,
        }
    }

    /// Writes the settings and makes them current, atomically.
    ///
    /// Flow: create the directory if needed → write `settings.json.tmp` in the *same* directory →
    /// `sync_all` → rename over `settings.json`. A crash at any point leaves either the old file or
    /// the new one, never a half-written file (rename within one filesystem is atomic on Linux).
    /// The in-memory settings change only after the rename succeeds.
    pub fn save(&mut self, settings: Settings) -> io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let data = serde_json::to_vec_pretty(&OnDisk {
            version: SETTINGS_VERSION,
            settings: &settings,
        })
        .map_err(io::Error::other)?;
        let temp = self.path.with_extension("json.tmp");
        let mut file = fs::File::create(&temp)?;
        file.write_all(&data)?;
        file.sync_all()?;
        fs::rename(&temp, &self.path)?;
        self.settings = settings;
        Ok(())
    }
}

/// Turns file bytes into current `Settings`, or explains why it cannot (NFR-007).
///
/// Format: `{ "version": 1, "exiftoolOverride": "/abs/path" | null }`. The `version` key is
/// removed first and the rest is parsed strictly, so unknown fields are rejected rather than
/// half-trusted (`deny_unknown_fields` does not work through `#[serde(flatten)]`).
///
/// Evolving the schema: bump `SETTINGS_VERSION`, keep the old struct, and add one arm that
/// parses version N-1 and upgrades it, so every past file has exactly one deterministic path to
/// the current shape; add a test per old version. A *newer* version is refused (not guessed at),
/// so an older ExifBee never rewrites a newer file it does not understand.
pub fn migrate(bytes: &[u8]) -> Result<Settings, String> {
    let mut value: Value =
        serde_json::from_slice(bytes).map_err(|error| format!("not valid JSON ({error})"))?;
    // Strip the version, then parse the rest strictly (`deny_unknown_fields` does not apply
    // through `#[serde(flatten)]`), so a damaged or foreign file is never half-trusted.
    let version = value
        .as_object_mut()
        .and_then(|object| object.remove("version"))
        .and_then(|version| version.as_u64());
    match version {
        Some(SETTINGS_VERSION) => serde_json::from_value::<Settings>(value)
            .map_err(|error| format!("unexpected contents ({error})")),
        Some(newer) if newer > SETTINGS_VERSION => Err(format!(
            "written by a newer ExifBee (settings version {newer})"
        )),
        _ => Err("missing or unknown settings version".into()),
    }
}

/// Moves an unusable settings file out of the way and returns the user-facing warning.
/// If the rename itself fails, the warning says so: the file will then be replaced on the next
/// save, and the user is told that explicitly rather than losing it silently.
fn set_aside(path: &Path, reason: &str) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let kept = path.with_file_name(format!("{SETTINGS_FILE}.unreadable-{stamp}"));
    match fs::rename(path, &kept) {
        Ok(()) => format!(
            "Settings could not be used: {reason}. Defaults are in use; the old file was kept as {}.",
            kept.display()
        ),
        Err(error) => format!(
            "Settings could not be used: {reason}. Defaults are in use; the old file at {} could not be moved aside ({error}) and will be replaced on the next change.",
            path.display()
        ),
    }
}
