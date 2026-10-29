//! Validates and selects a system ExifTool executable (SPEC §3.2). *Where* to look is OS
//! knowledge in `crate::platform`; this module only runs and judges candidates. The executable is
//! always spawned directly with an argument vector, never through a shell (SEC-002).

use super::argv::Args;
use super::process::{self, CancelToken, RunError};
use crate::platform;
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Oldest ExifTool version CI tests against: the Ubuntu 24.04 LTS package (SPEC §3.2, DEC-014).
pub const MINIMUM_VERSION: (u32, u32) = (12, 76);
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// A validated ExifTool: the path it was found or chosen at, its `-ver`, and which file that
/// path really is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExifTool {
    /// As found or chosen (may be a symlink, e.g. `/usr/bin/exiftool`); what reads execute.
    pub path: PathBuf,
    pub version: String,
    pub identity: ExecutableIdentity,
}

/// Which file an executable path really is (S2-T01). Two paths are the same executable when their
/// identities are equal, e.g. a distribution symlink and its target. Later stages key the
/// capability snapshot on version + identity (SPEC §3.2 item 7), so an in-place upgrade or a
/// different install is never mistaken for the one already inspected.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ExecutableIdentity {
    /// Absolute path with every symlink resolved.
    pub canonical_path: PathBuf,
    /// `(device, inode)` on Unix, so hard links also count as the same file.
    pub file_id: Option<(u64, u64)>,
}

impl ExecutableIdentity {
    /// Reads the identity of an existing file; `None` if it cannot be resolved (missing, a broken
    /// symlink, or no permission to read its directory).
    pub fn of(path: &Path) -> Option<Self> {
        let canonical_path = fs::canonicalize(path).ok()?;
        #[cfg(unix)]
        let file_id = {
            use std::os::unix::fs::MetadataExt;
            fs::metadata(&canonical_path)
                .ok()
                .map(|meta| (meta.dev(), meta.ino()))
        };
        #[cfg(not(unix))]
        let file_id = None;
        Some(Self {
            canonical_path,
            file_id,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    NotAbsolute {
        path: PathBuf,
    },
    NotFound {
        searched: Vec<PathBuf>,
    },
    Launch {
        path: PathBuf,
        message: String,
    },
    Timeout {
        path: PathBuf,
        after: Duration,
    },
    Failed {
        path: PathBuf,
        code: Option<i32>,
        stderr: String,
    },
    UnexpectedOutput {
        path: PathBuf,
        stdout: String,
    },
    Unsupported {
        path: PathBuf,
        version: String,
    },
}

impl fmt::Display for ResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAbsolute { path } => {
                write!(f, "ExifTool path must be absolute: {}", path.display())
            }
            Self::NotFound { .. } => write!(
                f,
                "ExifTool was not found. Install it using your Linux package manager, then choose Retry or select the executable path."
            ),
            Self::Launch { path, message } => {
                write!(f, "Could not start {}: {message}", path.display())
            }
            Self::Timeout { path, after } => write!(
                f,
                "{} did not answer `-ver` within {} s",
                path.display(),
                after.as_secs_f32()
            ),
            Self::Failed { path, code, stderr } => write!(
                f,
                "{} `-ver` failed (exit {}): {stderr}",
                path.display(),
                code.map_or("signal".into(), |c| c.to_string())
            ),
            Self::UnexpectedOutput { path, stdout } => write!(
                f,
                "{} is not a working ExifTool; `-ver` printed: {stdout}",
                path.display()
            ),
            Self::Unsupported { path, version } => write!(
                f,
                "ExifTool {version} at {} is older than the minimum tested version {}.{:02}",
                path.display(),
                MINIMUM_VERSION.0,
                MINIMUM_VERSION.1
            ),
        }
    }
}

impl std::error::Error for ResolveError {}

/// Finds the ExifTool to use: the user's override if set, else auto-detection (SPEC §3.2).
///
/// Thin wrapper over [`resolve_from`] with the real candidate list from `platform::exiftool_candidates`
/// (known package locations first, then absolute `PATH` entries). Called by
/// `service::dependency::check`, which every command goes through, so reads and the Settings
/// status card always agree on which executable is in use.
///
/// Gotcha: this spawns `-ver` for each existing candidate until one validates, so it blocks for
/// tens of milliseconds; call it off the async runtime (see `commands::blocking`).
pub fn resolve(user_override: Option<&Path>) -> Result<ExifTool, ResolveError> {
    resolve_from(
        user_override,
        platform::exiftool_candidates(std::env::var_os("PATH").as_deref()),
    )
}

