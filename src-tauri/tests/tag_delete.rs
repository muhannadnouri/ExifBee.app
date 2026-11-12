//! Tag and group deletion (S4-T02, FR-009): the arguments ExifBee builds for a staged deletion,
//! written with the real ExifTool to temporary copies, and the dry run that tells the user what a
//! group removal takes away. The app itself does not write until S4-T03/S4-T04.

mod common;

use common::harness::{expect_absent, golden_dir, sha256, Engine, Workspace};
use exifbee_lib::adapter::exiftool::argv::Args;
use exifbee_lib::adapter::exiftool::process::CancelToken;
use exifbee_lib::adapter::exiftool::read::FileMetadata;
use exifbee_lib::adapter::exiftool::removal::preview_group_removal;
use exifbee_lib::domain::edit::{DeleteGroup, DeleteTag};
use exifbee_lib::platform::can_write;
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn tag(group: &str, name: &str) -> DeleteTag {
    DeleteTag {
        group: group.into(),
        name: name.into(),
    }
}

fn group(group: &str) -> DeleteGroup {
    DeleteGroup {
        group: group.into(),
    }
}

/// Stored tags as `group:name` → count, the identity a deletion changes (copy numbers shift when
/// one of two same-name tags goes, so keys are not compared).
fn stored(file: &FileMetadata) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for tag in &file.tags {
        if !["System", "ExifTool", "Composite"].contains(&tag.group1.as_str()) {
            *counts
                .entry(format!("{}:{}", tag.group1, tag.name))
                .or_default() += 1;
        }
    }
    counts
}

/// Tags in `before` that `after` no longer has, as `group:name` (with repeats).
fn removed(before: &FileMetadata, after: &FileMetadata) -> Vec<String> {
    let mut left = stored(after);
    let mut gone = Vec::new();
    for (key, count) in stored(before) {
        let kept = left.remove(&key).unwrap_or(0);
        gone.extend(std::iter::repeat_n(key, count.saturating_sub(kept)));
    }
    gone
}

/// Runs one deletion the way the executor will: ExifTool's default, keeping `<file>_original`.
fn write(engine: &Engine, file: &Path, args: Args) {
    let run = engine.cli(&args.files([file]).unwrap());
    assert_eq!(run.code, Some(0), "{}", run.stderr);
}

// @req FR-009, SEC-005
#[test]
fn a_deleted_tag_is_removed_while_unrelated_tags_and_the_backup_remain() {
    let engine = Engine::new();
    let mut ws = Workspace::new("tag-delete");
    for (fixture, delete) in [
        ("metadata.jpg", tag("IFD0", "Make")),
        ("metadata.pdf", tag("PDF", "Author")),
        ("sidecar.xmp", tag("XMP-dc", "Title")),
    ] {
        let copy = ws.copy(fixture);
        let before = engine.read(&copy);
        write(&engine, &copy, Args::new().delete_tag(&delete).unwrap());
        let after = engine.read(&copy);
        let key = format!("{}:{}", delete.group, delete.name);
        // A PDF keeps the old value inside the file (edits are appended, DEC-029); readers no
        // longer see it.
        expect_absent(&after, &key);
        assert_eq!(removed(&before, &after), [key], "{fixture}: only that tag");
        // ExifTool's default backup is the untouched original.
        let backup = copy.with_file_name(format!("{fixture}_original"));
        assert_eq!(sha256(&backup), sha256(&golden_dir().join(fixture)));
    }
}

// @req FR-009
#[test]
fn group_deletion_only_removes_intended_group() {
    let engine = Engine::new();
    let mut ws = Workspace::new("group-delete");
    let previews = ws.path().join("cache");
    for (fixture, delete) in [
        ("metadata.jpg", group("XMP-dc")),
        ("metadata.jpg", group("IFD0")),
        ("metadata.jpg", group("XMP")),
        ("metadata.jpg", group("All")),
        ("metadata.png", group("PNG")),
        ("metadata.pdf", group("PDF")),
    ] {
        let name = format!("{}-{}", delete.group, fixture);
        let preview_copy = ws.copy_as(fixture, &format!("preview/{name}"));
        let files = ws.files();
        let preview = preview_group_removal(
            &engine.tool,
            &preview_copy,
            &delete,
            &previews,
            &CancelToken::default(),
        )
        .unwrap();
        // The preview only read the file and cleaned up after itself.
        ws.expect_unchanged(&preview_copy);
        ws.expect_no_new_outputs(&files);

        let copy = ws.copy_as(fixture, &format!("write/{name}"));
        let before = engine.read(&copy);
        write(&engine, &copy, Args::new().delete_group(&delete).unwrap());
        let mut actual = removed(&before, &engine.read(&copy));
        let mut predicted: Vec<String> = preview
            .removed
            .iter()
            .map(|tag| format!("{}:{}", tag.group1, tag.name))
            .collect();
        actual.sort();
        predicted.sort();
        assert!(!actual.is_empty(), "{name}: nothing removed");
        assert_eq!(predicted, actual, "{name}: the preview is the real scope");
    }
}

