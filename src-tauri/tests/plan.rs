//! The plan builder (S4-T03, FR-010, SEC-004, SEC-006) and executor (S4-T04, FR-011, FR-014,
//! SEC-005) with the real ExifTool: a ready plan's arguments produce exactly the planned result,
//! building a plan writes nothing, files that changed, moved, cannot be written or would be
//! written unsafely are skipped with reasons, and applying keeps backups unless told not to.

mod common;

use common::harness::{expect_absent, golden_dir, sha256, value, Engine, Workspace};
use exifbee_lib::adapter::exiftool::process::CancelToken;
use exifbee_lib::domain::edit::{Change, DeleteGroup, DeleteTag, EditValue, SetTag};
use exifbee_lib::service::apply::{apply_plan, BackupPolicy, Outcome};
use exifbee_lib::service::capabilities::{CapabilityCache, CapabilitySnapshot};
use exifbee_lib::service::files::FileIdentity;
use exifbee_lib::service::plan::{build_plan, write_args, FilePlan, PlanInput, PlanPreview};
use serde_json::json;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn set(group: &str, name: &str, text: &str) -> Change {
    Change::Set(SetTag {
        group: group.into(),
        name: name.into(),
        value: EditValue::Text { text: text.into() },
    })
}

fn delete_tag(group: &str, name: &str) -> Change {
    Change::DeleteTag(DeleteTag {
        group: group.into(),
        name: name.into(),
    })
}

fn delete_group(group: &str) -> Change {
    Change::DeleteGroup(DeleteGroup {
        group: group.into(),
    })
}

struct Planner {
    engine: Engine,
    snapshot: Arc<CapabilitySnapshot>,
    /// Outside the workspace, so the workspace's "no new files" check sees only the user's side.
    cache: Workspace,
}

impl Planner {
    fn new() -> Self {
        let engine = Engine::new();
        let cache = Workspace::new("plan-cache");
        let snapshot = CapabilityCache::new(cache.path())
            .snapshot(&engine.tool, &CancelToken::default())
            .unwrap();
        Self {
            engine,
            snapshot,
            cache,
        }
    }

    /// Plans `changes` for `chosen`, recorded as `recorded` when the user inspected it.
    fn plan(
        &self,
        chosen: &Path,
        recorded: Option<FileIdentity>,
        changes: Vec<Change>,
    ) -> FilePlan {
        let input = PlanInput {
            id: "f1".into(),
            chosen: chosen.to_path_buf(),
            recorded,
            changes,
        };
        let mut preview = build_plan(
            &self.engine.tool,
            Some(&self.snapshot),
            vec![input],
            self.cache.path(),
            &CancelToken::default(),
        )
        .unwrap();
        preview.files.remove(0)
    }

    /// Records the file as inspected now, then plans.
    fn plan_now(&self, chosen: &Path, changes: Vec<Change>) -> FilePlan {
        self.plan(chosen, Some(FileIdentity::of(chosen).unwrap()), changes)
    }
}

fn problems(plan: &FilePlan) -> String {
    plan.problems.join(" | ")
}

