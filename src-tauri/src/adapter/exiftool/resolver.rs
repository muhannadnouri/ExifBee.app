//! Finds and validates a system ExifTool executable (SPEC §3.2). The executable is always
//! spawned directly with an argument vector, never through a shell (SEC-002).

use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Oldest ExifTool version CI tests against: the Ubuntu 24.04 LTS package (SPEC §3.2, DEC-014).
pub const MINIMUM_VERSION: (u32, u32) = (12, 76);
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT_BYTES: u64 = 64 * 1024;

/// Package-managed locations probed before PATH, because desktop launchers often get a
/// shorter PATH than login shells (e.g. Arch's /usr/bin/vendor_perl). Suggestions only.
#[cfg(target_os = "linux")]
const KNOWN_LOCATIONS: &[&str] = &[
    "/usr/bin/exiftool",
    "/usr/local/bin/exiftool",
    "/usr/bin/vendor_perl/exiftool",
];
#[cfg(not(target_os = "linux"))]
const KNOWN_LOCATIONS: &[&str] = &[];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExifTool {
    pub path: PathBuf,
    pub version: String,
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

/// Resolves ExifTool from an optional user override, else known locations then PATH.
pub fn resolve(user_override: Option<&Path>) -> Result<ExifTool, ResolveError> {
    resolve_from(user_override, default_candidates())
}

/// An override is used exclusively: a broken user choice is reported, never silently replaced.
/// Otherwise the first candidate that passes validation wins; candidates that do not exist are skipped.
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
    for path in candidates.iter().filter(|path| path.is_file()) {
        match probe(path, DEFAULT_TIMEOUT) {
            Ok(tool) => return Ok(tool),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or(ResolveError::NotFound {
        searched: candidates,
    }))
}

fn default_candidates() -> Vec<PathBuf> {
    let path_dirs = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut candidates: Vec<PathBuf> = KNOWN_LOCATIONS.iter().map(PathBuf::from).collect();
    // Relative PATH entries (e.g. ".") depend on the working directory and are not trusted.
    for dir in path_dirs.into_iter().filter(|dir| dir.is_absolute()) {
        let candidate = dir.join("exiftool");
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

/// Runs `<path> -ver` without a shell and accepts only a bare `major.minor` version at or above the minimum.
pub fn probe(path: &Path, timeout: Duration) -> Result<ExifTool, ResolveError> {
    let mut child = Command::new(path)
        .arg("-ver")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| ResolveError::Launch {
            path: path.into(),
            message: error.to_string(),
        })?;

    // shortcut: polling wait and post-exit pipe reads; output beyond the pipe buffer stalls the
    // child until the timeout kills it. S2-T03 replaces this with the bounded streaming executor.
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ResolveError::Timeout {
                    path: path.into(),
                    after: timeout,
                });
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ResolveError::Launch {
                    path: path.into(),
                    message: error.to_string(),
                });
            }
        }
    };
    let stdout = read_bounded(child.stdout.take());
    let stderr = read_bounded(child.stderr.take());

    if !status.success() {
        return Err(ResolveError::Failed {
            path: path.into(),
            code: status.code(),
            stderr,
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
    Ok(ExifTool {
        path: path.into(),
        version: stdout,
    })
}

fn read_bounded(pipe: Option<impl Read>) -> String {
    let mut bytes = Vec::new();
    if let Some(pipe) = pipe {
        let _ = pipe.take(MAX_OUTPUT_BYTES).read_to_end(&mut bytes);
    }
    String::from_utf8_lossy(&bytes).trim().to_string()
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