// @req FR-009, UX-006
#[test]
fn the_preview_reports_nested_and_partial_groups() {
    let engine = Engine::new();
    let mut ws = Workspace::new("group-delete-scope");
    let cache = ws.path().join("cache");
    let preview = |file: &Path, name: &str| {
        let result = preview_group_removal(
            &engine.tool,
            file,
            &group(name),
            &cache,
            &CancelToken::default(),
        )
        .unwrap();
        let keys: Vec<String> = result.removed.iter().map(|tag| tag.key.clone()).collect();
        (keys, result.messages)
    };

    // IFD0 holds ExifIFD: removing it takes DateTimeOriginal too, and the XMP Make stays.
    let jpg = ws.copy("metadata.jpg");
    let (keys, _) = preview(&jpg, "IFD0");
    assert!(keys.contains(&"IFD0:Make".to_string()), "{keys:?}");
    assert!(
        keys.contains(&"ExifIFD:DateTimeOriginal".to_string()),
        "{keys:?}"
    );
    assert!(!keys.iter().any(|key| key.starts_with("XMP")), "{keys:?}");

    // PNG keeps its image-structure tags: only the text chunks go.
    let png = ws.copy("metadata.png");
    let (keys, _) = preview(&png, "PNG");
    assert!(
        !keys.is_empty() && !keys.contains(&"PNG:ImageWidth".to_string()),
        "{keys:?}"
    );

    // A format ExifTool cannot write: nothing would be removed, and ExifTool says why.
    let zip = ws.copy("archive.zip");
    let (keys, messages) = preview(&zip, "All");
    assert!(keys.is_empty(), "{keys:?}");
    assert!(
        messages.iter().any(|line| line.contains("ZIP")),
        "{messages:?}"
    );
}

// @req FR-009, SEC-002
#[test]
fn deletions_that_cannot_be_expressed_safely_never_become_arguments() {
    assert_eq!(
        Args::new()
            .delete_tag(&tag("IFD0", "Make"))
            .unwrap()
            .as_slice(),
        ["-IFD0:Make="]
    );
    assert_eq!(
        Args::new()
            .delete_group(&group("XMP-dc"))
            .unwrap()
            .as_slice(),
        ["-XMP-dc:All="]
    );
    assert_eq!(
        Args::new().delete_group(&group("All")).unwrap().as_slice(),
        ["-all="]
    );
    for refused in [
        tag("IFD0", "Make<FileName"),
        tag("System", "FileName"),
        tag("", "Make"),
    ] {
        assert!(refused.problem().is_some() && Args::new().delete_tag(&refused).is_err());
    }
    for refused in [
        "System",
        "Composite",
        "ExifTool",
        "Other",
        "XMP:dc",
        "-all",
        "",
    ] {
        let refused = group(refused);
        assert!(refused.problem().is_some() && Args::new().delete_group(&refused).is_err());
    }
    assert!(Args::new().output(Path::new("relative.jpg")).is_err());
}

// @req FR-009, SEC-005
#[test]
fn a_read_only_file_or_folder_is_refused_before_exiftool_would_write_it() {
    let engine = Engine::new();
    let mut ws = Workspace::new("delete-read-only");
    let writable = ws.copy("metadata.jpg");
    assert!(can_write(&writable));

    // ExifTool replaces a 0444 file in a writable folder without complaint, so ExifBee must
    // refuse it itself.
    let locked = ws.copy_as("metadata.jpg", "locked.jpg");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o444)).unwrap();
    assert!(!can_write(&locked));
    write(
        &engine,
        &locked,
        Args::new().delete_tag(&tag("IFD0", "Make")).unwrap(),
    );
    expect_absent(&engine.read(&locked), "IFD0:Make");

    // In a read-only folder ExifTool fails and the file is unchanged.
    let inside = ws.copy_as("metadata.jpg", "sealed/inside.jpg");
    let folder = inside.parent().unwrap();
    fs::set_permissions(folder, fs::Permissions::from_mode(0o555)).unwrap();
    assert!(!can_write(&inside));
    let run = engine.cli(
        &Args::new()
            .delete_tag(&tag("IFD0", "Make"))
            .unwrap()
            .files([&inside])
            .unwrap(),
    );
    assert_eq!(run.code, Some(1), "{}", run.stderr);
    ws.expect_unchanged(&inside);
    fs::set_permissions(folder, fs::Permissions::from_mode(0o755)).unwrap();
}
