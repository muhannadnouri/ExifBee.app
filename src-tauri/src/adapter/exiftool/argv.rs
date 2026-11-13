//! The one way ExifBee builds ExifTool arguments (S2-T02, SEC-002): a list of separate OS
//! strings handed straight to the OS by `process::run`. Nothing is ever joined into a command
//! line or interpreted by a shell, so spaces, quotes, `;`, `&`, `$`, backticks, newlines or a
//! leading `-` in a file name are just bytes of that name.

use crate::domain::edit::{
    valid_name, CopySelection, CopyTags, DeleteGroup, DeleteTag, EditValue, SetTag,
};
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

    /// Appends the deletion of one tag (S4-T02): `-IFD0:Make=` (an empty assignment deletes).
    pub fn delete_tag(mut self, delete: &DeleteTag) -> Result<Self, ArgsError> {
        if let Some(problem) = delete.problem() {
            return Err(ArgsError::Edit(problem));
        }
        self.items
            .push(format!("-{}:{}=", delete.group, delete.name).into());
        Ok(self)
    }

    /// Appends the removal of a group, `-XMP-dc:All=`, or of all metadata, `-all=` (S4-T02).
    pub fn delete_group(mut self, delete: &DeleteGroup) -> Result<Self, ArgsError> {
        if let Some(problem) = delete.problem() {
            return Err(ArgsError::Edit(problem));
        }
        let arg = if delete.is_all() {
            "-all=".to_string()
        } else {
            format!("-{}:All=", delete.group)
        };
        self.items.push(arg.into());
        Ok(self)
    }

    /// Appends a copy from `source` (S4-T06): `-TagsFromFile <source>` then `-all:all`,
    /// `-GROUP:all` or one `-GROUP:NAME` per tag (each name once).
    ///
    /// Gotcha: `source` must be absolute (it follows `-TagsFromFile`, where a leading `-` would
    /// be misread); the selectors carry no `<` or `=`, so they only select, never redirect.
    pub fn copy_from(mut self, source: &Path, copy: &CopyTags) -> Result<Self, ArgsError> {
        if let Some(problem) = copy.problem() {
            return Err(ArgsError::Edit(problem));
        }
        if !source.is_absolute() {
            return Err(ArgsError::RelativeFile(source.to_path_buf()));
        }
        self.items.push("-TagsFromFile".into());
        self.items.push(source.as_os_str().to_owned());
        match &copy.what {
            CopySelection::All => self.items.push("-all:all".into()),
            CopySelection::Group { group } => self.items.push(format!("-{group}:all").into()),
            CopySelection::Tags { tags } => {
                let mut seen = std::collections::HashSet::new();
                for tag in tags.iter().filter(|tag| seen.insert(*tag)) {
                    self.items
                        .push(format!("-{}:{}", tag.group, tag.name).into());
                }
            }
        }
        Ok(self)
    }

    /// Appends `-o <file>`: write the result to a new file instead of changing the target.
    ///
    /// Only for previews into ExifBee's own private folder (S4-T02); the path must be absolute,
    /// so it cannot be read as an option.
    pub fn output(mut self, file: &Path) -> Result<Self, ArgsError> {
        if !file.is_absolute() {
            return Err(ArgsError::RelativeFile(file.to_path_buf()));
        }
        self.items.push("-o".into());
        self.items.push(file.as_os_str().to_owned());
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