// @req FR-010, SEC-004, FR-014
#[test]
fn a_ready_plan_runs_to_exactly_the_planned_result() {
    let planner = Planner::new();
    let mut ws = Workspace::new("plan-ready");
    let photo = ws.copy("metadata.jpg");
    let files = ws.files();
    let plan = planner.plan_now(
        &photo,
        vec![
            set("IFD0", "Make", "Nikon"),
            // Staged after the removal of its group, but must survive it.
            set("XMP-dc", "Title", "New title"),
            delete_tag("IFD0", "Artist"),
            delete_group("XMP-dc"),
            set("XMP-dc", "Creator", "Ann"),
        ],
    );
    assert!(plan.ready(), "{}", problems(&plan));

    // Building the plan wrote nothing: no file changed and none appeared.
    ws.expect_unchanged(&photo);
    ws.expect_no_new_outputs(&files);

    // The readable diff comes from the file as it is.
    let make = plan
        .changes
        .iter()
        .find(|c| c.target == "IFD0:Make")
        .unwrap();
    assert_eq!(make.before.as_deref(), Some("ExifBee EXIF Make"));
    assert_eq!(make.after.as_deref(), Some("Nikon"));
    let artist = plan
        .changes
        .iter()
        .find(|c| c.target == "IFD0:Artist")
        .unwrap();
    assert_eq!(
        (artist.before.as_deref(), artist.after.as_deref()),
        (Some("ExifBee Fixtures"), None)
    );
    let group = plan
        .changes
        .iter()
        .find(|c| c.target == "XMP-dc group")
        .unwrap();
    assert!(
        group.removes.contains(&"XMP-dc:Subject".to_string()),
        "{group:?}"
    );
    assert_eq!(
        plan.backup.as_deref(),
        Some(format!("{}_original", photo.display()).as_str())
    );

    // Removals first, then deleted tags, then values; options end before the real path.
    let args: Vec<String> = plan
        .args
        .as_ref()
        .unwrap()
        .as_slice()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        args,
        [
            "-XMP-dc:All=",
            "-IFD0:Artist=",
            "-IFD0:Make=Nikon",
            "-XMP-dc:Title=New title",
            "-XMP-dc:Creator=Ann",
            "--",
            &photo.display().to_string(),
        ]
    );
    let command = plan.command.as_ref().unwrap();
    // The runnable form of the same arguments (quoting proven by S2-T02's shell tests).
    assert!(command.exact);
    assert_eq!(
        command.text,
        format!(
            "{} -XMP-dc:All= -IFD0:Artist= -IFD0:Make=Nikon '-XMP-dc:Title=New title' \
             -XMP-dc:Creator=Ann -- '{}'",
            planner.engine.tool.path.display(),
            photo.display()
        )
    );

    // Running exactly those arguments gives the planned result and ExifTool's backup.
    let run = planner.engine.cli(plan.args.as_ref().unwrap());
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    let read = planner.engine.read(&photo);
    assert_eq!(value(&read, "IFD0:Make"), json!("Nikon"));
    assert_eq!(value(&read, "XMP-dc:Title"), json!("New title"));
    assert_eq!(value(&read, "XMP-dc:Creator"), json!(["Ann"]));
    expect_absent(&read, "IFD0:Artist");
    expect_absent(&read, "XMP-dc:Subject");
    let backup = PathBuf::from(plan.backup.unwrap());
    assert_eq!(sha256(&backup), sha256(&golden_dir().join("metadata.jpg")));
}

// @req SEC-006, FR-010
#[test]
fn a_file_that_changed_or_moved_after_it_was_read_is_skipped() {
    let planner = Planner::new();
    let mut ws = Workspace::new("plan-stale");
    let change = || vec![set("IFD0", "Make", "Nikon")];

    // Changed after inspection: same path, different content and time.
    let photo = ws.copy("metadata.jpg");
    let recorded = FileIdentity::of(&photo).unwrap();
    fs::write(
        &photo,
        fs::read(golden_dir().join("no-metadata.jpg")).unwrap(),
    )
    .unwrap();
    let plan = planner.plan(&photo, Some(recorded), change());
    assert!(
        problems(&plan).contains("changed after it was read"),
        "{}",
        problems(&plan)
    );
    assert!(plan.args.is_none() && plan.backup.is_none());

    // A link pointed at another file after inspection.
    let first = ws.copy_as("metadata.jpg", "first.jpg");
    let second = ws.copy_as("metadata.jpg", "second.jpg");
    let link = ws.path().join("link.jpg");
    symlink(&first, &link).unwrap();
    let recorded = FileIdentity::of(&link).unwrap();
    fs::remove_file(&link).unwrap();
    symlink(&second, &link).unwrap();
    let plan = planner.plan(&link, Some(recorded), change());
    assert!(
        problems(&plan).contains("leads to a different file"),
        "{}",
        problems(&plan)
    );

    // Never inspected in this session, or gone since.
    let plan = planner.plan(&first, None, change());
    assert!(
        problems(&plan).contains("not inspected"),
        "{}",
        problems(&plan)
    );
    let gone = ws.copy_as("metadata.jpg", "gone.jpg");
    let recorded = FileIdentity::of(&gone).unwrap();
    fs::remove_file(&gone).unwrap();
    let plan = planner.plan(&gone, Some(recorded), change());
    assert!(problems(&plan).contains("missing"), "{}", problems(&plan));
    ws.expect_unchanged(&first);
    ws.expect_unchanged(&second);
}

