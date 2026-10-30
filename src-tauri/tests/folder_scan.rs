//! Folder scans (S3-T02): options, symlink policy, loops, cancellation and a 10,000-file tree.
//! Mixed-format results are read with the real ExifTool.

mod common;

use common::harness::{Engine, Workspace};
use common::TempDir;
use exifbee_lib::adapter::exiftool::process::CancelToken;
use exifbee_lib::service::files::FileRegistry;
use exifbee_lib::service::scan::{
    scan, ScanCounts, ScanOptions, ScanState, ScanUpdate, UPDATE_INTERVAL,
};
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

struct Scanned {
    updates: Vec<ScanUpdate>,
    registry: FileRegistry,
}

impl Scanned {
    fn last(&self) -> &ScanUpdate {
        self.updates.last().unwrap()
    }
    /// Added paths relative to `root`, in the order the scan reported them.
    fn added(&self, root: &Path) -> Vec<String> {
        let added = self.updates.iter().flat_map(|update| &update.added);
        added
            .map(|file| file.path.strip_prefix(root.to_str().unwrap()).unwrap()[1..].to_string())
            .collect()
    }
    fn problems(&self, root: &Path) -> Vec<(String, String)> {
        let problems = self.updates.iter().flat_map(|update| &update.problems);
        problems
            .map(|p| {
                let path = p
                    .path
                    .strip_prefix(root.to_str().unwrap())
                    .unwrap_or(&p.path);
                (path.trim_start_matches('/').to_string(), p.reason.clone())
            })
            .collect()
    }
}

/// Runs a scan with the app's update interval on another thread; see [`run_every`].
fn run(root: &Path, options: ScanOptions, cancel_after: Option<usize>) -> Scanned {
    run_every(root, options, cancel_after, UPDATE_INTERVAL)
}

/// Runs a scan on another thread and fails instead of hanging if it takes over 60 s. With
/// `cancel_after`, the scan is stopped once that many updates have arrived.
fn run_every(
    root: &Path,
    options: ScanOptions,
    cancel_after: Option<usize>,
    interval: Duration,
) -> Scanned {
    let (root, (sender, receiver)) = (root.to_path_buf(), mpsc::channel());
    std::thread::spawn(move || {
        let (registry, cancel, mut updates) = (Mutex::default(), CancelToken::default(), vec![]);
        if cancel_after == Some(0) {
            cancel.cancel();
        }
        scan(7, &root, &options, &cancel, &registry, interval, |update| {
            updates.push(update);
            if cancel_after == Some(updates.len()) {
                cancel.cancel();
            }
        });
        let registry = registry.into_inner().unwrap();
        sender.send(Scanned { updates, registry }).unwrap();
    });
    receiver
        .recv_timeout(Duration::from_secs(60))
        .expect("scan finished")
}

fn counts(added: u32, duplicates: u32, filtered: u32, skipped: u32) -> ScanCounts {
    ScanCounts {
        added,
        duplicates,
        filtered,
        skipped,
    }
}

fn write(root: &Path, relative: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, relative).unwrap();
}

// @req FR-004, TST-002
#[test]
fn scans_mixed_formats_recursively_and_every_found_file_reads_like_the_cli() {
    let engine = Engine::new();
    let mut ws = Workspace::new("scan-mixed");
    for (fixture, name) in [
        ("metadata.jpg", "photo.jpg"),
        ("metadata.pdf", "docs/-report.pdf"),
        ("movie.mp4", "docs/clips/movie.mp4"),
        ("archive.zip", "docs/clips/archive.zip"),
        ("unknown.dat", "مرحبا/no extension"),
        ("plain.txt", ".hidden/notes.txt"),
        ("sidecar.xmp", ".sidecar.xmp"),
    ] {
        ws.copy_as(fixture, name);
    }
    let before = ws.files();

    let scanned = run(ws.path(), ScanOptions::default(), None);
    // Breadth-first, each folder sorted by name; hidden file and hidden folder left out.
    assert_eq!(
        scanned.added(ws.path()),
        [
            "photo.jpg",
            "docs/-report.pdf",
            "مرحبا/no extension",
            "docs/clips/archive.zip",
            "docs/clips/movie.mp4",
        ]
    );
    assert_eq!(scanned.last().state, ScanState::Complete);
    assert_eq!(scanned.last().counts, counts(5, 0, 2, 0));
    assert_eq!(scanned.last().scan_id, 7);

    let files = scanned.updates.iter().flat_map(|update| &update.added);
    for file in files {
        let path = scanned.registry.path(&file.id).unwrap();
        let unknown = file.name == "no extension";
        assert_eq!(
            engine.expect_read_matches_cli(path),
            Some(i32::from(unknown)),
            "{}",
            file.path
        );
        ws.expect_unchanged(path);
    }
    ws.expect_no_new_outputs(&before);
}

