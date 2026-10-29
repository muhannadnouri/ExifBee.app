//! The real-ExifTool test harness (SPEC §12.1, S2-T06): every test that runs ExifTool on a file
//! does so on a *temporary copy* in a [`Workspace`], through an [`Engine`] that resolves ExifTool
//! exactly like the app and records reproducibility evidence.

use super::TempDir;
use exifbee_lib::adapter::exiftool::argv::Args;
use exifbee_lib::adapter::exiftool::read::{read_args, read_metadata, FileMetadata};
use exifbee_lib::adapter::exiftool::resolver::{probe, resolve, ExifTool, DEFAULT_TIMEOUT};
use exifbee_lib::domain::metadata::MetadataValue;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// The committed fixture corpus. Tests never touch these files directly.
pub fn golden_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures")
        .canonicalize()
        .unwrap()
}

pub fn sha256(path: &Path) -> String {
    let bytes = fs::read(path).unwrap_or_else(|error| panic!("read {path:?}: {error}"));
    format!("{:x}", Sha256::digest(bytes))
}

/// A fresh temporary directory holding copies of golden fixtures (the `TempFixtures` contract).
///
/// On drop — including while a failed test unwinds — it (1) checks that no golden fixture it copied
/// from was modified, (2) restores write permission on everything a test locked down, and
/// (3) removes the directory. Step 1 is skipped while panicking, because a second panic would
/// abort the test run and hide the original failure.
pub struct Workspace {
    dir: TempDir,
    golden: PathBuf,
    copies: BTreeMap<PathBuf, (PathBuf, String)>,
}

impl Workspace {
    pub fn new(name: &str) -> Self {
        Self::with_golden(name, &golden_dir())
    }

    /// Like [`Workspace::new`] with another golden directory (used to test the harness itself).
    pub fn with_golden(name: &str, golden: &Path) -> Self {
        Self {
            dir: TempDir::new(name),
            golden: golden.into(),
            copies: BTreeMap::new(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.dir.0
    }

    /// Copies a golden fixture into the workspace under its own name.
    pub fn copy(&mut self, fixture: &str) -> PathBuf {
        self.copy_as(fixture, fixture)
    }

    /// Copies a golden fixture under another (possibly hostile) name; parent folders are created.
    pub fn copy_as(&mut self, fixture: &str, name: &str) -> PathBuf {
        let source = self.golden.join(fixture);
        let target = self.dir.0.join(name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::copy(&source, &target).unwrap_or_else(|error| panic!("copy {source:?}: {error}"));
        self.copies
            .insert(target.clone(), (source.clone(), sha256(&source)));
        target
    }

    /// Every file in the workspace with its checksum, for before/after comparisons.
    pub fn files(&self) -> BTreeMap<PathBuf, String> {
        fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, String>) {
            for entry in fs::read_dir(dir).unwrap().map(Result::unwrap) {
                let path = entry.path();
                if entry.file_type().unwrap().is_dir() {
                    walk(&path, out);
                } else {
                    out.insert(path.clone(), sha256(&path));
                }
            }
        }
        let mut files = BTreeMap::new();
        walk(&self.dir.0, &mut files);
        files
    }

    /// `expectOriginalUnchanged`: the copy still has the golden fixture's exact bytes.
    pub fn expect_unchanged(&self, copy: &Path) {
        let (source, original) = &self.copies[copy];
        assert_eq!(
            &sha256(copy),
            original,
            "{copy:?} (from {source:?}) was modified"
        );
    }

    /// `expectNoUnexpectedOutputs`: the workspace holds exactly the files it held `before`.
    pub fn expect_no_new_outputs(&self, before: &BTreeMap<PathBuf, String>) {
        let after = self.files();
        let created: Vec<_> = after
            .keys()
            .filter(|path| !before.contains_key(*path))
            .collect();
        let removed: Vec<_> = before
            .keys()
            .filter(|path| !after.contains_key(*path))
            .collect();
        assert!(
            created.is_empty() && removed.is_empty(),
            "created {created:?}, removed {removed:?}"
        );
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            for (copy, (source, original)) in &self.copies {
                assert_eq!(
                    &sha256(source),
                    original,
                    "golden fixture {source:?} was modified via {copy:?}"
                );
            }
        }
        // TempDir's own drop then restores permissions and removes the tree.
    }
}

/// The ExifTool under test (the `ExifToolHarness` contract): `EXIFTOOL` if set, else the app's own
/// resolution. Dropping it writes a reproducibility record when `EXIFBEE_EVIDENCE_DIR` is set.
pub struct Engine {
    pub tool: ExifTool,
}

/// Exit code, stdout and stderr of a direct `exiftool` command-line run.
pub struct Cli {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Engine {
    pub fn new() -> Self {
        let tool = match std::env::var_os("EXIFTOOL") {
            Some(path) => probe(Path::new(&path), DEFAULT_TIMEOUT),
            None => resolve(None),
        }
        .expect("a supported system ExifTool must be installed for this test");
        Self { tool }
    }

