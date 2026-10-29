//! Helpers shared by the integration test crates.
#![allow(dead_code)]

pub mod harness;

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
    /// Restores owner permissions first, so a test that made files or folders read-only (or left
    /// a failure mid-way) still leaves nothing behind.
    fn drop(&mut self) {
        fn unlock(path: &Path) {
            use std::os::unix::fs::PermissionsExt;
            let Ok(meta) = fs::symlink_metadata(path) else {
                return;
            };
            if meta.file_type().is_symlink() {
                return;
            }
            let _ = fs::set_permissions(
                path,
                fs::Permissions::from_mode(meta.permissions().mode() | 0o700),
            );
            if meta.is_dir() {
                for entry in fs::read_dir(path).into_iter().flatten().flatten() {
                    unlock(&entry.path());
                }
            }
        }
        unlock(&self.0);
        let _ = fs::remove_dir_all(&self.0);
    }
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
