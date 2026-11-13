//! The plan builder (S4-T03, FR-010, SEC-004, SEC-006): turns staged changes into exactly what
//! would run, after proving each file is still the one the user inspected and every change is
//! still valid for it. Building a plan only reads; nothing here writes a file.

use crate::adapter::exiftool::argv::{Args, ArgsError};
use crate::adapter::exiftool::display::{display, DisplayedCommand, Shell};
use crate::adapter::exiftool::process::CancelToken;
use crate::adapter::exiftool::read::{raw_is_utf8, read_metadata, FileMetadata, ReadError};
use crate::adapter::exiftool::removal::{dry_run, preview_group_removal};
use crate::adapter::exiftool::resolver::ExifTool;
use crate::domain::edit::{
    Change, CopySelection, CopyTags, DeleteGroup, DeleteTag, EditValue, SetTag,
};
use crate::domain::metadata::{MetadataValue, TagEntry, Writability};
use crate::platform::{can_write, free_bytes};
use crate::service::capabilities::CapabilitySnapshot;
use crate::service::files::{FileId, FileIdentity};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

// Wording shared with the editor (SPEC §5.5).
const READ_ONLY: &str =
    "This tag or file format is not writable through the selected ExifTool version.";
const UNKNOWN: &str = "Write support could not be confirmed. ExifTool may reject this operation; the original will be backed up.";
const NO_PERMISSION: &str =
    "You do not have permission to change this file or the folder it is in, so it is left as it is.";

/// One file to plan: what the registry knows about it and what the user staged.
pub struct PlanInput {
    pub id: FileId,
    /// The path the user chose (it may be a symlink).
    pub chosen: PathBuf,
    /// What the file was when the user inspected it; `None` if it was never read for inspection
    /// (a copy destination), in which case its identity now is used.
    pub recorded: Option<FileIdentity>,
    pub changes: Vec<Change>,
}

/// What applying the staged changes would do, file by file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct PlanPreview {
    /// Names this plan for `apply_plan`; set when the command stores it (S4-T04).
    pub plan_id: u32,
    pub files: Vec<FilePlan>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct FilePlan {
    pub id: FileId,
    pub name: String,
    /// The real file that would change (symlinks resolved), for display.
    pub target: String,
    /// The path the user chose, when it is a link to `target`.
    pub link: Option<String>,
    /// Why the file is skipped; empty when it is ready.
    pub problems: Vec<String>,
    pub warnings: Vec<String>,
    pub changes: Vec<PlannedChange>,
    /// The backup ExifTool would create; `None` when skipped or when an older backup is kept.
    pub backup: Option<String>,
    /// The exact arguments to run with ExifTool's default backup, `Some` only when ready.
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub args: Option<Args>,
    /// The validated changes in run order, for the executor to rebuild `args` with its policy.
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub edits: Vec<Change>,
    /// The identity the plan was checked against; the executor checks it again (S4-T04).
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub identity: Option<FileIdentity>,
    /// Each copy source as checked while planning; the executor checks them again (S4-T06).
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub sources: HashMap<FileId, FileIdentity>,
    /// The file's tags as read while planning, for verifying untouched tags after the write.
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub before: Vec<TagEntry>,
    /// The same arguments as a runnable POSIX command (shown and copied in S4-T07).
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub command: Option<DisplayedCommand>,
}

impl FilePlan {
    pub fn ready(&self) -> bool {
        self.problems.is_empty()
    }
}

/// One line of the readable diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct PlannedChange {
    /// `IFD0:Make`, `XMP-dc group` or `All metadata`.
    pub target: String,
    /// The current value, from a read made while planning; `None` for a new tag or a group.
    pub before: Option<String>,
    /// The new value; `None` when removed.
    pub after: Option<String>,
    /// `Group:Tag` of every tag a group removal takes, from a dry run made while planning.
    pub removes: Vec<String>,
    /// For a copy: every tag it would write (copied, and any ExifTool adds), from a dry run.
    pub copies: Vec<CopiedTag>,
    /// For a copy: selected source tags this file cannot store (`Group:Tag`).
    pub cannot_copy: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct CopiedTag {
    /// `Group:Tag`.
    pub key: String,
    pub value: String,
}