// @req FR-021
#[test]
fn recursion_hidden_files_and_extension_filters_follow_the_options() {
    let dir = TempDir::new("scan-options");
    for name in [
        "a.JPG",
        "b.jpeg",
        "c.pdf",
        "d",
        ".e.jpg",
        "sub/f.jpg",
        ".git/g.jpg",
    ] {
        write(&dir.0, name);
    }
    let options = |change: fn(&mut ScanOptions)| {
        let mut options = ScanOptions::default();
        change(&mut options);
        options.normalized()
    };

    let flat = run(&dir.0, options(|o| o.recursive = false), None);
    assert_eq!(flat.added(&dir.0), ["a.JPG", "b.jpeg", "c.pdf", "d"]);
    assert_eq!(flat.last().counts, counts(4, 0, 2, 0));

    let hidden = run(&dir.0, options(|o| o.include_hidden = true), None);
    assert_eq!(
        hidden.added(&dir.0),
        [
            ".e.jpg",
            "a.JPG",
            "b.jpeg",
            "c.pdf",
            "d",
            ".git/g.jpg",
            "sub/f.jpg"
        ]
    );

    let only_jpeg = options(|o| o.include_extensions = vec![" .JPG".into(), "jpeg".into()]);
    assert_eq!(only_jpeg.include_extensions, ["jpg", "jpeg"]);
    let scanned = run(&dir.0, only_jpeg, None);
    assert_eq!(scanned.added(&dir.0), ["a.JPG", "b.jpeg", "sub/f.jpg"]);
    // c.pdf and d by extension, .e.jpg and .git by the hidden rule.
    assert_eq!(scanned.last().counts, counts(3, 0, 4, 0));

    let no_jpg = options(|o| o.exclude_extensions = vec!["Jpg".into(), "".into(), "jpg".into()]);
    assert_eq!(no_jpg.exclude_extensions, ["jpg"]);
    assert_eq!(
        run(&dir.0, no_jpg, None).added(&dir.0),
        ["b.jpeg", "c.pdf", "d"]
    );

    let too_many = options(|o| o.include_extensions = (0..500).map(|n| n.to_string()).collect());
    assert_eq!(too_many.include_extensions.len(), 100);
}

// @req FR-021, SEC-006
#[test]
fn links_outside_the_folder_are_skipped_visibly_unless_followed_and_loops_never_hang() {
    let dir = TempDir::new("scan-links");
    let (root, outside) = (dir.0.join("root"), dir.0.join("outside"));
    write(&outside, "secret.jpg");
    write(&outside, "deep/more.jpg");
    write(&root, "a.jpg");
    write(&root, "sub/b.jpg");
    symlink(&root, root.join("sub/loop")).unwrap(); // back to the root
    symlink(root.join("sub"), root.join("sub/self")).unwrap(); // to its own folder
    symlink(root.join("a.jpg"), root.join("alias.jpg")).unwrap(); // same file, inside
    symlink(outside.join("secret.jpg"), root.join("out-file.jpg")).unwrap();
    symlink(&outside, root.join("out-dir")).unwrap();
    symlink(root.join("gone"), root.join("broken")).unwrap();

    let scanned = run(&root, ScanOptions::default(), None);
    assert_eq!(scanned.last().state, ScanState::Complete);
    assert_eq!(scanned.added(&root), ["a.jpg", "sub/b.jpg"]);
    let already = "folder already scanned through another path (link or loop)";
    let outside_policy = "link points outside the folder (not followed)";
    assert_eq!(
        scanned.problems(&root),
        [
            ("broken", "broken link"),
            ("out-dir", outside_policy),
            ("out-file.jpg", outside_policy),
            ("sub/loop", already),
            ("sub/self", already),
        ]
        .map(|(path, reason)| (path.to_string(), reason.to_string()))
    );
    // alias.jpg is a.jpg again: one duplicate, not a second entry.
    assert_eq!(scanned.last().counts, counts(2, 1, 0, 5));

    let followed = run(
        &root,
        ScanOptions {
            follow_outside_links: true,
            ..ScanOptions::default()
        },
        None,
    );
    // out-dir/secret.jpg is the same file as out-file.jpg, so it counts as a duplicate.
    assert_eq!(
        followed.added(&root),
        [
            "a.jpg",
            "out-file.jpg",
            "sub/b.jpg",
            "out-dir/deep/more.jpg"
        ]
    );
    assert_eq!(followed.last().counts, counts(4, 2, 0, 3));
}

