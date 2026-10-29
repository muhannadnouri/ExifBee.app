//! Real-process tests for ExifTool discovery and `-ver` validation (S0-T03).
//! Set `EXIFTOOL` to an absolute path to test a specific installation; otherwise auto-detection must succeed.

use exifbee_lib::adapter::exiftool::resolver::{
    probe, resolve, resolve_from, ResolveError, DEFAULT_TIMEOUT,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Fresh empty directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
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

/// Executable stand-in for a non-ExifTool or broken binary.
fn fake_executable(dir: &Path, name: &str, script: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

// @req FR-001, SEC-002
#[test]
fn installed_exiftool_is_resolved_with_absolute_path_and_version() {
    let tool = match std::env::var_os("EXIFTOOL") {
        Some(path) => probe(Path::new(&path), DEFAULT_TIMEOUT),
        None => resolve(None),
    }
    .expect("a supported system ExifTool must be installed for this test");

    assert!(tool.path.is_absolute(), "{:?}", tool.path);
    let (major, minor) = tool.version.split_once('.').expect("version like 13.55");
    assert!(
        major.parse::<u32>().is_ok() && minor.len() == 2,
        "{}",
        tool.version
    );
}

// @req FR-001
#[test]
fn missing_executable_is_reported_not_found() {
    let empty = TempDir::new("missing");
    let absent = empty.0.join("exiftool");

    assert!(matches!(
        resolve(Some(&absent)),
        Err(ResolveError::NotFound { .. })
    ));
    assert!(matches!(
        resolve_from(None, vec![absent.clone()]),
        Err(ResolveError::NotFound { .. })
    ));
}

// @req FR-001
#[test]
fn relative_override_is_rejected() {
    assert!(matches!(
        resolve(Some(Path::new("exiftool"))),
        Err(ResolveError::NotAbsolute { .. })
    ));
}

// @req FR-001
#[test]
fn invalid_binaries_are_rejected_with_their_output() {
    let dir = TempDir::new("invalid");

    let other = fake_executable(&dir.0, "not-exiftool", "echo 'GNU hello 2.12'");
    match probe(&other, DEFAULT_TIMEOUT) {
        Err(ResolveError::UnexpectedOutput { stdout, .. }) => assert_eq!(stdout, "GNU hello 2.12"),
        result => panic!("expected UnexpectedOutput, got {result:?}"),
    }

    // Real ExifTool output when its script and Image::ExifTool library versions differ.
    let mismatched = fake_executable(
        &dir.0,
        "mismatched",
        "echo '13.55 [Warning: Library version is 13.50]'",
    );
    assert!(matches!(
        probe(&mismatched, DEFAULT_TIMEOUT),
        Err(ResolveError::UnexpectedOutput { .. })
    ));

    let failing = fake_executable(&dir.0, "failing", "echo 'boom' >&2; exit 3");
    match probe(&failing, DEFAULT_TIMEOUT) {
        Err(ResolveError::Failed { code, stderr, .. }) => {
            assert_eq!(code, Some(3));
            assert_eq!(stderr, "boom");
        }
        result => panic!("expected Failed, got {result:?}"),
    }

    let not_executable = dir.0.join("plain-file");
    fs::write(&not_executable, "13.55\n").unwrap();
    assert!(matches!(
        probe(&not_executable, DEFAULT_TIMEOUT),
        Err(ResolveError::Launch { .. })
    ));
}

// @req FR-001
#[test]
fn version_below_minimum_is_rejected() {
    let dir = TempDir::new("old");
    let old = fake_executable(&dir.0, "exiftool", "echo 9.99");
    match probe(&old, DEFAULT_TIMEOUT) {
        Err(ResolveError::Unsupported { version, .. }) => assert_eq!(version, "9.99"),
        result => panic!("expected Unsupported, got {result:?}"),
    }
}

// @req FR-001
#[test]
fn hung_executable_times_out() {
    let dir = TempDir::new("hung");
    let hung = fake_executable(&dir.0, "exiftool", "sleep 30");
    let started = Instant::now();
    assert!(matches!(
        probe(&hung, Duration::from_millis(300)),
        Err(ResolveError::Timeout { .. })
    ));
    assert!(started.elapsed() < Duration::from_secs(5));
}

// @req SEC-002
#[test]
fn shell_metacharacters_in_path_are_not_interpreted() {
    let dir = TempDir::new("shell");
    let hostile = dir.0.join("a; touch pwned $(touch pwned2)");
    fs::create_dir(&hostile).unwrap();
    let tool = fake_executable(&hostile, "exiftool", "echo 13.55");

    let found = resolve_from(None, vec![tool.clone()]).expect("literal path must run");
    assert_eq!(found.path, tool);
    assert_eq!(found.version, "13.55");
    assert!(!dir.0.join("pwned").exists() && !Path::new("pwned").exists());
    assert!(!Path::new("pwned2").exists());
}

// @req FR-001
#[test]
fn search_skips_invalid_candidates_and_override_wins() {
    let dir = TempDir::new("order");
    let bad = fake_executable(&dir.0, "bad", "echo nope");
    let good = fake_executable(&dir.0, "good", "echo 13.55");
    let other = fake_executable(&dir.0, "other", "echo 13.60");

    let found = resolve_from(None, vec![dir.0.join("absent"), bad, good.clone()]).unwrap();
    assert_eq!(found.path, good);

    let found = resolve_from(Some(&other), vec![good]).unwrap();
    assert_eq!(found.version, "13.60");
}