/// Builds the plan for every staged file (SPEC §4.5 preflight).
///
/// Flow per file: identity now == identity when inspected (same real file, size, time) → write
/// access, no leftover `<file>_exiftool_tmp`, free space for ExifTool's temporary copy → a fresh
/// read → every change re-validated against it → arguments in a safe order. A file with any
/// problem is skipped whole, with every reason, so a file is never partly changed unseen.
///
/// Gotchas (probed on ExifTool 13.55):
/// - Writing through a symlink replaces the link with a regular file and leaves the real file
///   unchanged, so arguments always name the real path.
/// - An existing `<file>_original` is kept and the current version is not backed up: a warning,
///   because the user loses the ability to restore this version from a backup.
/// - A value set before its group's removal is removed with it: removals go first.
pub fn build_plan(
    tool: &ExifTool,
    snapshot: Option<&CapabilitySnapshot>,
    inputs: Vec<PlanInput>,
    sources: &HashMap<FileId, PathBuf>,
    work_dir: &Path,
    cancel: &CancelToken,
) -> Result<PlanPreview, ReadError> {
    let mut files = Vec::with_capacity(inputs.len());
    // shortcut: one read per file; batch these reads when plans reach many files (S5-T01).
    for input in inputs {
        files.push(plan_file(tool, snapshot, input, sources, work_dir, cancel)?);
    }
    Ok(PlanPreview { plan_id: 0, files })
}

fn plan_file(
    tool: &ExifTool,
    snapshot: Option<&CapabilitySnapshot>,
    input: PlanInput,
    sources: &HashMap<FileId, PathBuf>,
    work_dir: &Path,
    cancel: &CancelToken,
) -> Result<FilePlan, ReadError> {
    let name = input.chosen.file_name().map_or_else(
        || input.chosen.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let mut plan = FilePlan {
        id: input.id,
        name,
        target: input.chosen.display().to_string(),
        link: None,
        problems: Vec::new(),
        warnings: Vec::new(),
        changes: Vec::new(),
        backup: None,
        args: None,
        edits: Vec::new(),
        identity: None,
        sources: HashMap::new(),
        before: Vec::new(),
        command: None,
    };
    if input.changes.is_empty() {
        plan.problems
            .push("Nothing is staged for this file.".into());
        return Ok(plan);
    }
    // A copy destination need not have been opened: the review shows its fresh read instead.
    let Some(recorded) = input
        .recorded
        .or_else(|| FileIdentity::of(&input.chosen).ok())
    else {
        plan.problems
            .push("The file is missing or can no longer be read.".into());
        return Ok(plan);
    };
    let target = recorded.real_path.clone();
    plan.target = target.display().to_string();
    if input.chosen != target {
        plan.link = Some(input.chosen.display().to_string());
    }
    match FileIdentity::of(&input.chosen) {
        Err(_) => plan
            .problems
            .push("The file is missing or can no longer be read.".into()),
        Ok(now) if now.real_path != recorded.real_path => plan.problems.push(format!(
            "The link now leads to a different file ({}); open it again to see what it is.",
            now.real_path.display()
        )),
        Ok(now) if now != recorded => plan.problems.push(
            "The file changed after it was read; open it again to see its current metadata.".into(),
        ),
        Ok(_) => {}
    }
    if !plan.problems.is_empty() {
        return Ok(plan);
    }
    if !can_write(&target) {
        plan.problems.push(NO_PERMISSION.into());
    }
    let temporary = sibling(&target, "_exiftool_tmp");
    if temporary.symlink_metadata().is_ok() {
        plan.problems.push(format!(
            "A temporary file from an earlier ExifTool run is in the way ({}); ExifTool will not write until it is removed.",
            temporary.display()
        ));
    }
    let folder = target.parent().unwrap_or(&target);
    if free_bytes(folder).is_some_and(|free| free < recorded.size) {
        plan.problems.push(format!(
            "Not enough free disk space: ExifTool needs about {} bytes for its temporary copy.",
            recorded.size
        ));
    }
    let backup = sibling(&target, "_original");
    if backup.symlink_metadata().is_ok() {
        plan.warnings.push(format!(
            "A backup from an earlier change already exists ({}). ExifTool keeps it and does not back up the current version.",
            backup.display()
        ));
    } else {
        plan.backup = Some(backup.display().to_string());
    }
    if !plan.problems.is_empty() {
        plan.backup = None;
        return Ok(plan);
    }

    let mut file = read_metadata(tool, &target)?;
    if let Some(snapshot) = snapshot {
        snapshot.annotate(&mut file);
    }
    if file.format_writable == Some(false) {
        plan.problems.push(READ_ONLY.into());
        plan.backup = None;
        return Ok(plan);
    }
    let mut seen = HashSet::new();
    // Removals first, then deleted tags, then values (see the order gotcha above).
    let mut ordered = input.changes;
    ordered.sort_by_key(|change| match change {
        Change::DeleteGroup(_) => 0,
        Change::DeleteTag(_) => 1,
        Change::CopyTags(_) => 2,
        Change::Set(_) => 3,
    });
    for change in &ordered {
        let label = match change {
            Change::Set(SetTag { group, name, .. })
            | Change::DeleteTag(DeleteTag { group, name }) => {
                format!("{group}:{name}")
            }
            Change::DeleteGroup(delete) if delete.is_all() => "All metadata".into(),
            Change::DeleteGroup(DeleteGroup { group }) => format!("{group} group"),
            Change::CopyTags(copy) => copy_label(copy, sources),
        };
        if !seen.insert(label.clone()) {
            plan.problems
                .push(format!("{label} is staged more than once."));
            continue;
        }
        let checked = match change {
            Change::Set(edit) => {
                check_set(tool, snapshot, &target, &file, edit, &mut plan.warnings)?
            }
            Change::DeleteTag(delete) => check_delete_tag(&file, delete),
            Change::DeleteGroup(delete) => {
                check_delete_group(tool, &target, delete, work_dir, cancel)?
            }
            Change::CopyTags(copy) => check_copy(
                tool, snapshot, &target, &file, copy, sources, work_dir, cancel,
            )?
            .map(|(planned, source)| {
                plan.sources.insert(copy.source.clone(), source);
                planned
            }),
        };
        match checked {
            Ok(planned) => plan.changes.push(PlannedChange {
                target: label.clone(),
                ..planned
            }),
            Err(problem) => plan.problems.push(format!("{label}: {problem}")),
        }
    }
    let deletes = ordered
        .iter()
        .any(|change| matches!(change, Change::DeleteTag(_) | Change::DeleteGroup(_)));
    if deletes && file_type(&file) == Some("PDF") {
        plan.warnings.push(
            "PDF changes are added to the end of the file: removed values are hidden from readers but can still be recovered from the file.".into(),
        );
    }
    if plan.problems.is_empty() {
        let args = write_args(&ordered, &target, false, &plan.sources)
            .map_err(|error| ReadError::InvalidInput(error.to_string()))?;
        plan.command = Some(display(Shell::Posix, &tool.path, args.as_slice()));
        plan.args = Some(args);
        plan.edits = ordered;
        plan.identity = Some(recorded);
        plan.before = file.tags;
    } else {
        plan.backup = None;
    }
    Ok(plan)
}

/// The arguments for `changes` (already in run order) on `target`, the one place both the
/// preview and the executor build them, so what was reviewed is what runs.
///
/// `overwrite` adds ExifTool's `-overwrite_original` (no `_original` backup); only the
/// executor's explicit `OverwriteOriginals` policy sets it (S4-T04, SEC-005).
pub fn write_args(
    changes: &[Change],
    target: &Path,
    overwrite: bool,
    sources: &HashMap<FileId, FileIdentity>,
) -> Result<Args, ArgsError> {
    let mut args = if overwrite {
        Args::new().options(&["-overwrite_original"])
    } else {
        Args::new()
    };
    for change in changes {
        args = match change {
            Change::Set(edit) => args.set(edit)?,
            Change::DeleteTag(delete) => args.delete_tag(delete)?,
            Change::DeleteGroup(delete) => args.delete_group(delete)?,
            Change::CopyTags(copy) => {
                let source = sources.get(&copy.source).ok_or_else(|| {
                    ArgsError::Edit(format!("the copy source {} was not checked", copy.source))
                })?;
                args.copy_from(&source.real_path, copy)?
            }
        };
    }
    args.files([target])
}

/// `/a/photo.jpg` + `_original` → `/a/photo.jpg_original`, ExifTool's naming.
pub fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(suffix);
    PathBuf::from(name)
}

