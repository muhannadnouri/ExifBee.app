//! The one way ExifBee builds ExifTool arguments (S2-T02, SEC-002): a list of separate OS
//! strings handed straight to the OS by `process::run`. Nothing is ever joined into a command
//! line or interpreted by a shell, so spaces, quotes, `;`, `&`, `$`, backticks, newlines or a
//! leading `-` in a file name are just bytes of that name.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

/// ExifTool arguments: fixed options first, then `--`, then absolute target files.
///
/// Example: `Args::new().options(&["-json", "-G1:4"]).files([path])?` →
/// `["-json", "-G1:4", "--", "/photos/-odd; name.jpg"]`.
///
/// Gotchas:
/// - Options are `&'static str` on purpose: they can only be written in ExifBee's source, never
///   built from file names, metadata or anything the renderer sends. Tag assignments with user
///   values get their own typed method when writes arrive (S4), not a free-form string.
/// - Files must be absolute, so none can start with `-`; `--` before them is a second guard.
/// - This is one-shot argv. `-stay_open` argument streams have different framing rules
///   (SPEC §4.4 note) and are built separately in S2-T03.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Args {
    items: Vec<OsString>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgsError {
    RelativeFile(PathBuf),
}

impl fmt::Display for ArgsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RelativeFile(path) => write!(f, "file path must be absolute: {}", path.display()),
        }
    }
}

impl std::error::Error for ArgsError {}

impl Args {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends fixed options such as `-json` or `-G1:4`.
    pub fn options(mut self, options: &[&'static str]) -> Self {
        debug_assert!(
            options.iter().all(|option| option.starts_with('-')),
            "{options:?}"
        );
        self.items.extend(options.iter().map(OsString::from));
        self
    }

    /// Ends option parsing with `--` and appends the target files, which must be absolute.
    pub fn files<I, P>(mut self, files: I) -> Result<Self, ArgsError>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        self.items.push("--".into());
        for file in files {
            let file = file.as_ref();
            if !file.is_absolute() {
                return Err(ArgsError::RelativeFile(file.into()));
            }
            self.items.push(file.as_os_str().into());
        }
        Ok(self)
    }

    pub fn as_slice(&self) -> &[OsString] {
        &self.items
    }
}
