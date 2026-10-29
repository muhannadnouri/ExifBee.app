//! Helpers shared by the integration test crates.
#![allow(dead_code)]

use exifbee_lib::adapter::exiftool::resolver::{probe, resolve, ExifTool, DEFAULT_TIMEOUT};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
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

/// Executable stand-in for a non-ExifTool or broken binary.
/// A child process writes the executable: if a write fd were open here while another test thread
/// forks, that child would inherit it and exec of the script would fail with ETXTBSY.
pub fn fake_executable(dir: &Path, name: &str, script: &str) -> PathBuf {
    let source = dir.join(format!("{name}.src"));
    let path = dir.join(name);
    fs::write(&source, format!("#!/bin/sh\n{script}\n")).unwrap();
    let status = Command::new("install")
        .args(["-m", "755"])
        .arg(&source)
        .arg(&path)
        .status()
        .unwrap();
    assert!(status.success());
    path
}
