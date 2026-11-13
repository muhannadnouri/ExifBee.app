//! The plan builder (S4-T03, FR-010, SEC-004, SEC-006) and executor (S4-T04, FR-011, FR-014,
//! SEC-005) with the real ExifTool: a ready plan's arguments produce exactly the planned result,
//! building a plan writes nothing, files that changed, moved, cannot be written or would be
//! written unsafely are skipped with reasons, and applying keeps backups unless told not to.

mod common;

use common::harness::{expect_absent, golden_dir, sha256, value, Engine, Workspace};
use exifbee_lib::adapter::exiftool::argv::Args;
use exifbee_lib::adapter::exiftool::process::CancelToken;
use exifbee_lib::domain::edit::{
    Change, CopySelection, CopyTags, DeleteGroup, DeleteTag, EditValue, SetTag, TagName,
};
use exifbee_lib::service::apply::{apply_plan, BackupPolicy, Outcome};
use exifbee_lib::service::capabilities::{CapabilityCache, CapabilitySnapshot};
use exifbee_lib::service::files::FileIdentity;
use exifbee_lib::service::plan::{build_plan, write_args, FilePlan, PlanInput, PlanPreview};
use serde_json::json;
use std::collections::HashMap;
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
            &HashMap::new(),
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

    // Never opened in this session (a copy destination): planned against the file as it is
    // now, which the review shows; a file gone since is skipped.
    let plan = planner.plan(&first, None, change());
    assert!(plan.ready(), "{}", problems(&plan));
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
    preview_with(planner, files, &[])
}

