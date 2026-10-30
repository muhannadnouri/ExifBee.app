//! Tag writability and group families from the installed ExifTool's own lists (S3-T04, UX-006),
//! checked against real reads of the fixture corpus.

mod common;

use common::harness::{Engine, Workspace};
use common::TempDir;
use exifbee_lib::adapter::exiftool::process::CancelToken;
use exifbee_lib::domain::metadata::Writability::{self, ReadOnly, Unknown, Writable};
use exifbee_lib::service::capabilities::CapabilityCache;

/// One tag's expected `(key, group0, writability)`.
type Expected = (&'static str, Option<&'static str>, Writability);

// @req UX-006, FR-007, TST-002
#[test]
fn reads_say_which_tags_are_writable_read_only_or_unknown_per_file_format() {
    let engine = Engine::new();
    let mut ws = Workspace::new("writability");
    let cache_dir = TempDir::new("writability-cache");
    let snapshot = CapabilityCache::new(&cache_dir.0)
        .snapshot(&engine.tool, &CancelToken::default())
        .expect("capability lists");

    // (fixture, format writable, [(key, group0, writability)])
    let cases: &[(&str, Option<bool>, &[Expected])] = &[
        (
            "metadata.jpg",
            Some(true),
            &[
                ("IFD0:Make", Some("EXIF"), Writable),
                // Same tag name, another group and a copy number: still told apart.
                ("XMP-tiff:Copy1:Make", Some("XMP"), Writable),
                ("XMP-dc:Subject", Some("XMP"), Writable),
                ("Composite:ImageSize", Some("Composite"), ReadOnly),
                ("File:FileType", Some("File"), ReadOnly),
                ("System:FileName", Some("File"), Writable),
            ],
        ),
        (
            "metadata.pdf",
            Some(true),
            &[
                ("PDF:Title", Some("PDF"), Writable),
                ("PDF:PageCount", Some("PDF"), ReadOnly),
            ],
        ),
        (
            "movie.mp4",
            Some(true),
            &[
                ("QuickTime:CreateDate", Some("QuickTime"), Writable),
                ("QuickTime:Duration", Some("QuickTime"), ReadOnly),
            ],
        ),
        (
            // ZIP is readable but not writable: even tags ExifTool can write elsewhere are
            // read-only here, while file-system properties stay writable.
            "archive.zip",
            Some(false),
            &[
                ("ZIP:ZipFileName", Some("ZIP"), ReadOnly),
                ("System:FileModifyDate", Some("File"), Writable),
            ],
        ),
        (
            // Unknown format: nothing about its content can be proven writable.
            "unknown.dat",
            None,
            &[
                ("System:FileName", Some("File"), Writable),
                ("ExifTool:Error", Some("ExifTool"), ReadOnly),
            ],
        ),
    ];

    for (fixture, format, expected) in cases {
        let mut file = engine.read(&ws.copy(fixture));
        snapshot.annotate(&mut file);
        assert_eq!(file.format_writable, *format, "{fixture}");
        for (key, group0, writable) in *expected {
            let tag = file
                .tags
                .iter()
                .find(|tag| tag.key == *key)
                .unwrap_or_else(|| panic!("{fixture}: no {key}"));
            assert_eq!(
                (tag.group0.as_deref(), tag.writable),
                (*group0, *writable),
                "{fixture} {key}"
            );
        }
        // Every tag of these fixtures is in ExifTool's list: none is left without a family.
        let unknown: Vec<_> = file
            .tags
            .iter()
            .filter(|tag| tag.group0.is_none())
            .map(|tag| tag.key.as_str())
            .collect();
        assert!(unknown.is_empty(), "{fixture}: {unknown:?}");
    }

    // A tag ExifTool does not define stays Unknown rather than being guessed.
    let mut file = engine.read(&ws.copy("metadata.jpg"));
    file.tags[0].group1 = "NoSuchGroup".into();
    snapshot.annotate(&mut file);
    assert_eq!(
        (file.tags[0].group0.as_deref(), file.tags[0].writable),
        (None, Unknown)
    );
}