// @req SEC-006, SEC-005, FR-014
#[test]
fn links_backups_permissions_and_leftovers_are_planned_safely() {
    let planner = Planner::new();
    let mut ws = Workspace::new("plan-safety");
    let change = || vec![set("IFD0", "Make", "Nikon")];

    // A link: the real file is the target, never the link (ExifTool would replace the link).
    let real = ws.copy("metadata.jpg");
    let link = ws.path().join("link.jpg");
    symlink(&real, &link).unwrap();
    let plan = planner.plan_now(&link, change());
    assert!(plan.ready(), "{}", problems(&plan));
    assert_eq!(plan.target, real.display().to_string());
    assert_eq!(plan.link, Some(link.display().to_string()));
    let last = plan
        .args
        .as_ref()
        .unwrap()
        .as_slice()
        .last()
        .unwrap()
        .clone();
    assert_eq!(PathBuf::from(last), real);

    // An earlier backup is kept by ExifTool, so this version would have none: say so.
    let edited = ws.copy_as("metadata.jpg", "edited.jpg");
    fs::write(ws.path().join("edited.jpg_original"), b"older").unwrap();
    let plan = planner.plan_now(&edited, change());
    assert!(plan.ready() && plan.backup.is_none());
    assert!(plan
        .warnings
        .iter()
        .any(|w| w.contains("does not back up the current version")));

    // A leftover temporary file would make ExifTool fail.
    let stuck = ws.copy_as("metadata.jpg", "stuck.jpg");
    fs::write(ws.path().join("stuck.jpg_exiftool_tmp"), b"").unwrap();
    let plan = planner.plan_now(&stuck, change());
    assert!(
        problems(&plan).contains("temporary file"),
        "{}",
        problems(&plan)
    );

    // ExifTool would replace a 0444 file; the plan refuses it.
    let locked = ws.copy_as("metadata.jpg", "locked.jpg");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o444)).unwrap();
    let plan = planner.plan_now(&locked, change());
    assert!(
        problems(&plan).contains("permission"),
        "{}",
        problems(&plan)
    );
    for file in [&real, &edited, &stuck, &locked] {
        ws.expect_unchanged(file);
    }
}

// @req FR-010, FR-008, FR-009, UX-006
#[test]
fn changes_that_no_longer_fit_the_file_skip_it_with_every_reason() {
    let planner = Planner::new();
    let mut ws = Workspace::new("plan-invalid");
    let photo = ws.copy("metadata.jpg");
    let plan = planner.plan_now(
        &photo,
        vec![
            set("IFD0", "Make", "Nikon"),
            delete_tag("IFD0", "NotThere"),
            set("Composite", "ImageSize", "1x1"),
            set("System", "FileName", "renamed.jpg"),
            delete_group("Composite"),
            set("IFD0", "Make", "Again"),
        ],
    );
    let text = problems(&plan);
    assert!(!plan.ready() && plan.args.is_none(), "{text}");
    for reason in [
        "IFD0:NotThere: the tag is no longer in the file",
        "Composite:ImageSize: This tag or file format is not writable",
        "System:FileName: File system properties",
        "Composite group: Composite is not stored in the file",
        "IFD0:Make is staged more than once",
    ] {
        assert!(text.contains(reason), "missing {reason:?} in {text}");
    }

    // A format ExifTool cannot write.
    let zip = ws.copy("archive.zip");
    let plan = planner.plan_now(&zip, vec![set("XMP-dc", "Title", "x")]);
    assert!(
        problems(&plan).contains("not writable"),
        "{}",
        problems(&plan)
    );
    ws.expect_unchanged(&photo);
    ws.expect_unchanged(&zip);
}

/// One stored plan of one or more files, as `plan_changes` would keep it.
fn preview(planner: &Planner, files: Vec<(&Path, Vec<Change>)>) -> PlanPreview {
    let inputs = files
        .into_iter()
        .enumerate()
        .map(|(index, (path, changes))| PlanInput {
            id: format!("f{index}"),
            chosen: path.to_path_buf(),
            recorded: Some(FileIdentity::of(path).unwrap()),
            changes,
        })
        .collect();
    build_plan(
        &planner.engine.tool,
        Some(&planner.snapshot),
        inputs,
        planner.cache.path(),
        &CancelToken::default(),
    )
    .unwrap()
}