    /// Reads through the app's adapter, exactly like `read_selected_file`.
    pub fn read(&self, path: &Path) -> FileMetadata {
        read_metadata(&self.tool, path).unwrap_or_else(|error| panic!("read {path:?}: {error}"))
    }

    /// Runs the same ExifTool directly, bypassing ExifBee's executor and parser.
    pub fn cli(&self, args: &Args) -> Cli {
        let output = Command::new(&self.tool.path)
            .args(args.as_slice())
            .output()
            .unwrap();
        Cli {
            code: output.status.code(),
            stdout: output.stdout,
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        }
    }

    /// Deterministic comparison: ExifBee's parsed read must equal ExifTool's own JSON for the same
    /// arguments, tag for tag and in order. `System:FileAccessDate` is excluded because reading the
    /// file may itself update the access time between the two runs. Returns the CLI exit code.
    pub fn expect_read_matches_cli(&self, path: &Path) -> Option<i32> {
        let read = self.read(path);
        let cli = self.cli(&read_args(path).unwrap());
        let mut files: Vec<Map<String, Value>> = serde_json::from_slice(&cli.stdout).unwrap();
        let mut expected = files.remove(0);
        assert_eq!(
            expected.shift_remove("SourceFile"),
            Some(json!(read.source_file))
        );
        let volatile = |key: &str| key == "System:FileAccessDate";
        let expected: Vec<(String, Value)> = expected
            .into_iter()
            .filter(|(key, _)| !volatile(key))
            .collect();
        let actual: Vec<(String, Value)> = read
            .tags
            .iter()
            .filter(|tag| !volatile(&tag.key))
            .map(|tag| (tag.key.clone(), plain(&tag.value)))
            .collect();
        assert_eq!(actual, expected, "{path:?}");
        cli.code
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    /// Writes this test's reproducibility record (the `TestEvidence` contract) into `dir` as
    /// `<suite>__<test>.json`. Requirement IDs are added later by
    /// `scripts/collect-test-evidence.mjs` from the test's `@req` comment, so they live in one place.
    pub fn write_evidence(&self, dir: &Path) {
        let test = std::thread::current()
            .name()
            .unwrap_or("unknown")
            .to_string();
        let suite = env!("CARGO_CRATE_NAME");
        let record = json!({
            "suite": suite,
            "test": test,
            "status": if std::thread::panicking() { "failed" } else { "passed" },
            "exiftool": {
                "version": self.tool.version,
                "path": self.tool.path,
                "canonicalPath": self.tool.identity.canonical_path,
            },
            "fixtureVersion": sha256(&golden_dir().join("SHA256SUMS")),
            "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            "commit": std::env::var("GITHUB_SHA").unwrap_or_else(|_| "local".into()),
            "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()),
        });
        let _ = fs::create_dir_all(dir);
        let _ = fs::write(
            dir.join(format!("{suite}__{test}.json")),
            record.to_string(),
        );
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if let Some(dir) = std::env::var_os("EXIFBEE_EVIDENCE_DIR") {
            self.write_evidence(Path::new(&dir));
        }
    }
}

/// A typed value as plain JSON (what ExifTool printed with JSONQ); binary becomes
/// `{"binary": <byte length>}` here and ExifTool's placeholder string in the CLI comparison.
pub fn plain(value: &MetadataValue) -> Value {
    match value {
        MetadataValue::Text { text } => json!(text),
        MetadataValue::List { items } => Value::Array(items.iter().map(plain).collect()),
        MetadataValue::Structure { fields } => Value::Object(
            fields
                .iter()
                .map(|field| (field.name.clone(), plain(&field.value)))
                .collect(),
        ),
        MetadataValue::Binary { byte_length } => match byte_length {
            Some(length) => json!(format!(
                "(Binary data {length} bytes, use -b option to extract)"
            )),
            None => json!({ "binary": null }),
        },
    }
}

/// `expectTagValue`: the tag's value as plain JSON; panics if the tag is absent.
pub fn value(file: &FileMetadata, key: &str) -> Value {
    let tag = file
        .tags
        .iter()
        .find(|tag| tag.key == key)
        .unwrap_or_else(|| {
            panic!(
                "no tag {key} in {:?}",
                file.tags.iter().map(|t| &t.key).collect::<Vec<_>>()
            )
        });
    match &tag.value {
        MetadataValue::Binary { byte_length } => json!({ "binary": byte_length }),
        other => plain(other),
    }
}

/// `expectTagAbsent`.
pub fn expect_absent(file: &FileMetadata, key: &str) {
    assert!(
        file.tags.iter().all(|tag| tag.key != key),
        "unexpected tag {key}"
    );
}

/// `expectPerFileOutcomes`: ExifTool's per-file error and whether it warned.
pub fn expect_outcome(file: &FileMetadata, error: Option<&str>, warned: bool) {
    assert_eq!(file.error.as_deref(), error, "{}", file.source_file);
    assert_eq!(
        !file.warnings.is_empty(),
        warned,
        "{}: {:?}",
        file.source_file,
        file.warnings
    );
}