/// Like [`preview`]; every planned file is also a copy source under its ID (`f0`, `f1`, …),
/// and `extra` adds sources that are not planned.
fn preview_with(
    planner: &Planner,
    files: Vec<(&Path, Vec<Change>)>,
    extra: &[(&str, &Path)],
) -> PlanPreview {
    let mut sources: HashMap<String, PathBuf> = files
        .iter()
        .enumerate()
        .map(|(index, (path, _))| (format!("f{index}"), path.to_path_buf()))
        .collect();
    for (id, path) in extra {
        sources.insert(id.to_string(), path.to_path_buf());
    }
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
        &sources,
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
    let default = write_args(&changes, &photo, false, &HashMap::new()).unwrap();
    assert!(default
        .as_slice()
        .iter()
        .all(|arg| arg != "-overwrite_original"));
    let explicit = write_args(&changes, &photo, true, &HashMap::new()).unwrap();
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

// @req FR-017, FR-011, FR-008, FR-009
#[test]
fn writes_are_verified_by_reading_back_on_several_formats() {
    let planner = Planner::new();
    let mut ws = Workspace::new("verify-formats");
    let jpg = ws.copy("metadata.jpg");
    let pdf = ws.copy("metadata.pdf");
    let png = ws.copy("metadata.png");
    let xmp = ws.copy("sidecar.xmp");
    let list = Change::Set(SetTag {
        group: "XMP-iptcExt".into(),
        name: "PersonInImage".into(),
        value: EditValue::List {
            items: vec!["Ann".into(), "Bo, Jr.".into()],
        },
    });
    let plan = preview(
        &planner,
        vec![
            (
                &jpg,
                vec![
                    set("IFD0", "Make", "Nikon"),
                    delete_tag("IFD0", "Artist"),
                    // Removed, then set again: the new Title must be there, the rest gone.
                    delete_group("XMP-dc"),
                    set("XMP-dc", "Title", "Kept"),
                    list,
                ],
            ),
            (&pdf, vec![set("PDF", "Author", "Someone")]),
            (&png, vec![set("PNG", "Title", "PNG ✓")]),
            (&xmp, vec![delete_tag("XMP-dc", "Title")]),
        ],
    );
    let result = apply_plan(&planner.engine.tool, &plan, BackupPolicy::KeepBackups);
    for file in &result.files {
        assert_eq!(file.outcome, Outcome::Changed, "{file:#?}");
        assert!(file.details.is_empty(), "{file:#?}");
        assert_eq!(file.exit_code, Some(0));
    }
}

// @req FR-017
#[test]
fn values_exiftool_stores_in_another_form_verify_with_a_note() {
    let planner = Planner::new();
    let mut ws = Workspace::new("verify-normalized");
    let photo = ws.copy("metadata.jpg");
    let plan = preview(
        &planner,
        vec![(
            &photo,
            vec![
                set("ExifIFD", "ExposureTime", "0.005"),
                set("ExifIFD", "FNumber", "5"),
                set("ExifIFD", "DateTimeOriginal", "2026:1:2 3:4:5"),
                set("IFD0", "Make", " Spaced "),
            ],
        )],
    );
    let result = apply_plan(&planner.engine.tool, &plan, BackupPolicy::KeepBackups);
    let file = &result.files[0];
    assert_eq!(file.outcome, Outcome::Changed, "{file:#?}");
    for note in [
        "ExifIFD:ExposureTime: stored as 1/200",
        "ExifIFD:FNumber: stored as 5.0",
        "ExifIFD:DateTimeOriginal: stored as 2026:01:02 03:04:05",
        "IFD0:Make: stored as  Spaced",
    ] {
        assert!(
            file.details.iter().any(|d| d == note),
            "missing {note:?}: {file:#?}"
        );
    }
}

// @req FR-017, FR-014
#[test]
fn a_write_exiftool_calls_successful_but_that_skipped_a_value_is_a_mismatch() {
    let planner = Planner::new();
    let mut ws = Workspace::new("verify-mismatch");
    let photo = ws.copy("metadata.jpg");
    // ExifTool cannot convert "6" for Orientation: it warns, writes Make, and exits 0.
    let plan = preview(
        &planner,
        vec![(
            &photo,
            vec![
                set("IFD0", "Make", "Nikon"),
                set("IFD0", "Orientation", "6"),
            ],
        )],
    );
    assert!(plan.files[0].ready(), "{}", problems(&plan.files[0]));
    let result = apply_plan(&planner.engine.tool, &plan, BackupPolicy::KeepBackups);
    let file = &result.files[0];
    assert_eq!(file.outcome, Outcome::Mismatch, "{file:#?}");
    assert_eq!(file.exit_code, Some(0));
    assert_eq!(
        file.details,
        ["IFD0:Orientation: planned 6, not in the file"]
    );
    assert!(file
        .warnings
        .iter()
        .any(|w| w.contains("Can't convert IFD0:Orientation")));
    // The file did change, so its backup is reported and restorable.
    let backup = PathBuf::from(file.backup.as_deref().unwrap());
    assert_eq!(sha256(&backup), sha256(&golden_dir().join("metadata.jpg")));
    assert_eq!(
        value(&planner.engine.read(&photo), "IFD0:Make"),
        json!("Nikon")
    );
}

// @req FR-017
#[test]
fn a_tag_the_plan_did_not_touch_that_changed_is_a_mismatch() {
    let planner = Planner::new();
    let mut ws = Workspace::new("verify-untouched");
    let photo = ws.copy("metadata.jpg");
    let mut plan = preview(&planner, vec![(&photo, vec![set("IFD0", "Make", "Nikon")])]);
    // Stand in for an unexpected side effect: the planning read remembers another Artist.
    let artist = plan.files[0]
        .before
        .iter_mut()
        .find(|tag| tag.key == "IFD0:Artist")
        .unwrap();
    artist.value = exifbee_lib::domain::metadata::MetadataValue::Text {
        text: "Someone else".into(),
    };
    let result = apply_plan(&planner.engine.tool, &plan, BackupPolicy::KeepBackups);
    let file = &result.files[0];
    assert_eq!(file.outcome, Outcome::Mismatch, "{file:#?}");
    assert_eq!(
        file.details,
        ["IFD0:Artist: changed unexpectedly, was Someone else, now ExifBee Fixtures"]
    );
}

fn copy(source: &str, what: CopySelection) -> Change {
    Change::CopyTags(CopyTags {
        source: source.into(),
        what,
    })
}

// @req FR-013, FR-014, FR-017
#[test]
fn copy_metadata_between_compatible_files() {
    let planner = Planner::new();
    let mut ws = Workspace::new("copy-formats");
    let source = ws.copy_as("metadata.jpg", "source.jpg");
    let png = ws.copy("metadata.png");
    let pdf = ws.copy("metadata.pdf");
    let plan = preview_with(
        &planner,
        vec![
            (&png, vec![copy("src", CopySelection::All)]),
            (&pdf, vec![copy("src", CopySelection::All)]),
        ],
        &[("src", &source)],
    );
    let [to_png, to_pdf] = &plan.files[..] else {
        panic!()
    };
    assert!(
        to_png.ready() && to_pdf.ready(),
        "{} {}",
        problems(to_png),
        problems(to_pdf)
    );
    assert_eq!(
        to_png.changes[0].target,
        "Copy from source.jpg: all metadata"
    );
    let copies = |plan: &FilePlan| -> Vec<String> {
        plan.changes[0]
            .copies
            .iter()
            .map(|tag| format!("{}={}", tag.key, tag.value))
            .collect()
    };
    assert!(
        copies(to_png).contains(&"IFD0:Make=ExifBee EXIF Make".to_string()),
        "{:?}",
        copies(to_png)
    );
    // JFIF belongs to JPEG: a PNG cannot hold it, and only that is reported.
    let png_dropped = &to_png.changes[0].cannot_copy;
    assert!(
        !png_dropped.is_empty() && png_dropped.iter().all(|key| key.starts_with("JFIF:")),
        "{png_dropped:?}"
    );
    // A PDF cannot hold EXIF: ExifTool drops it silently, the plan says so.
    assert!(
        !copies(to_pdf).iter().any(|tag| tag.starts_with("IFD0:")),
        "{:?}",
        copies(to_pdf)
    );
    assert!(to_pdf.changes[0]
        .cannot_copy
        .contains(&"IFD0:Make".to_string()));
    assert!(
        copies(to_pdf).iter().any(|tag| tag.starts_with("XMP-dc:")),
        "{:?}",
        copies(to_pdf)
    );

    let result = apply_plan(&planner.engine.tool, &plan, BackupPolicy::KeepBackups);
    for (file, fixture) in result.files.iter().zip(["metadata.png", "metadata.pdf"]) {
        assert_eq!(file.outcome, Outcome::Changed, "{file:#?}");
        let backup = PathBuf::from(file.backup.as_deref().unwrap());
        assert_eq!(sha256(&backup), sha256(&golden_dir().join(fixture)));
    }
    assert_eq!(
        value(&planner.engine.read(&png), "IFD0:Make"),
        json!("ExifBee EXIF Make")
    );
    expect_absent(&planner.engine.read(&pdf), "IFD0:Make");
    ws.expect_unchanged(&source);
}

// @req FR-013
#[test]
fn a_group_or_exact_tags_copy_only_what_was_chosen() {
    let planner = Planner::new();
    let mut ws = Workspace::new("copy-selection");
    let source = ws.copy_as("metadata.jpg", "source.jpg");
    let group = ws.copy_as("no-metadata.jpg", "group.jpg");
    let tags = ws.copy_as("no-metadata.jpg", "tags.jpg");
    let make = TagName {
        group: "IFD0".into(),
        name: "Make".into(),
    };
    let plan = preview_with(
        &planner,
        vec![
            (
                &group,
                vec![copy(
                    "src",
                    CopySelection::Group {
                        group: "XMP-dc".into(),
                    },
                )],
            ),
            (
                &tags,
                vec![copy(
                    "src",
                    CopySelection::Tags {
                        tags: vec![make.clone(), make],
                    },
                )],
            ),
        ],
        &[("src", &source)],
    );
    let keys = |index: usize| -> Vec<String> {
        plan.files[index].changes[0]
            .copies
            .iter()
            .map(|tag| tag.key.clone())
            .collect()
    };
    assert!(
        keys(0).iter().all(|key| key.starts_with("XMP-dc:")),
        "{:?}",
        keys(0)
    );
    assert!(keys(1).contains(&"IFD0:Make".to_string()), "{:?}", keys(1));
    assert!(
        !keys(1).iter().any(|key| key.starts_with("XMP")),
        "{:?}",
        keys(1)
    );
    // The same tag named twice becomes one selector.
    let args: Vec<String> = plan.files[1]
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
            "-TagsFromFile",
            &source.display().to_string(),
            "-IFD0:Make",
            "--",
            &tags.display().to_string()
        ]
    );
    let result = apply_plan(&planner.engine.tool, &plan, BackupPolicy::KeepBackups);
    assert!(
        result
            .files
            .iter()
            .all(|file| file.outcome == Outcome::Changed),
        "{result:#?}"
    );
    expect_absent(&planner.engine.read(&group), "IFD0:Make");
}