// @req FR-011, FR-014, SEC-005
#[test]
fn jpg_set_and_read_back_rights_with_original_backup() {
    let planner = Planner::new();
    let mut ws = Workspace::new("apply-default");
    let photo = ws.copy("metadata.jpg");
    let plan = preview(
        &planner,
        vec![(
            &photo,
            vec![
                set("XMP-dc", "Rights", "Example rights"),
                delete_tag("IFD0", "Artist"),
            ],
        )],
    );
    let result = apply_plan(&planner.engine.tool, &plan, BackupPolicy::KeepBackups);
    let outcome = &result.files[0];
    assert_eq!(outcome.outcome, Outcome::Changed, "{:?}", outcome.message);
    let backup = format!("{}_original", photo.display());
    assert_eq!(outcome.backup.as_deref(), Some(backup.as_str()));
    // The backup is the original, byte for byte; the file holds the planned values.
    assert_eq!(
        sha256(Path::new(&backup)),
        sha256(&golden_dir().join("metadata.jpg"))
    );
    let read = planner.engine.read(&photo);
    assert_eq!(value(&read, "XMP-dc:Rights"), json!("Example rights"));
    expect_absent(&read, "IFD0:Artist");
}

// @req SEC-005, FR-014
#[test]
fn originals_are_overwritten_only_by_the_explicit_policy() {
    let planner = Planner::new();
    let mut ws = Workspace::new("apply-overwrite");
    let photo = ws.copy("metadata.jpg");
    // A value spelled like the option stays a value: the default arguments never overwrite.
    let changes = vec![set("IFD0", "Software", "-overwrite_original")];
    let default = write_args(&changes, &photo, false).unwrap();
    assert!(default
        .as_slice()
        .iter()
        .all(|arg| arg != "-overwrite_original"));
    let explicit = write_args(&changes, &photo, true).unwrap();
    assert_eq!(explicit.as_slice()[0], "-overwrite_original");

    let plan = preview(&planner, vec![(&photo, changes)]);
    let result = apply_plan(
        &planner.engine.tool,
        &plan,
        BackupPolicy::OverwriteOriginals,
    );
    let outcome = &result.files[0];
    assert_eq!(outcome.outcome, Outcome::Changed, "{:?}", outcome.message);
    assert_eq!(outcome.backup, None);
    assert!(!ws.path().join("metadata.jpg_original").exists());
    assert_eq!(
        value(&planner.engine.read(&photo), "IFD0:Software"),
        json!("-overwrite_original")
    );
}

// @req SEC-006, FR-011, FR-017
#[test]
fn files_changed_after_review_or_refused_are_left_as_they_are() {
    let planner = Planner::new();
    let mut ws = Workspace::new("apply-mixed");
    let good = ws.copy_as("metadata.jpg", "good.jpg");
    let changed = ws.copy_as("metadata.jpg", "changed.jpg");
    let refused = ws.copy_as("metadata.jpg", "refused.jpg");
    let zip = ws.copy("archive.zip");
    let plan = preview(
        &planner,
        vec![
            (&good, vec![set("IFD0", "Make", "Nikon")]),
            (&changed, vec![set("IFD0", "Make", "Nikon")]),
            // ExifTool rejects a value it cannot convert when writing.
            (
                &refused,
                vec![set("ExifIFD", "ExposureTime", "not a number")],
            ),
            (&zip, vec![set("XMP-dc", "Title", "x")]),
        ],
    );
    // Changed by something else between review and apply.
    let other = fs::read(golden_dir().join("no-metadata.jpg")).unwrap();
    fs::write(&changed, &other).unwrap();

    let result = apply_plan(&planner.engine.tool, &plan, BackupPolicy::KeepBackups);
    let outcomes: Vec<Outcome> = result.files.iter().map(|file| file.outcome).collect();
    assert_eq!(
        outcomes,
        [
            Outcome::Changed,
            Outcome::Skipped,
            Outcome::Failed,
            Outcome::Skipped
        ],
        "{result:#?}"
    );
    assert!(result.files[1]
        .message
        .as_deref()
        .unwrap()
        .contains("changed after the changes were reviewed"));
    assert!(result.files[3]
        .message
        .as_deref()
        .unwrap()
        .contains("not writable"));
    // Only the good file changed; the others are exactly as they were, with no backups.
    assert_eq!(fs::read(&changed).unwrap(), other);
    ws.expect_unchanged(&refused);
    ws.expect_unchanged(&zip);
    for name in [
        "changed.jpg_original",
        "refused.jpg_original",
        "archive.zip_original",
    ] {
        assert!(!ws.path().join(name).exists(), "{name}");
    }
    assert_eq!(
        value(&planner.engine.read(&good), "IFD0:Make"),
        json!("Nikon")
    );
}
