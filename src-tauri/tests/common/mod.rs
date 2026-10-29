//! Helpers shared by the integration test crates.
#![allow(dead_code)]

use exifbee_lib::adapter::exiftool::resolver::{probe, resolve, ExifTool, DEFAULT_TIMEOUT};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Fresh empty directory under the system temp dir, removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "exifbee-{name}-{}-{:?}",
            std::process::id(),
            Instant::now()
        ));
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The ExifTool under test: `EXIFTOOL` (absolute path) if set, else the app's own discovery.
pub fn system_exiftool() -> ExifTool {
    match std::env::var_os("EXIFTOOL") {
        Some(path) => probe(Path::new(&path), DEFAULT_TIMEOUT),
        None => resolve(None),
    }
    .expect("a supported system ExifTool must be installed for this test")
}

/// Absolute path of a generated fixture in `tests/fixtures`.
pub fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures")
        .join(name)
        .canonicalize()
        .unwrap()
}
