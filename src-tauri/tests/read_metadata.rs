//! Reading files through the app's adapter with the real ExifTool (S0-T06, S2-T05). Every read
//! runs on a temporary copy in a `Workspace` (S2-T06).

mod common;

use common::harness::{expect_absent, expect_outcome, value, Engine, Workspace};
use common::TempDir;
use exifbee_lib::adapter::exiftool::read::{read_metadata, ReadError};
use exifbee_lib::domain::error::{AppError, ErrorKind};
use serde_json::json;
use std::path::Path;

// @req FR-005, TST-002
#[test]
fn every_fixture_reads_exactly_like_the_exiftool_cli_without_changing_it() {
    let engine = Engine::new();
    let mut ws = Workspace::new("read-corpus");
    for (fixture, exit) in [
        ("metadata.jpg", 0),
        ("metadata.png", 0),
        ("metadata.pdf", 0),
        ("sidecar.xmp", 0),
        ("archive.zip", 0),
        ("no-metadata.jpg", 0),
        ("plain.txt", 0),
        ("empty.bin", 1),
        ("truncated.jpg", 0),
        ("hostile.xmp", 0),
        ("palette.png", 0),
        ("numbers.xmp", 0),
    ] {
        let copy = ws.copy(fixture);
        let before = ws.files();
        // ExifBee's parsed read equals ExifTool's own JSON, and the exit status is the expected one.
        assert_eq!(
            engine.expect_read_matches_cli(&copy),
            Some(exit),
            "{fixture}"
        );
        ws.expect_unchanged(&copy);
        ws.expect_no_new_outputs(&before);
    }
}

// @req FR-005
#[test]
fn reads_image_and_non_image_files_with_group_qualified_tags() {
    let engine = Engine::new();
    let mut ws = Workspace::new("read-groups");

    let copy = ws.copy("metadata.jpg");
    let jpeg = engine.read(&copy);
    assert_eq!(jpeg.source_file, copy.to_str().unwrap());
    expect_outcome(&jpeg, None, false);
    // Same tag name in two groups stays two distinct entries.
    assert_eq!(value(&jpeg, "IFD0:Make"), json!("ExifBee EXIF Make"));
    assert_eq!(
        value(&jpeg, "XMP-tiff:Copy1:Make"),
        json!("ExifBee XMP Make")
    );
    assert_eq!(value(&jpeg, "XMP-dc:Title"), json!("مرحبا · 日本語 · 🐝"));
    assert_eq!(value(&jpeg, "XMP-dc:Subject"), json!(["bee", "fixture"]));

    for (name, key, expected) in [
        ("metadata.pdf", "PDF:Title", "ExifBee PDF title"),
        ("archive.zip", "ZIP:ZipFileName", "hello.txt"),
        ("plain.txt", "File:FileType", "TXT"),
    ] {
        let read = engine.read(&ws.copy(name));
        assert_eq!(value(&read, key), json!(expected), "{name}");
        expect_outcome(&read, None, false);
    }
}

// @req FR-005, NFR-004
#[test]
fn per_file_errors_and_warnings_are_structured_not_failures() {
    let engine = Engine::new();
    let mut ws = Workspace::new("read-outcomes");

    let empty = engine.read(&ws.copy("empty.bin"));
    expect_outcome(&empty, Some("File is empty"), false);

    let truncated = engine.read(&ws.copy("truncated.jpg"));
    expect_outcome(&truncated, None, true);
    assert_eq!(value(&truncated, "File:FileType"), json!("JPEG"));
}

// @req NFR-005, SEC-002
#[test]
fn hostile_and_long_paths_are_read_literally() {
    let engine = Engine::new();
    let mut ws = Workspace::new("read-paths");
    // Five 200-byte components plus Unicode: over 1 KiB, still within Linux PATH_MAX.
    let name = "-lead 'q\" ;$(touch pwned) & `touch pwned2` *?\nnext line.jpg";
    let relative = format!(
        "{}/{}/{name}",
        vec!["d".repeat(200); 5].join("/"),
        "é 日本 🐝 spaced".repeat(8)
    );
    let hostile = ws.copy_as("metadata.jpg", &relative);
    assert!(hostile.as_os_str().len() > 1024);
    let before = ws.files();

    let read = engine.read(&hostile);
    assert_eq!(read.source_file, hostile.to_str().unwrap());
    assert_eq!(value(&read, "System:FileName"), json!(name));
    assert_eq!(value(&read, "IFD0:Make"), json!("ExifBee EXIF Make"));
    // Nothing in the name ran: no files appeared anywhere.
    ws.expect_no_new_outputs(&before);
    assert!(!Path::new("pwned").exists() && !Path::new("pwned2").exists());
}

