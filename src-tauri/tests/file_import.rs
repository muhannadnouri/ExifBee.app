//! File import into the session registry (S3-T01): mixed formats, hostile names, duplicates and
//! what is refused. Reads go through the registry's path for an ID, with the real ExifTool.

mod common;

use common::harness::{value, Engine, Workspace};
use common::TempDir;
use exifbee_lib::service::files::{FileRegistry, ImportResult};
use serde_json::json;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::process::Command;

fn reasons(result: &ImportResult) -> Vec<(String, String)> {
    let rejected = result.rejected.iter();
    rejected
        .map(|r| (r.path.clone(), r.reason.clone()))
        .collect()
}

// @req FR-003, NFR-005, TST-002
#[test]
fn jpeg_pdf_mp4_zip_and_unknown_files_with_hostile_names_import_together_and_read() {
    let engine = Engine::new();
    let mut ws = Workspace::new("import-mixed");
    // (fixture, name it is chosen under, expected File:FileType or None, ExifTool exit status)
    let chosen = [
        ("metadata.jpg", "-leading-hyphen.jpg", Some("JPEG"), 0),
        (
            "metadata.pdf",
            "مرحبا \"quoted\" report.pdf",
            Some("PDF"),
            0,
        ),
        ("movie.mp4", "it's a 🐝 movie.MP4", Some("MP4"), 0),
        ("archive.zip", "--archive; $(echo x).zip", Some("ZIP"), 0),
        ("unknown.dat", "-dir with spaces/unknown", None, 1),
    ];
    let paths: Vec<PathBuf> = chosen
        .iter()
        .map(|(fixture, name, ..)| ws.copy_as(fixture, name))
        .collect();
    let before = ws.files();

    let mut registry = FileRegistry::default();
    let result = registry.add(paths.clone());
    assert_eq!(result.duplicates, Vec::<String>::new());
    assert_eq!(reasons(&result), vec![]);
    assert_eq!(result.added.len(), chosen.len());

    for ((_, name, file_type, exit), (added, path)) in
        chosen.iter().zip(result.added.iter().zip(&paths))
    {
        assert_eq!(added.path, path.to_str().unwrap());
        assert_eq!(added.name, name.rsplit('/').next().unwrap());
        // The ID is opaque: it says nothing about the path it stands for.
        assert!(!added.id.contains(name.rsplit('/').next().unwrap()));
        let registered = registry.path(&added.id).expect("issued ID resolves");
        assert_eq!(registered, path);

        assert_eq!(
            engine.expect_read_matches_cli(registered),
            Some(*exit),
            "{name}"
        );
        let read = engine.read(registered);
        match file_type {
            Some(file_type) => assert_eq!(value(&read, "File:FileType"), json!(file_type)),
            None => assert_eq!(read.error.as_deref(), Some("Unknown file type")),
        }
        ws.expect_unchanged(path);
    }
    ws.expect_no_new_outputs(&before);
}

// @req FR-003, SEC-008
#[test]
fn repeated_selections_skip_duplicates_and_keep_ids_stable() {
    let dir = TempDir::new("import-duplicates");
    let file = |name: &str| {
        let path = dir.0.join(name);
        fs::write(&path, name).unwrap();
        path
    };
    let (a, b, c) = (file("a.jpg"), file("b.pdf"), file("c"));
    let link = dir.0.join("link-to-a.jpg");
    symlink(&a, &link).unwrap();

    let mut registry = FileRegistry::default();
    let first = registry.add([a.clone(), b.clone()]);
    let ids: Vec<_> = first.added.iter().map(|f| f.id.clone()).collect();
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);

    // Same file again (directly, through `..`, through a symlink, twice in one selection).
    let dotted = dir.0.join("sub/../b.pdf");
    fs::create_dir(dir.0.join("sub")).unwrap();
    let second = registry.add([
        b.clone(),
        c.clone(),
        c.clone(),
        link.clone(),
        dotted.clone(),
    ]);
    let names: Vec<_> = second.added.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["c"]);
    let skipped = [&b, &c, &link, &dotted].map(|p| p.display().to_string());
    assert_eq!(second.duplicates, skipped);
    assert!(!ids.contains(&second.added[0].id));

    // Earlier IDs still name the same files.
    assert_eq!(registry.path(&ids[0]), Some(a.as_path()));
    assert_eq!(registry.path(&ids[1]), Some(b.as_path()));
}

// @req SEC-008, NFR-005
#[test]
fn refuses_what_it_cannot_safely_read_and_ids_it_never_issued() {
    let dir = TempDir::new("import-refused");
    let folder = dir.0.join("folder");
    fs::create_dir(&folder).unwrap();
    let fifo = dir.0.join("pipe");
    assert!(Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let dangling = dir.0.join("dangling");
    symlink(dir.0.join("gone"), &dangling).unwrap();

    let mut registry = FileRegistry::default();
    let result = registry.add([
        PathBuf::from("relative.jpg"),
        dir.0.join("missing.jpg"),
        dangling.clone(),
        folder.clone(),
        fifo.clone(),
    ]);
    assert!(result.added.is_empty());
    let shown = |path: &PathBuf| path.display().to_string();
    assert_eq!(
        reasons(&result),
        [
            ("relative.jpg".into(), "not an absolute path"),
            (shown(&dir.0.join("missing.jpg")), "missing or not readable"),
            (shown(&dangling), "missing or not readable"),
            (shown(&folder), "is a folder"),
            (shown(&fifo), "not a regular file"),
        ]
        .map(|(path, reason): (String, &str)| (path, reason.to_string()))
    );

    // Only issued IDs resolve; a guessed ID or a path passed as an ID is refused.
    for id in ["f1", "", "../etc/passwd", "/etc/passwd"] {
        assert_eq!(registry.path(id), None, "{id}");
    }
}
