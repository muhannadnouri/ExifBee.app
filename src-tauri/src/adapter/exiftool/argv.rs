//! The one way ExifBee builds ExifTool arguments (S2-T02, SEC-002): a list of separate OS
//! strings handed straight to the OS by `process::run`. Nothing is ever joined into a command
//! line or interpreted by a shell, so spaces, quotes, `;`, `&`, `$`, backticks, newlines or a
//! leading `-` in a file name are just bytes of that name.

use crate::domain::edit::{valid_name, EditValue, SetTag};
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
///   built from file names, metadata or anything the renderer sends. Tag names and user values
///   only enter through the typed [`Args::tag`] and [`Args::set`], which validate them.
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
    /// A tag edit or tag name that cannot be expressed safely; the text says why.
    Edit(String),
}

impl fmt::Display for ArgsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RelativeFile(path) => write!(f, "file path must be absolute: {}", path.display()),
            Self::Edit(problem) => f.write_str(problem),
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

    /// Appends `-api <setting>`, e.g. `StructFormat=JSONQ`. Like options, settings are static.
    pub fn api(mut self, setting: &'static str) -> Self {
        self.items.push("-api".into());
        self.items.push(setting.into());
        self
    }

    /// Selects one tag to print, `-GROUP:NAME`, e.g. for a `-b` read of its raw bytes.
    pub fn tag(mut self, group: &str, name: &str) -> Result<Self, ArgsError> {
        if !valid_name(group) || !valid_name(name) {
            return Err(ArgsError::Edit(format!("{group}:{name} is not a tag name")));
        }
        self.items.push(format!("-{group}:{name}").into());
        Ok(self)
    }

    /// Appends the assignments for one tag edit (S4-T01), after [`SetTag::problem`] passes.
    ///
    /// Example: text `Canon` → `-IFD0:Make=Canon`; list `a`, `b, c` →
    /// `-XMP-dc:Subject=a`, `-XMP-dc:Subject=b, c` (several assignments make a list; one item
    /// with a comma stays one item); empty text → `-IFD0:Artist^=`, because `-IFD0:Artist=` with
    /// nothing after it deletes the tag instead of emptying it.
    ///
    /// Gotcha: the value is everything after the first `=` and is never interpreted, so values
    /// such as `x<FileName` or `-overwrite_original` are stored literally (probed on 13.55).
    pub fn set(mut self, edit: &SetTag) -> Result<Self, ArgsError> {
        if let Some(problem) = edit.problem() {
            return Err(ArgsError::Edit(problem));
        }
        let target = format!("-{}:{}", edit.group, edit.name);
        match &edit.value {
            EditValue::Text { text } if text.is_empty() => {
                self.items.push(format!("{target}^=").into())
            }
            EditValue::Text { text } => self.items.push(format!("{target}={text}").into()),
            EditValue::List { items } => {
                for item in items {
                    self.items.push(format!("{target}={item}").into());
                }
            }
        }
        Ok(self)
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