// @req FR-013, SEC-006
#[test]
fn copies_onto_themselves_unwritable_or_empty_or_from_a_changed_source_are_refused() {
    let planner = Planner::new();
    let mut ws = Workspace::new("copy-refused");
    let source = ws.copy_as("metadata.jpg", "source.jpg");
    let link = ws.path().join("link.jpg");
    symlink(&source, &link).unwrap();
    let zip = ws.copy("archive.zip");
    let target = ws.copy_as("no-metadata.jpg", "target.jpg");
    let plan = preview_with(
        &planner,
        vec![
            (&source, vec![copy("src", CopySelection::All)]),
            // The same real file through a link.
            (&link, vec![copy("src", CopySelection::All)]),
            (&zip, vec![copy("src", CopySelection::All)]),
            (
                &target,
                vec![copy(
                    "src",
                    CopySelection::Group {
                        group: "IPTC".into(),
                    },
                )],
            ),
            (&target, vec![copy("nobody", CopySelection::All)]),
        ],
        &[("src", &source)],
    );
    let reasons: Vec<String> = plan.files.iter().map(problems).collect();
    assert!(
        reasons[0].contains("cannot be copied onto itself"),
        "{}",
        reasons[0]
    );
    assert!(
        reasons[1].contains("cannot be copied onto itself"),
        "{}",
        reasons[1]
    );
    assert!(reasons[2].contains("not writable"), "{}", reasons[2]);
    assert!(reasons[3].contains("nothing to copy"), "{}", reasons[3]);
    assert!(
        reasons[4].contains("not a file added in this session"),
        "{}",
        reasons[4]
    );
    for refused in [
        CopySelection::Group {
            group: "System".into(),
        },
        CopySelection::Tags { tags: vec![] },
        CopySelection::Tags {
            tags: vec![TagName {
                group: "IFD0".into(),
                name: "Make<FileName".into(),
            }],
        },
    ] {
        let change = CopyTags {
            source: "src".into(),
            what: refused,
        };
        assert!(change.problem().is_some() && Args::new().copy_from(&source, &change).is_err());
    }
    assert!(Args::new()
        .copy_from(
            Path::new("relative.jpg"),
            &CopyTags {
                source: "src".into(),
                what: CopySelection::All
            }
        )
        .is_err());

    // A source changed between review and apply: the destination is left as it is.
    let fresh = ws.copy_as("no-metadata.jpg", "fresh.jpg");
    let plan = preview_with(
        &planner,
        vec![(&fresh, vec![copy("src", CopySelection::All)])],
        &[("src", &source)],
    );
    assert!(plan.files[0].ready(), "{}", problems(&plan.files[0]));
    fs::write(
        &source,
        fs::read(golden_dir().join("metadata.png")).unwrap(),
    )
    .unwrap();
    let result = apply_plan(&planner.engine.tool, &plan, BackupPolicy::KeepBackups);
    assert_eq!(result.files[0].outcome, Outcome::Skipped, "{result:#?}");
    assert!(result.files[0]
        .message
        .as_deref()
        .unwrap()
        .contains("copies from changed"));
    ws.expect_unchanged(&fresh);
    ws.expect_unchanged(&zip);
}
