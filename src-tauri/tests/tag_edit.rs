//! Tag edits (S4-T01, FR-008): the arguments ExifBee builds for a staged `set-tag`, written with
//! the real ExifTool to temporary copies and read back. The app itself does not write until the
//! plan and executor (S4-T03, S4-T04); these tests prove what those will send.

mod common;

use common::harness::{value, Engine, Workspace};
use exifbee_lib::adapter::exiftool::argv::Args;
use exifbee_lib::adapter::exiftool::read::raw_is_utf8;
use exifbee_lib::domain::edit::{EditValue, SetTag};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn text(group: &str, name: &str, text: &str) -> SetTag {
    SetTag {
        group: group.into(),
        name: name.into(),
        value: EditValue::Text { text: text.into() },
    }
}

fn list(group: &str, name: &str, items: &[&str]) -> SetTag {
    SetTag {
        group: group.into(),
        name: name.into(),
        value: EditValue::List {
            items: items.iter().map(|item| item.to_string()).collect(),
        },
    }
}

/// Writes `edits` to `file` in one ExifTool run, overwriting the temporary copy in place.
fn write(engine: &Engine, file: &Path, edits: &[SetTag]) {
    let mut args = Args::new().options(&["-overwrite_original"]);
    for edit in edits {
        args = args.set(edit).unwrap();
    }
    let run = engine.cli(&args.files([file]).unwrap());
    assert_eq!(run.code, Some(0), "{}", run.stderr);
}