fn file_type(file: &FileMetadata) -> Option<&str> {
    file.tags.iter().find_map(|tag| match &tag.value {
        MetadataValue::Text { text } if tag.key == "File:FileType" => Some(text.as_str()),
        _ => None,
    })
}

/// The file's tags named `group:name` (one, or several copies, or none).
fn matching<'a>(file: &'a FileMetadata, group: &str, name: &str) -> Vec<&'a TagEntry> {
    file.tags
        .iter()
        .filter(|tag| tag.group1 == group && tag.name == name)
        .collect()
}

/// A value as the diff shows it, like the inspector does.
pub fn shown(value: &MetadataValue) -> String {
    match value {
        MetadataValue::Text { text } => text.clone(),
        MetadataValue::List { items } => items.iter().map(shown).collect::<Vec<_>>().join(", "),
        MetadataValue::Structure { fields } => format!(
            "{{{}}}",
            fields
                .iter()
                .map(|field| format!("{}={}", field.name, shown(&field.value)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        MetadataValue::Binary { byte_length } => match byte_length {
            Some(length) => format!("(Binary data {length} bytes)"),
            None => "(Binary data of unknown size)".into(),
        },
    }
}

fn change(before: Option<String>, after: Option<String>) -> PlannedChange {
    PlannedChange {
        target: String::new(),
        before,
        after,
        removes: Vec::new(),
        copies: Vec::new(),
        cannot_copy: Vec::new(),
    }
}

/// `Copy from photo.jpg: all metadata`, `…: XMP-dc group`, `…: IFD0:Make`, `…: 3 tags`.
fn copy_label(copy: &CopyTags, sources: &HashMap<FileId, PathBuf>) -> String {
    let source = sources
        .get(&copy.source)
        .and_then(|path| path.file_name())
        .map_or_else(
            || copy.source.clone(),
            |name| name.to_string_lossy().into_owned(),
        );
    let what = match &copy.what {
        CopySelection::All => "all metadata".to_string(),
        CopySelection::Group { group } => format!("{group} group"),
        CopySelection::Tags { tags } if tags.len() == 1 => {
            format!("{}:{}", tags[0].group, tags[0].name)
        }
        CopySelection::Tags { tags } => format!("{} tags", tags.len()),
    };
    format!("Copy from {source}: {what}")
}

/// Groups never copied or compared: file-system facts, derived values, ExifTool's notes, and
/// the file's own structure (`File`).
const NOT_COPIED: &[&str] = &["System", "ExifTool", "Composite", "File"];

/// Checks a copy and finds exactly what it would write, by running it on a private copy of the
/// destination (`-o`, like group removals): which tags it writes (copied, plus any ExifTool adds,
/// such as required EXIF tags), and which selected source tags this file cannot store (EXIF
/// into a PDF is dropped silently, probed on 13.55).
///
/// Returns the planned change and the source's identity, which the executor checks again.
#[allow(clippy::too_many_arguments)]
fn check_copy(
    tool: &ExifTool,
    snapshot: Option<&CapabilitySnapshot>,
    target: &Path,
    file: &FileMetadata,
    copy: &CopyTags,
    sources: &HashMap<FileId, PathBuf>,
    work_dir: &Path,
    cancel: &CancelToken,
) -> Result<Result<(PlannedChange, FileIdentity), String>, ReadError> {
    if let Some(problem) = copy.problem() {
        return Ok(Err(problem));
    }
    let Some(source_path) = sources.get(&copy.source) else {
        return Ok(Err("the source is not a file added in this session.".into()));
    };
    let Ok(source) = FileIdentity::of(source_path) else {
        return Ok(Err(
            "the source file is missing or can no longer be read.".into()
        ));
    };
    if source.real_path == target {
        return Ok(Err("a file cannot be copied onto itself.".into()));
    }
    let mut source_file = read_metadata(tool, &source.real_path)?;
    if let Some(snapshot) = snapshot {
        snapshot.annotate(&mut source_file);
    }
    let args = Args::new().copy_from(&source.real_path, copy);
    let preview = match args {
        Ok(args) => dry_run(tool, target, args, work_dir, cancel)?,
        Err(error) => return Ok(Err(error.to_string())),
    };
    let Some(after) = preview.after else {
        return Ok(Err(format!(
            "ExifTool cannot write this file. {}",
            preview.messages.join(" ")
        )
        .trim_end()
        .to_string()));
    };
    let copies = changed_tags(&file.tags, &after.tags);
    if copies.is_empty() {
        return Ok(Err(format!(
            "nothing to copy. {}",
            preview.messages.join(" ")
        )
        .trim_end()
        .to_string()));
    }
    let selected = source_file.tags.iter().filter(|tag| {
        !NOT_COPIED.contains(&tag.group1.as_str())
            && match &copy.what {
                CopySelection::All => true,
                CopySelection::Group { group } => {
                    tag.group1 == *group || tag.group0.as_deref() == Some(group)
                }
                CopySelection::Tags { tags } => tags
                    .iter()
                    .any(|wanted| wanted.group == tag.group1 && wanted.name == tag.name),
            }
    });
    let mut cannot_copy: Vec<String> = selected
        .filter(|tag| {
            let value = shown(&tag.value);
            !after.tags.iter().any(|kept| {
                kept.group1 == tag.group1 && kept.name == tag.name && shown(&kept.value) == value
            })
        })
        .map(|tag| format!("{}:{}", tag.group1, tag.name))
        .collect();
    cannot_copy.dedup();
    Ok(Ok((
        PlannedChange {
            copies,
            cannot_copy,
            ..change(None, None)
        },
        source,
    )))
}

/// Tags in `after` that `before` does not have with the same value (by group and name).
fn changed_tags(before: &[TagEntry], after: &[TagEntry]) -> Vec<CopiedTag> {
    let mut left: HashMap<(&str, &str), Vec<String>> = HashMap::new();
    for tag in before {
        left.entry((&tag.group1, &tag.name))
            .or_default()
            .push(shown(&tag.value));
    }
    after
        .iter()
        .filter(|tag| !NOT_COPIED.contains(&tag.group1.as_str()) && tag.key != "XMP-x:XMPToolkit")
        .filter_map(|tag| {
            let value = shown(&tag.value);
            let same = left.get_mut(&(tag.group1.as_str(), tag.name.as_str()));
            match same
                .and_then(|values| values.iter().position(|v| *v == value).map(|i| (values, i)))
            {
                Some((values, index)) => {
                    values.remove(index);
                    None
                }
                None => Some(CopiedTag {
                    key: format!("{}:{}", tag.group1, tag.name),
                    value,
                }),
            }
        })
        .collect()
}

/// The DEC-028 rules again, against the file as it is now.
fn check_set(
    tool: &ExifTool,
    snapshot: Option<&CapabilitySnapshot>,
    target: &Path,
    file: &FileMetadata,
    edit: &SetTag,
    warnings: &mut Vec<String>,
) -> Result<Result<PlannedChange, String>, ReadError> {
    if let Some(problem) = edit.problem() {
        return Ok(Err(problem));
    }
    let after = match &edit.value {
        EditValue::Text { text } => text.clone(),
        EditValue::List { items } => items.join(", "),
    };
    let found = matching(file, &edit.group, &edit.name);
    let before = match found.as_slice() {
        [] => {
            match snapshot.and_then(|snapshot| snapshot.tag(&edit.group, &edit.name)) {
                Some(listed) if !listed.writable => return Ok(Err(READ_ONLY.into())),
                Some(_) if file.format_writable == Some(true) => {}
                _ => warnings.push(format!("{}:{}: {UNKNOWN}", edit.group, edit.name)),
            }
            None
        }
        [tag] => {
            match tag.writable {
                Writability::ReadOnly => return Ok(Err(READ_ONLY.into())),
                Writability::Unknown => warnings.push(format!("{}: {UNKNOWN}", tag.key)),
                Writability::Writable => {}
            }
            let editable = match &tag.value {
                MetadataValue::Text { .. } => true,
                MetadataValue::List { items } => items
                    .iter()
                    .all(|item| matches!(item, MetadataValue::Text { .. })),
                _ => false,
            };
            if !editable {
                return Ok(Err(
                    "Structures and binary data need dedicated operations to edit.".into(),
                ));
            }
            if !raw_is_utf8(tool, target, &edit.group, &edit.name)? {
                return Ok(Err(
                    "The stored value holds bytes that are not text; it was shown with question marks.".into(),
                ));
            }
            Some(shown(&tag.value))
        }
        several => {
            return Ok(Err(format!(
                "this file has {} of these tags; ExifTool cannot change one of them on its own.",
                several.len()
            )))
        }
    };
    Ok(Ok(change(before, Some(after))))
}

fn check_delete_tag(file: &FileMetadata, delete: &DeleteTag) -> Result<PlannedChange, String> {
    if let Some(problem) = delete.problem() {
        return Err(problem);
    }
    match matching(file, &delete.group, &delete.name).as_slice() {
        [] => Err("the tag is no longer in the file.".into()),
        [tag] if tag.writable == Writability::ReadOnly => Err(READ_ONLY.into()),
        [tag] => Ok(change(Some(shown(&tag.value)), None)),
        several => Err(format!(
            "this file has {} of these tags; ExifTool cannot delete one of them on its own.",
            several.len()
        )),
    }
}

/// Runs the removal on a private copy again, so the diff lists what would really go.
fn check_delete_group(
    tool: &ExifTool,
    target: &Path,
    delete: &DeleteGroup,
    work_dir: &Path,
    cancel: &CancelToken,
) -> Result<Result<PlannedChange, String>, ReadError> {
    if let Some(problem) = delete.problem() {
        return Ok(Err(problem));
    }
    let preview = preview_group_removal(tool, target, delete, work_dir, cancel)?;
    if preview.removed.is_empty() {
        let why = preview.messages.join(" ");
        return Ok(Err(format!("nothing to remove. {why}")
            .trim_end()
            .to_string()));
    }
    Ok(Ok(PlannedChange {
        removes: preview
            .removed
            .iter()
            .map(|tag| format!("{}:{}", tag.group1, tag.name))
            .collect(),
        ..change(None, None)
    }))
}
