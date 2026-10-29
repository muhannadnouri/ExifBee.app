//! Reading one file through Rust with the real system ExifTool (S0-T06).

mod common;

use common::{fixture, system_exiftool, value, TempDir};
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
        let read = read_metadata(&tool, &fixture(name)).unwrap();
        assert_eq!(value(&read, key), json!(expected), "{name}");
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
    assert_eq!(value(&truncated, "File:FileType"), json!("JPEG"));
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
    assert_eq!(value(&read, "System:FileName"), json!(name));
    assert_eq!(value(&read, "IFD0:Make"), json!("ExifBee EXIF Make"));
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
    let tool = system_exiftool();

    // Numbers stay exactly as written: no float rounding, no exponent expansion.
    let numbers = read_metadata(&tool, &fixture("numbers.xmp")).unwrap();
    assert_eq!(value(&numbers, "XMP-dc:Identifier"), json!("007"));
    assert_eq!(value(&numbers, "XMP-dc:Source"), json!("13.50"));
    assert_eq!(value(&numbers, "XMP-dc:Format"), json!("1e3"));
    assert_eq!(
        value(&numbers, "ExifTool:ExifToolVersion"),
        json!(tool.version)
    );

    // XMP structures stay nested (not flattened into CreatorCity); lists stay lists.
    let sidecar = read_metadata(&tool, &fixture("sidecar.xmp")).unwrap();
    assert_eq!(
        value(&sidecar, "XMP-iptcCore:CreatorContactInfo"),
        json!({ "CiAdrCity": "Fixture City" })
    );
    assert_eq!(value(&sidecar, "XMP-dc:Subject"), json!(["bee", "fixture"]));

    // Binary data is a descriptor with its size, never bytes forced into text.
    let palette = read_metadata(&tool, &fixture("palette.png")).unwrap();
    assert_eq!(value(&palette, "PNG:Palette"), json!({ "binary": 768 }));

    // Same-name tags keep separate identities.
    let jpeg = read_metadata(&tool, &fixture("metadata.jpg")).unwrap();
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
    let tool = system_exiftool();
    let empty = read_metadata(&tool, &fixture("empty.bin")).unwrap();
    assert_eq!(empty.error.as_deref(), Some("File is empty"));
    assert!(empty
        .tags
        .iter()
        .all(|tag| tag.group1 != "File" || tag.name != "FileType"));

    let no_metadata = read_metadata(&tool, &fixture("no-metadata.jpg")).unwrap();
    assert!(no_metadata
        .tags
        .iter()
        .all(|tag| !tag.group1.starts_with("XMP") && tag.group1 != "IFD0"));

    // A text file: ExifTool can describe it but writes nothing to TXT (no writable tags).
    let text = read_metadata(&tool, &fixture("plain.txt")).unwrap();
    assert_eq!(value(&text, "File:FileType"), json!("TXT"));
    assert_eq!(text.error, None);
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
