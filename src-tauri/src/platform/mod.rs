//! OS-specific knowledge, kept apart from process invocation in `adapter/` (SPEC §4.2, S2-T01).
//!
//! Each OS module exposes the same items, which this module consumes, so the compiler enforces
//! the interface: `EXIFTOOL_FILE_NAME` (the executable's file name) and
//! `KNOWN_EXIFTOOL_LOCATIONS` (package-managed places to probe before `PATH`). Linux is
//! implemented for the MVP; macOS (S7) and Windows (S8, bundled official package) are stubs that
//! only search `PATH` until their stages.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as current;

#[cfg(not(target_os = "linux"))]
mod unsupported;
#[cfg(not(target_os = "linux"))]
use unsupported as current;

pub use current::{EXIFTOOL_FILE_NAME, KNOWN_EXIFTOOL_LOCATIONS};

/// Ordered places to look for ExifTool when the user has not chosen one.
///
/// Flow: the OS's known package locations first, then `<dir>/<EXIFTOOL_FILE_NAME>` for every
/// absolute entry of `path_var` (the `PATH` value), dropping exact duplicates. Nothing is checked
/// for existence or validity here; that is the adapter's job (`resolver::resolve_from`).
///
/// Why known locations first: apps launched from a desktop menu often get a shorter `PATH` than a
/// terminal, and some distributions install ExifTool outside the default `PATH` (Arch:
/// `/usr/bin/vendor_perl`). Relative `PATH` entries such as `.` or `bin` are dropped because they
/// depend on the working directory, which would let a file in the current folder impersonate
/// ExifTool (SEC-002).
///
/// Example (Linux): `exiftool_candidates(Some("/opt/tools:.:/usr/bin".as_ref()))` →
/// `[/usr/bin/exiftool, …known…, /opt/tools/exiftool]` (`/usr/bin/exiftool` already listed).
pub fn exiftool_candidates(path_var: Option<&OsStr>) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = KNOWN_EXIFTOOL_LOCATIONS.iter().map(PathBuf::from).collect();
    let path_dirs = path_var
        .map(|value| std::env::split_paths(value).collect::<Vec<_>>())
        .unwrap_or_default();
    for dir in path_dirs.into_iter().filter(|dir| dir.is_absolute()) {
        let candidate = dir.join(EXIFTOOL_FILE_NAME);
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

/// Whether this user may change `path` in place: write access to the file and to its folder.
///
/// Why both: ExifTool writes a new file next to the original and renames it over, so it changes
/// a read-only (0444) file in a writable folder without complaint (probed on 13.55), and fails
/// in a read-only folder. ExifBee refuses both before staging (S4-T02, SEC-005).
pub fn can_write(path: &Path) -> bool {
    let folder = path.parent().unwrap_or(path);
    allows_write(path) && allows_write(folder)
}

#[cfg(unix)]
fn allows_write(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a valid NUL-terminated string that outlives the call.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
fn allows_write(path: &Path) -> bool {
    // shortcut: ignores Windows ACLs, only the read-only attribute; revisit with Windows (S8).
    std::fs::metadata(path).is_ok_and(|meta| !meta.permissions().readonly())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    // @req FR-001, SEC-002
    #[test]
    fn known_locations_come_first_then_absolute_path_entries_without_duplicates() {
        let known: Vec<PathBuf> = KNOWN_EXIFTOOL_LOCATIONS.iter().map(PathBuf::from).collect();
        let path =
            std::env::join_paths(["/opt/tools", ".", "bin", "/opt/tools", "/usr/bin"]).unwrap();
        let candidates = exiftool_candidates(Some(&path));

        assert_eq!(candidates[..known.len()], known[..]);
        let extra = &candidates[known.len()..];
        assert_eq!(
            extra[0],
            PathBuf::from("/opt/tools").join(EXIFTOOL_FILE_NAME)
        );
        // Relative entries are dropped; repeats (including a known location) appear once.
        assert!(candidates.iter().all(|candidate| candidate.is_absolute()));
        let mut unique = candidates.clone();
        unique.dedup();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), candidates.len());
        assert_eq!(exiftool_candidates(None), known);
        assert_eq!(exiftool_candidates(Some(&OsString::new())), known);
    }

    // @req FR-001
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_probes_the_package_manager_locations() {
        for location in [
            "/usr/bin/exiftool",
            "/usr/bin/vendor_perl/exiftool",
            "/usr/local/bin/exiftool",
        ] {
            assert!(KNOWN_EXIFTOOL_LOCATIONS.contains(&location), "{location}");
        }
    }
}