/// (fixture, edits written together, expected `(key, value)` after reading back)
type Case<'a> = (&'a str, &'a [SetTag], &'a [(&'a str, Value)]);

// @req FR-008, TST-002
#[test]
fn edits_on_photo_and_non_photo_files_read_back_exactly() {
    let engine = Engine::new();
    let mut ws = Workspace::new("tag-edit");
    let cases: &[Case] = &[
        (
            "metadata.jpg",
            &[
                text("IFD0", "Make", "Nikon"),
                text("XMP-dc", "Title", "Bee on lavender · مرحبا · 🐝"),
                // A list stays a list; an item with a comma stays one item.
                list("XMP-dc", "Subject", &["bee", "two, words", "ñ"]),
                // Display text is written back exactly, without a numeric mode.
                text("ExifIFD", "ExposureTime", "1/200"),
                text("IFD0", "Orientation", "Rotate 90 CW"),
                // Values that look like ExifTool syntax or options are stored literally.
                text("IFD0", "Artist", "x<FileName"),
                text("IFD0", "Software", "-overwrite_original"),
                // Empty means an empty value, not deletion.
                text("IFD0", "ImageDescription", ""),
            ],
            &[
                ("IFD0:Make", json!("Nikon")),
                ("XMP-dc:Title", json!("Bee on lavender · مرحبا · 🐝")),
                ("XMP-dc:Subject", json!(["bee", "two, words", "ñ"])),
                ("ExifIFD:ExposureTime", json!("1/200")),
                ("IFD0:Orientation", json!("Rotate 90 CW")),
                ("IFD0:Artist", json!("x<FileName")),
                ("IFD0:Software", json!("-overwrite_original")),
                ("IFD0:ImageDescription", json!("")),
            ],
        ),
        (
            "metadata.pdf",
            &[
                text("PDF", "Author", "Someone Else"),
                text("PDF", "Title", "New ☃ title"),
            ],
            &[
                ("PDF:Author", json!("Someone Else")),
                ("PDF:Title", json!("New ☃ title")),
            ],
        ),
        (
            "metadata.png",
            &[text("PNG", "Title", "PNG ✓")],
            &[("PNG:Title", json!("PNG ✓"))],
        ),
        (
            "movie.mp4",
            &[text("QuickTime", "CreateDate", "2026:01:02 03:04:05")],
            &[("QuickTime:CreateDate", json!("2026:01:02 03:04:05"))],
        ),
        (
            "sidecar.xmp",
            &[text("XMP-dc", "Title", "Sidecar title")],
            &[("XMP-dc:Title", json!("Sidecar title"))],
        ),
    ];
    for (fixture, edits, expected) in cases {
        let copy = ws.copy(fixture);
        let before = engine.read(&copy);
        write(&engine, &copy, edits);
        let read = engine.read(&copy);
        for (key, wanted) in *expected {
            assert_eq!(&value(&read, key), wanted, "{fixture} {key}");
        }
        // Every tag not edited keeps its exact value, apart from groups any write changes:
        // file-system facts, ExifTool's own notes, values derived from others, and the XMP
        // packet's toolkit stamp.
        let edited: Vec<&str> = expected.iter().map(|(key, _)| *key).collect();
        for tag in &before.tags {
            let changes = ["System", "File", "ExifTool", "Composite"]
                .contains(&tag.group1.as_str())
                || tag.key == "XMP-x:XMPToolkit";
            if !changes && !edited.contains(&tag.key.as_str()) {
                assert_eq!(
                    value(&read, &tag.key),
                    value(&before, &tag.key),
                    "{fixture} {}",
                    tag.key
                );
            }
        }
    }
}

// @req FR-008, SEC-002
#[test]
fn a_duplicate_instance_is_written_through_its_own_group() {
    let engine = Engine::new();
    let mut ws = Workspace::new("tag-edit-copy");
    let copy = ws.copy("metadata.jpg");
    // The read shows XMP-tiff:Copy1:Make; copy groups cannot be written, its group can.
    assert_eq!(
        value(&engine.read(&copy), "XMP-tiff:Copy1:Make"),
        json!("ExifBee XMP Make")
    );
    write(
        &engine,
        &copy,
        &[text("XMP-tiff", "Make", "Changed XMP Make")],
    );
    let read = engine.read(&copy);
    assert_eq!(
        value(&read, "XMP-tiff:Copy1:Make"),
        json!("Changed XMP Make")
    );
    assert_eq!(
        value(&read, "IFD0:Make"),
        json!("ExifBee EXIF Make"),
        "the other Make is untouched"
    );
}

// @req FR-008, SEC-002, SEC-003
#[test]
fn edits_that_cannot_be_expressed_safely_never_become_arguments() {
    let refused = [
        text("IFD0", "Make<FileName", "x"),
        text("IFD0", "Make=", "x"),
        text("IFD0", "Make+", "x"),
        text("IFD0:Copy1", "Make", "x"),
        text("", "Make", "x"),
        text("-IFD0", "Make", "x"),
        text("System", "FileName", "renamed.jpg"),
        text("IFD0", "Make", "nul\0byte"),
        list("XMP-dc", "Subject", &[]),
        list("XMP-dc", "Subject", &["ok", ""]),
        text("IFD0", "Make", &"x".repeat(64 * 1024 + 1)),
    ];
    for edit in refused {
        assert!(edit.problem().is_some(), "{edit:?}");
        assert!(Args::new().set(&edit).is_err(), "{edit:?}");
    }
    let empty_text = Args::new().set(&text("IFD0", "Artist", "")).unwrap();
    assert_eq!(empty_text.as_slice(), ["-IFD0:Artist^="]);
    let items = Args::new()
        .set(&list("XMP-dc", "Subject", &["a", "b, c"]))
        .unwrap();
    assert_eq!(
        items.as_slice(),
        ["-XMP-dc:Subject=a", "-XMP-dc:Subject=b, c"]
    );
}

// @req FR-008, FR-023
#[test]
fn a_value_that_is_not_utf8_is_detected_before_editing() {
    let engine = Engine::new();
    let mut ws = Workspace::new("tag-edit-bytes");
    let copy = ws.copy("metadata.jpg");
    let bytes = ws.path().join("bad.bin");
    fs::write(&bytes, b"Bad\xff\xfeEnd").unwrap();
    // Store raw bytes in IFD0:Artist through ExifTool's own file-input syntax (test setup only).
    let mut command = std::process::Command::new(&engine.tool.path);
    command
        .arg("-overwrite_original")
        .arg(format!("-IFD0:Artist<={}", bytes.display()))
        .arg(&copy);
    assert!(command.status().unwrap().success());

    // The ordinary read shows question marks; the -b check sees the real bytes.
    assert_eq!(value(&engine.read(&copy), "IFD0:Artist"), json!("Bad??End"));
    assert!(!raw_is_utf8(&engine.tool, &copy, "IFD0", "Artist").unwrap());
    assert!(raw_is_utf8(&engine.tool, &copy, "IFD0", "Make").unwrap());
    assert!(raw_is_utf8(&engine.tool, &copy, "IFD0", "NotPresent").unwrap());
    assert!(raw_is_utf8(&engine.tool, &copy, "IFD0", "Make<FileName").is_err());
}
