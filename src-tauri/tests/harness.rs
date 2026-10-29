//! The test harness itself (S2-T06): workspaces always clean up, goldens are guarded, the
//! assertions catch what they claim to, and evidence records are complete.

mod common;

use common::harness::{sha256, Engine, Workspace};
use exifbee_lib::adapter::exiftool::process::{run, CancelToken, RunError};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

// @req TST-002, TST-007
#[test]
fn a_failing_test_still_removes_its_workspace_even_when_files_are_locked() {
    let mut kept = PathBuf::new();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut ws = Workspace::new("cleanup-panic");
        kept = ws.path().to_path_buf();
        let copy = ws.copy_as("metadata.jpg", "locked/inner/photo.jpg");
        // What a permissions test might leave behind: a read-only file in read-only folders.
        fs::set_permissions(&copy, fs::Permissions::from_mode(0o444)).unwrap();
        fs::set_permissions(copy.parent().unwrap(), fs::Permissions::from_mode(0o555)).unwrap();
        fs::set_permissions(ws.path().join("locked"), fs::Permissions::from_mode(0o500)).unwrap();
        panic!("simulated test failure");
    }));
    assert!(result.is_err());
    assert!(
        !kept.as_os_str().is_empty() && !kept.exists(),
        "{kept:?} left behind"
    );
}

// @req TST-002, SEC-007
#[test]
fn a_cancelled_run_leaves_no_workspace_and_no_writer_behind() {
    let ws = Workspace::new("cleanup-cancel");
    let dir = ws.path().to_path_buf();
    let script = format!(
        "while :; do date >> '{}/log'; sleep 0.05; done",
        dir.display()
    );
    let cancel = CancelToken::default();
    let trigger = cancel.clone();
    let canceller = thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        trigger.cancel();
    });
    let result = run(
        Path::new("/bin/sh"),
        ["-c", &script],
        Duration::from_secs(30),
        1024,
        &cancel,
    );
    canceller.join().unwrap();
    assert_eq!(result.unwrap_err(), RunError::Cancelled);
    drop(ws);
    // The writer was killed with its process group, so nothing recreates the workspace.
    thread::sleep(Duration::from_millis(200));
    assert!(!dir.exists(), "{dir:?} still exists or was recreated");
}

// @req TST-002
#[test]
fn modifying_a_golden_fixture_fails_the_test() {
    let golden = common::TempDir::new("fake-golden");
    fs::write(golden.0.join("sample.txt"), "original").unwrap();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut ws = Workspace::with_golden("guard", &golden.0);
        ws.copy("sample.txt");
        // A buggy test (or app) writing to the golden instead of the copy.
        fs::write(golden.0.join("sample.txt"), "changed").unwrap();
    }));
    let message = result.unwrap_err();
    let message = message
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_default();
    assert!(message.contains("golden fixture"), "{message}");
}

// @req TST-002
#[test]
fn assertions_detect_changed_copies_and_unexpected_outputs() {
    let mut ws = Workspace::new("assertions");
    let copy = ws.copy("plain.txt");
    let before = ws.files();
    ws.expect_unchanged(&copy);
    ws.expect_no_new_outputs(&before);

    // ExifTool's default backup name: an unexpected output for a read-only operation.
    fs::write(format!("{}_original", copy.display()), "backup").unwrap();
    let stray = catch_unwind(AssertUnwindSafe(|| ws.expect_no_new_outputs(&before)));
    assert!(stray.is_err());

    fs::write(&copy, "edited").unwrap();
    assert!(catch_unwind(AssertUnwindSafe(|| ws.expect_unchanged(&copy))).is_err());
}

// @req TST-002, OPS-001
#[test]
fn evidence_records_what_makes_a_result_reproducible() {
    let out = common::TempDir::new("evidence");
    let engine = Engine::new();
    engine.write_evidence(&out.0);
    let files: Vec<_> = fs::read_dir(&out.0)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1);
    let record: serde_json::Value = serde_json::from_slice(&fs::read(&files[0]).unwrap()).unwrap();
    assert_eq!(record["suite"], "harness");
    assert_eq!(
        record["test"],
        "evidence_records_what_makes_a_result_reproducible"
    );
    assert_eq!(record["status"], "passed");
    assert_eq!(record["exiftool"]["version"], engine.tool.version.as_str());
    let sums = common::harness::golden_dir().join("SHA256SUMS");
    assert_eq!(record["fixtureVersion"], sha256(&sums).as_str());
    assert!(record["platform"]
        .as_str()
        .unwrap()
        .starts_with(std::env::consts::OS));
    assert!(record["timestamp"].as_u64().unwrap() > 1_700_000_000);
}
