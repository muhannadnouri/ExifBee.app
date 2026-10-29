//! Reading one file through Rust with the real system ExifTool (S0-T06).

mod common;

use common::{fixture, system_exiftool, TempDir};
use exifbee_lib::adapter::exiftool::read::{read_metadata, ReadError};
use exifbee_lib::domain::error::{AppError, ErrorKind};
use serde_json::json;
use std::fs;
use std::path::Path;

// @req FR-005
#[test]
fn reads_image_and_non_image_files_with_group_qualified_tags() {
    let tool = system_exiftool();

    let jpeg = read_metadata(&tool, &fixture("metadata.jpg")).unwrap();
    assert_eq!(jpeg.source_file, fixture("metadata.jpg").to_str().unwrap());
    assert_eq!(jpeg.error, None);
    assert!(jpeg.warnings.is_empty());
    // Same tag name in two groups stays two distinct entries.
    assert_eq!(jpeg.tags["IFD0:Make"], json!("ExifBee EXIF Make"));
    assert_eq!(jpeg.tags["XMP-tiff:Copy1:Make"], json!("ExifBee XMP Make"));
    assert_eq!(jpeg.tags["XMP-dc:Title"], json!("مرحبا · 日本語 · 🐝"));
    assert_eq!(jpeg.tags["XMP-dc:Subject"], json!(["bee", "fixture"]));

    for (name, key, value) in [
        ("metadata.pdf", "PDF:Title", "ExifBee PDF title"),
        ("archive.zip", "ZIP:ZipFileName", "hello.txt"),
        ("plain.txt", "File:FileType", "TXT"),
    ] {
        let read = read_metadata(&tool, &fixture(name)).unwrap();
        assert_eq!(read.tags[key], json!(value), "{name}");
        assert_eq!(read.error, None, "{name}");
    }
}

// @req FR-005, NFR-004
#[test]
fn per_file_errors_and_warnings_are_structured_not_failures() {
    let tool = system_exiftool();

    let empty = read_metadata(&tool, &fixture("empty.bin")).unwrap();
    assert_eq!(empty.error.as_deref(), Some("File is empty"));

    let truncated = read_metadata(&tool, &fixture("truncated.jpg")).unwrap();
    assert_eq!(truncated.error, None);
    assert!(!truncated.warnings.is_empty(), "{:?}", truncated.tags);
    assert_eq!(truncated.tags["File:FileType"], json!("JPEG"));
}

// @req NFR-005, SEC-002
#[test]
fn hostile_and_long_paths_are_read_literally() {
    let tool = system_exiftool();
    let dir = TempDir::new("paths");
    // Five 200-byte components plus Unicode: over 1 KiB, still within Linux PATH_MAX.
    let mut deep = dir.0.clone();
    for _ in 0..5 {
        deep.push("d".repeat(200));
    }
    deep.push("é 日本 🐝 spaced".repeat(8));
    fs::create_dir_all(&deep).unwrap();
    let name = "-lead 'q\" ;$(touch pwned) & `touch pwned2` *?\nnext line.jpg";
    let hostile = deep.join(name);
    fs::copy(fixture("metadata.jpg"), &hostile).unwrap();

    assert!(hostile.as_os_str().len() > 1024);

    let read = read_metadata(&tool, &hostile).unwrap();
    assert_eq!(read.source_file, hostile.to_str().unwrap());
    assert_eq!(read.tags["System:FileName"], json!(name));
    assert_eq!(read.tags["IFD0:Make"], json!("ExifBee EXIF Make"));
    for planted in ["pwned", "pwned2"] {
        assert!(!deep.join(planted).exists() && !Path::new(planted).exists());
    }
}

// @req FR-005, NFR-004
#[test]
fn invalid_targets_are_rejected_before_exiftool_runs() {
    let tool = system_exiftool();
    let dir = TempDir::new("invalid");

    for target in [
        Path::new("metadata.jpg").to_path_buf(),
        dir.0.join("missing.jpg"),
        // A directory would make ExifTool read every file in it.
        dir.0.clone(),
    ] {
        let error = read_metadata(&tool, &target).unwrap_err();
        assert!(matches!(error, ReadError::InvalidInput(_)), "{target:?}");
        assert_eq!(AppError::from(error).kind, ErrorKind::InvalidInput);
    }
}

// @req NFR-004
#[test]
fn errors_serialize_as_kind_and_message_for_ipc() {
    let error = AppError::from(ReadError::InvalidInput("not a readable file: /x".into()));
    assert_eq!(
        serde_json::to_value(error).unwrap(),
        json!({ "kind": "InvalidInput", "message": "not a readable file: /x" })
    );
}

// @req SEC-003
#[test]
fn hostile_markup_in_metadata_arrives_as_plain_text() {
    let read = read_metadata(&system_exiftool(), &fixture("hostile.xmp")).unwrap();
    // ExifTool decodes the XML escapes, so the renderer receives live markup as a string; it must
    // only ever be rendered as text (React text nodes, CSP blocks inline scripts as a backstop).
    assert_eq!(
        read.tags["XMP-dc:Title"],
        json!(r#"<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>"#)
    );
    assert_eq!(
        read.tags["XMP-dc:Description"],
        json!(r#""><svg onload="window.__pwned=3"></svg>"#)
    );
}