// @req NFR-001, FR-004
#[test]
fn a_10k_file_tree_streams_in_timed_updates_and_a_stop_reports_honest_partial_counts() {
    let dir = TempDir::new("scan-10k");
    for folder in 0..100 {
        for file in 0..100 {
            write(&dir.0, &format!("{folder:03}/{file:03}.jpg"));
        }
    }

    let started = Instant::now();
    let complete = run(&dir.0, ScanOptions::default(), None);
    let elapsed = started.elapsed();
    assert_eq!(complete.last().state, ScanState::Complete);
    assert_eq!(complete.last().counts, counts(10_000, 0, 0, 0));
    // Updates go by time, not by count, so a fast scan cannot flood the UI.
    let ceiling = (elapsed.as_millis() / UPDATE_INTERVAL.as_millis()) as usize + 2;
    assert!(
        complete.updates.len() <= ceiling,
        "{} updates",
        complete.updates.len()
    );
    let running = &complete.updates[..complete.updates.len() - 1];
    assert!(running
        .iter()
        .all(|update| update.state == ScanState::Running));
    let added = complete
        .updates
        .iter()
        .map(|update| update.added.len())
        .sum::<usize>();
    assert_eq!(added, 10_000);
    eprintln!("scanned 10,000 files in {elapsed:?}");
    assert!(elapsed < Duration::from_secs(30), "{elapsed:?}");

    // Stopped after the first update: what was added stays added, and the counts say so.
    let stopped = run_every(&dir.0, ScanOptions::default(), Some(1), Duration::ZERO);
    let last = stopped.last();
    assert_eq!(last.state, ScanState::Cancelled);
    assert!(
        last.counts.added > 0 && last.counts.added < 10_000,
        "{:?}",
        last.counts
    );
    let reported = stopped
        .updates
        .iter()
        .map(|update| update.added.len())
        .sum::<usize>();
    assert_eq!(reported, last.counts.added as usize);
    for file in stopped.updates.iter().flat_map(|update| &update.added) {
        assert!(stopped.registry.path(&file.id).is_some());
    }

    let before_start = run(&dir.0, ScanOptions::default(), Some(0));
    assert_eq!(before_start.updates.len(), 1);
    assert_eq!(before_start.last().state, ScanState::Cancelled);
    assert_eq!(before_start.last().counts, counts(0, 0, 0, 0));
}

// @req FR-004, NFR-004
#[test]
fn unreadable_folders_special_files_and_a_missing_root_are_reported_not_fatal() {
    let dir = TempDir::new("scan-problems");
    write(&dir.0, "ok.jpg");
    write(&dir.0, "locked/hidden-from-us.jpg");
    fs::set_permissions(dir.0.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    let fifo = dir.0.join("pipe");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());

    let scanned = run(&dir.0, ScanOptions::default(), None);
    assert_eq!(scanned.last().state, ScanState::Complete);
    assert_eq!(scanned.added(&dir.0), ["ok.jpg"]);
    let problems = scanned.problems(&dir.0);
    assert_eq!(problems[0], ("pipe".into(), "not a regular file".into()));
    assert_eq!(problems[1].0, "locked");
    assert!(
        problems[1].1.starts_with("folder not readable: "),
        "{problems:?}"
    );
    assert_eq!(scanned.last().counts, counts(1, 0, 0, 2));

    let missing = run(&dir.0.join("missing"), ScanOptions::default(), None);
    assert_eq!(missing.updates.len(), 1);
    assert_eq!(missing.last().state, ScanState::Failed);
    assert!(missing.last().problems[0]
        .reason
        .starts_with("cannot scan: "));
    let file = run(&dir.0.join("ok.jpg"), ScanOptions::default(), None);
    assert_eq!(file.last().state, ScanState::Failed);
    assert_eq!(file.last().problems[0].reason, "cannot scan: not a folder");
}