/// Resolution with an injectable candidate list (tests pass fake executables).
///
/// Flow:
/// 1. Override given → it is the *only* option: relative → `NotAbsolute`, missing → `NotFound`,
///    otherwise [`probe`]. A broken override is reported, never silently replaced by an
///    auto-detected ExifTool, because the user chose it deliberately (SPEC §3.2).
/// 2. No override → try candidates in order; skip ones that do not exist or are the same file
///    (same [`ExecutableIdentity`]) as one already tried; first that passes [`probe`] wins.
/// 3. Nothing passed → the last probe error if any candidate existed (e.g. "too old"), which is
///    more useful than `NotFound`; otherwise `NotFound` with the searched paths.
///
/// Example: `resolve_from(None, vec!["/usr/bin/exiftool".into()])` returns that ExifTool if it
/// prints a supported version, else why not.
pub fn resolve_from(
    user_override: Option<&Path>,
    candidates: Vec<PathBuf>,
) -> Result<ExifTool, ResolveError> {
    if let Some(path) = user_override {
        if !path.is_absolute() {
            return Err(ResolveError::NotAbsolute { path: path.into() });
        }
        if !path.is_file() {
            return Err(ResolveError::NotFound {
                searched: vec![path.into()],
            });
        }
        return probe(path, DEFAULT_TIMEOUT);
    }

    let mut last_error = None;
    // The same executable is often reachable twice (a symlink and its target, or a PATH entry
    // that repeats a known location); probe each real file once.
    let mut seen = HashSet::new();
    for path in candidates.iter().filter(|path| path.is_file()) {
        if let Some(identity) = ExecutableIdentity::of(path) {
            if !seen.insert(identity) {
                continue;
            }
        }
        match probe(path, DEFAULT_TIMEOUT) {
            Ok(tool) => return Ok(tool),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or(ResolveError::NotFound {
        searched: candidates,
    }))
}

/// Validates one executable by running `<path> -ver` (argv, no shell) through the shared runner.
///
/// Accepts only a bare `major.minor` version at or above [`MINIMUM_VERSION`]; the version
/// string is returned as printed (e.g. `"13.55"`).
///
/// Gotchas:
/// - The executable name proves nothing; only its `-ver` output does (SPEC §3.2 item 3).
/// - A script/library mismatch prints `13.55 [Warning: Library version is 13.50]` with exit 0;
///   that is rejected as `UnexpectedOutput` because the installation is broken.
/// - A non-executable file fails as `Launch`, a hang as `Timeout` (the child is killed).
pub fn probe(path: &Path, timeout: Duration) -> Result<ExifTool, ResolveError> {
    let output = process::run(
        path,
        Args::new().options(&["-ver"]).as_slice(),
        timeout,
        MAX_OUTPUT_BYTES,
        &CancelToken::default(),
    )
    .map_err(|error| match error {
        RunError::Launch(message) => ResolveError::Launch {
            path: path.into(),
            message,
        },
        RunError::Timeout(after) => ResolveError::Timeout {
            path: path.into(),
            after,
        },
        // A `-ver` probe is never cancelled (its token is never triggered).
        RunError::Cancelled => ResolveError::Launch {
            path: path.into(),
            message: error.to_string(),
        },
        RunError::OutputTooLarge(_) => ResolveError::UnexpectedOutput {
            path: path.into(),
            stdout: error.to_string(),
        },
    })?;
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).trim().to_string();
    let stdout = text(&output.stdout);

    if !output.status.success() {
        return Err(ResolveError::Failed {
            path: path.into(),
            code: output.status.code(),
            stderr: text(&output.stderr),
        });
    }
    let Some(version) = parse_version(&stdout) else {
        return Err(ResolveError::UnexpectedOutput {
            path: path.into(),
            stdout,
        });
    };
    if version < MINIMUM_VERSION {
        return Err(ResolveError::Unsupported {
            path: path.into(),
            version: stdout,
        });
    }
    // A file that just ran successfully has an identity unless it vanished in between; fall back
    // to the path itself rather than failing a working ExifTool.
    let identity = ExecutableIdentity::of(path).unwrap_or_else(|| ExecutableIdentity {
        canonical_path: path.into(),
        file_id: None,
    });
    Ok(ExifTool {
        path: path.into(),
        version: stdout,
        identity,
    })
}

/// ExifTool versions are `major.minor` with a two-digit minor, e.g. `13.55`.
fn parse_version(text: &str) -> Option<(u32, u32)> {
    let (major, minor) = text.split_once('.')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(major) || minor.len() != 2 || !digits(minor) {
        return None;
    }
    Some((major.parse().ok()?, minor.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    // @req FR-001, TST-001
    #[test]
    fn parses_only_bare_two_digit_versions() {
        assert_eq!(parse_version("13.55"), Some((13, 55)));
        assert_eq!(parse_version("9.99"), Some((9, 99)));
        for bad in [
            "",
            "13",
            "13.5",
            "13.555",
            "v13.55",
            "13.55 [Warning: Library version is 13.50]",
            "-1.00",
            "13.5x",
        ] {
            assert_eq!(parse_version(bad), None, "{bad:?}");
        }
        assert!(parse_version("13.60") > parse_version("13.55"));
        assert!(parse_version("14.00") > parse_version("13.99"));
    }
}
