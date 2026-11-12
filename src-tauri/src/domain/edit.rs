//! Staged metadata edits (S4-T01, FR-008) and deletions (S4-T02, FR-009): what the user asked to
//! change, typed so the value's shape (one text or a list of texts) survives to ExifTool
//! unchanged. They are only staged; the plan builder and executor (S4-T03, S4-T04) are the only
//! path that writes.

use serde::{Deserialize, Serialize};

/// Set one tag of one file to a new value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct SetTag {
    /// Family-1 group, e.g. `IFD0`, `XMP-dc`, `PDF`.
    pub group: String,
    pub name: String,
    pub value: EditValue,
}

/// A new value as ExifTool prints and accepts it: display text, written back exactly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub enum EditValue {
    Text {
        text: String,
    },
    /// Written item by item; one item with a comma stays one item.
    List {
        items: Vec<String>,
    },
}

/// Longest value accepted for one tag; far above any real text tag, and a bound on input.
pub const MAX_VALUE_BYTES: usize = 64 * 1024;

/// A group or tag name ExifTool would read as a name and nothing else.
///
/// Gotcha (probed on ExifTool 13.55): in `-<tag>=<value>` the tag position is a small language.
/// `<` copies (`-Make<FileName` set Make to the file name), and `+=`, `-=`, `^=`, `#` and `:`
/// change the meaning. Names here come from ExifTool's own output and lists, so only letters,
/// digits, `_` and `-` are allowed, starting with a letter or digit.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

impl SetTag {
    /// Why this edit cannot be staged or written, if it cannot.
    ///
    /// - Names must be plain names ([`valid_name`]).
    /// - `System` tags (file name, folder, dates, permissions) change the file itself: the spec
    ///   treats them as file-system operations with their own task (S6-T03), not tag edits.
    /// - An empty list would delete the tag; deletion is its own operation (S4-T02).
    /// - Values cannot contain NUL (an argument cannot carry it) and are bounded in size.
    pub fn problem(&self) -> Option<String> {
        if let Some(problem) = tag_problem(&self.group, &self.name) {
            return Some(problem);
        }
        let texts: Vec<&String> = match &self.value {
            EditValue::Text { text } => vec![text],
            EditValue::List { items } if items.is_empty() => {
                return Some("A list needs at least one item; removing a tag is a deletion".into())
            }
            EditValue::List { items } if items.iter().any(String::is_empty) => {
                return Some("List items cannot be empty".into())
            }
            EditValue::List { items } => items.iter().collect(),
        };
        if texts.iter().any(|text| text.contains('\0')) {
            return Some("Values cannot contain a NUL character".into());
        }
        if texts.iter().map(|text| text.len()).sum::<usize>() > MAX_VALUE_BYTES {
            return Some(format!(
                "Values are limited to {} KiB",
                MAX_VALUE_BYTES / 1024
            ));
        }
        None
    }
}

/// Why `group:name` cannot be written or deleted as a tag, if it cannot: shared by edits and
/// deletions so both refuse the same names.
fn tag_problem(group: &str, name: &str) -> Option<String> {
    if !valid_name(group) || !valid_name(name) {
        return Some(format!(
            "{group}:{name} is not a tag name ExifBee can write"
        ));
    }
    if group == "System" {
        return Some(
            "File system properties (name, folder, dates, permissions) change the file itself; \
             they are not edited as tags"
                .into(),
        );
    }
    None
}

/// Remove one tag of one file (S4-T02): `-GROUP:NAME=`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct DeleteTag {
    pub group: String,
    pub name: String,
}

impl DeleteTag {
    /// Why this deletion cannot be staged or written, if it cannot (same rules as [`SetTag`]).
    pub fn problem(&self) -> Option<String> {
        tag_problem(&self.group, &self.name)
    }
}

/// Remove every tag ExifTool can delete in one group (`-GROUP:All=`), or all metadata when
/// `group` is [`ALL_METADATA`] (`-all=`, high impact, SPEC §4.6).
///
/// Gotcha (probed on ExifTool 13.55): a group can hold others. Removing `IFD0` or `EXIF` also
/// removes `ExifIFD`, while removing `PNG` leaves the image-structure tags. The exact scope is
/// only known by trying it on a copy (`removal::preview_group_removal`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct DeleteGroup {
    pub group: String,
}

/// The [`DeleteGroup::group`] that means every group: ExifTool's own `-all=`.
pub const ALL_METADATA: &str = "All";

/// Groups ExifTool reports and cannot remove: file-system facts, derived values, its own notes.
const KEPT_GROUPS: &[&str] = &["System", "Composite", "ExifTool", "Other"];

impl DeleteGroup {
    /// Why this group cannot be removed, if it cannot.
    pub fn problem(&self) -> Option<String> {
        if !valid_name(&self.group) {
            return Some(format!("{} is not a group name", self.group));
        }
        if KEPT_GROUPS.contains(&self.group.as_str()) {
            return Some(format!(
                "{} is not stored in the file as metadata, so it cannot be removed",
                self.group
            ));
        }
        None
    }

    /// `-all=` removes every writable group, the highest-impact deletion (SPEC §4.6).
    pub fn is_all(&self) -> bool {
        self.group == ALL_METADATA
    }
}

/// One staged change as the renderer sends it for planning (S4-T03), tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub enum Change {
    Set(SetTag),
    DeleteTag(DeleteTag),
    DeleteGroup(DeleteGroup),
}

/// A file's staged changes, by the ID the registry issued.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct StagedFile {
    pub id: String,
    pub changes: Vec<Change>,
}