// @req FR-005, NFR-004
#[test]
fn invalid_targets_are_rejected_before_exiftool_runs() {
    let engine = Engine::new();
    let tool = engine.tool.clone();
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
    let engine = Engine::new();
    let mut ws = Workspace::new("read-hostile");
    let read = engine.read(&ws.copy("hostile.xmp"));
    // ExifTool decodes the XML escapes, so the renderer receives live markup as a string; it must
    // only ever be rendered as text (React text nodes, CSP blocks inline scripts as a backstop).
    assert_eq!(
        value(&read, "XMP-dc:Title"),
        json!(r#"<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>"#)
    );
    assert_eq!(
        value(&read, "XMP-dc:Description"),
        json!(r#""><svg onload="window.__pwned=3"></svg>"#)
    );
}

// @req FR-005, FR-023
#[test]
fn values_keep_exact_text_structure_lists_binary_and_identity() {
    let engine = Engine::new();
    let mut ws = Workspace::new("read-values");

    // Numbers stay exactly as written: no float rounding, no exponent expansion.
    let numbers = engine.read(&ws.copy("numbers.xmp"));
    assert_eq!(value(&numbers, "XMP-dc:Identifier"), json!("007"));
    assert_eq!(value(&numbers, "XMP-dc:Source"), json!("13.50"));
    assert_eq!(value(&numbers, "XMP-dc:Format"), json!("1e3"));
    assert_eq!(
        value(&numbers, "ExifTool:ExifToolVersion"),
        json!(engine.tool.version)
    );

    // XMP structures stay nested (not flattened into CreatorCity); lists stay lists.
    let sidecar = engine.read(&ws.copy("sidecar.xmp"));
    assert_eq!(
        value(&sidecar, "XMP-iptcCore:CreatorContactInfo"),
        json!({ "CiAdrCity": "Fixture City" })
    );
    expect_absent(&sidecar, "XMP-iptcCore:CreatorCity");
    assert_eq!(value(&sidecar, "XMP-dc:Subject"), json!(["bee", "fixture"]));

    // Binary data is a descriptor with its size, never bytes forced into text.
    let palette = engine.read(&ws.copy("palette.png"));
    assert_eq!(value(&palette, "PNG:Palette"), json!({ "binary": 768 }));

    // Same-name tags keep separate identities.
    let jpeg = engine.read(&ws.copy("metadata.jpg"));
    let makes: Vec<_> = jpeg.tags.iter().filter(|tag| tag.name == "Make").collect();
    assert_eq!(makes.len(), 2);
    assert_eq!((makes[0].group1.as_str(), makes[0].copy), ("IFD0", None));
    assert_eq!(
        (makes[1].group1.as_str(), makes[1].copy),
        ("XMP-tiff", Some(1))
    );
    // Keys stay unique and in ExifTool's order (SourceFile excluded).
    let mut keys: Vec<_> = jpeg.tags.iter().map(|tag| &tag.key).collect();
    assert_eq!(jpeg.tags[0].key, "ExifTool:ExifToolVersion");
    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), jpeg.tags.len());
}

// @req FR-005
#[test]
fn empty_non_image_and_read_only_files_parse_cleanly() {
    let engine = Engine::new();
    let mut ws = Workspace::new("read-empty");
    let empty = engine.read(&ws.copy("empty.bin"));
    expect_outcome(&empty, Some("File is empty"), false);
    expect_absent(&empty, "File:FileType");

    let no_metadata = engine.read(&ws.copy("no-metadata.jpg"));
    assert!(no_metadata
        .tags
        .iter()
        .all(|tag| !tag.group1.starts_with("XMP") && tag.group1 != "IFD0"));

    // A text file: ExifTool can describe it but writes nothing to TXT (no writable tags).
    let text = engine.read(&ws.copy("plain.txt"));
    assert_eq!(value(&text, "File:FileType"), json!("TXT"));
    expect_outcome(&text, None, false);
}

fn parse(json: &str) -> Result<exifbee_lib::adapter::exiftool::read::FileMetadata, ReadError> {
    exifbee_lib::adapter::exiftool::read::parse_output(json.as_bytes())
}

// @req FR-005, SEC-003
#[test]
fn malformed_or_pathological_output_is_rejected_not_half_trusted() {
    let ok =
        parse(r#"[{"SourceFile":"/a.jpg","IFD0:Make":"X","XMP-tiff:Copy2:Make":"Y"}]"#).unwrap();
    assert_eq!(ok.tags[1].copy, Some(2));

    for (case, json) in [
        (
            "unquoted number would lose 13.50",
            r#"[{"SourceFile":"/a","XMP-dc:Source":13.50}]"#,
        ),
        ("bool", r#"[{"SourceFile":"/a","X:Y":true}]"#),
        ("null", r#"[{"SourceFile":"/a","X:Y":null}]"#),
        ("key without group", r#"[{"SourceFile":"/a","Make":"X"}]"#),
        (
            "bad copy",
            r#"[{"SourceFile":"/a","IFD0:Second:Make":"X"}]"#,
        ),
        (
            "too many parts",
            r#"[{"SourceFile":"/a","A:Copy1:B:C":"X"}]"#,
        ),
        ("no SourceFile", r#"[{"IFD0:Make":"X"}]"#),
        ("two files", r#"[{"SourceFile":"/a"},{"SourceFile":"/b"}]"#),
        ("not JSON", "Error: File not found"),
    ] {
        assert!(
            matches!(parse(json), Err(ReadError::ProcessFailure(_))),
            "{case}"
        );
    }

    let mut deep = String::from(r#"[{"SourceFile":"/a","X:Y":"#);
    deep.push_str(&"[".repeat(40));
    deep.push_str(&"]".repeat(40));
    deep.push_str("}]");
    assert!(matches!(parse(&deep), Err(ReadError::ProcessFailure(m)) if m.contains("nested")));

    let many: Vec<String> = (0..100_001).map(|i| format!(r#""G:T{i}":"v""#)).collect();
    let huge = format!(r#"[{{"SourceFile":"/a",{}}}]"#, many.join(","));
    assert!(matches!(parse(&huge), Err(ReadError::ProcessFailure(m)) if m.contains("limit")));
}
