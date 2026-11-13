//! The executor (S4-T04, FR-011, FR-014, SEC-005): runs an approved plan, file by file, after
//! checking each file once more right before writing. Only a plan built by `service::plan` can
//! run, so every argument was validated and shown to the user first.

use crate::adapter::exiftool::process::{self, CancelToken};
use crate::adapter::exiftool::resolver::ExifTool;
use crate::platform::can_write;
use crate::service::files::{FileId, FileIdentity};
use crate::service::plan::{sibling, write_args, FilePlan, PlanPreview};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// One file's write rewrites the whole file, so large videos need time.
const WRITE_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_WRITE_OUTPUT: usize = 1024 * 1024;

/// What happens to the original: ExifTool's own `<file>_original` (the default), or nothing
/// kept, which the user must choose and confirm (SPEC §4.5, SEC-005).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub enum BackupPolicy {
    KeepBackups,
    OverwriteOriginals,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub enum Outcome {
    /// ExifTool reported the file updated (values are verified by reading back in S4-T05).
    Changed,
    /// ExifTool ran and changed nothing.
    Unchanged,
    /// ExifTool refused or failed; the file is as it was.
    Failed,
    /// Not run: the plan skipped it, or it changed after review.
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct FileOutcome {
    pub id: FileId,
    pub name: String,
    pub outcome: Outcome,
    /// Why it failed or was skipped, or a note such as an earlier backup being kept.
    pub message: Option<String>,
    /// The backup ExifTool made of this file's original, if it made one now.
    pub backup: Option<String>,
    /// ExifTool's warnings for this file.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ApplyResult {
    pub files: Vec<FileOutcome>,
}

/// The stored plan if it is the one approved (`plan_id`), removing it so it runs only once;
/// `None` for an older review, an unknown ID or a plan already applied.
pub fn take_approved(stored: &mut Option<PlanPreview>, plan_id: u32) -> Option<PlanPreview> {
    match stored {
        Some(plan) if plan.plan_id == plan_id => stored.take(),
        _ => None,
    }
}

/// Runs every ready file of `plan` with `policy`; one file's failure never stops the others.
///
/// Flow per file: skipped in the plan → `Skipped` → identity, write access and leftover temp
/// file checked again (the file may have changed since review; it is then left untouched) →
/// arguments rebuilt from the plan's validated changes with the policy → ExifTool → outcome
/// from its report (`1 image files updated` / `… unchanged` / errors).
///
/// Gotcha (probed on 13.55): when `<file>_original` already exists ExifTool keeps it and makes
/// no new backup, so `backup` is only reported when the file did not exist before the write.
pub fn apply_plan(tool: &ExifTool, plan: &PlanPreview, policy: BackupPolicy) -> ApplyResult {
    ApplyResult {
        files: plan
            .files
            .iter()
            .map(|file| apply_file(tool, file, policy))
            .collect(),
    }
}

fn apply_file(tool: &ExifTool, file: &FilePlan, policy: BackupPolicy) -> FileOutcome {
    let mut result = FileOutcome {
        id: file.id.clone(),
        name: file.name.clone(),
        outcome: Outcome::Skipped,
        message: None,
        backup: None,
        warnings: Vec::new(),
    };
    let (Some(identity), true) = (&file.identity, file.ready()) else {
        result.message = Some(file.problems.join(" "));
        return result;
    };
    let target = &identity.real_path;
    let skip = if FileIdentity::of(target).ok().as_ref() != Some(identity) {
        Some(
            "The file changed after the changes were reviewed; it was left as it is. Review again.",
        )
    } else if !can_write(target) {
        Some("You do not have permission to change this file or the folder it is in, so it is left as it is.")
    } else if sibling(target, "_exiftool_tmp").symlink_metadata().is_ok() {
        Some("A temporary file from an earlier ExifTool run is in the way; the file was left as it is.")
    } else {
        None
    };
    if let Some(reason) = skip {
        result.message = Some(reason.into());
        return result;
    }

    let backup = sibling(target, "_original");
    let had_backup = backup.symlink_metadata().is_ok();
    let overwrite = policy == BackupPolicy::OverwriteOriginals;
    let args = match write_args(&file.edits, target, overwrite) {
        Ok(args) => args,
        Err(error) => {
            result.outcome = Outcome::Failed;
            result.message = Some(error.to_string());
            return result;
        }
    };
    // shortcut: not cancellable mid-file yet; job cancellation arrives with S5-T02.
    let run = process::run(
        &tool.path,
        args.as_slice(),
        WRITE_TIMEOUT,
        MAX_WRITE_OUTPUT,
        &CancelToken::default(),
    );
    let output = match run {
        Ok(output) => output,
        Err(error) => {
            result.outcome = Outcome::Failed;
            result.message = Some(format!("ExifTool {error}"));
            return result;
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    result.warnings = stderr
        .lines()
        .filter_map(|line| line.trim().strip_prefix("Warning: "))
        .map(String::from)
        .collect();
    let errors: Vec<&str> = stderr
        .lines()
        .filter_map(|line| line.trim().strip_prefix("Error: "))
        .collect();
    result.outcome = if !errors.is_empty() || !output.status.success() {
        Outcome::Failed
    } else if stdout.contains("1 image files updated") {
        Outcome::Changed
    } else if stdout.contains("1 image files unchanged") {
        Outcome::Unchanged
    } else {
        Outcome::Failed
    };
    match result.outcome {
        Outcome::Failed => {
            result.message = Some(if errors.is_empty() {
                format!("ExifTool did not report a change: {}", stdout.trim())
            } else {
                errors.join(" ")
            });
        }
        Outcome::Changed if overwrite => {
            result.message = Some("No backup was kept, as chosen.".into());
        }
        Outcome::Changed if had_backup => {
            result.message = Some(format!(
                "An earlier backup was kept as it was ({}); this version has no backup.",
                backup.display()
            ));
        }
        Outcome::Changed => result.backup = Some(backup.display().to_string()),
        _ => {}
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // @req SEC-004
    #[test]
    fn only_the_latest_reviewed_plan_runs_and_only_once() {
        let plan = |plan_id| PlanPreview {
            plan_id,
            files: Vec::new(),
        };
        let mut stored = Some(plan(7));
        assert_eq!(take_approved(&mut stored, 6), None, "an older review");
        assert_eq!(take_approved(&mut stored, 8), None, "an unknown ID");
        assert_eq!(take_approved(&mut stored, 7), Some(plan(7)));
        assert_eq!(take_approved(&mut stored, 7), None, "already applied");
    }
}
