//! Background read jobs (S3-T03): batched reads with the real ExifTool, per-file summaries,
//! failure isolation, and the queue's batching, stop and failure behavior.

mod common;

use common::harness::{Engine, Workspace};
use common::{fake_executable, TempDir};
use exifbee_lib::adapter::exiftool::process::CancelToken;
use exifbee_lib::adapter::exiftool::read::READ_BATCH;
use exifbee_lib::service::reads::{
    drain, summarize, ReadCounts, ReadQueue, ReadState, ReadSummary,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

fn batch(paths: &[PathBuf]) -> Vec<(String, PathBuf)> {
    let ids = (1..).map(|n| format!("f{n}"));
    ids.zip(paths.iter().cloned()).collect()
}

// @req FR-005, NFR-004, TST-002
#[test]
fn one_batched_read_summarizes_every_file_and_corrupt_files_hide_no_healthy_one() {
    let engine = Engine::new();
    let mut ws = Workspace::new("read-job-mixed");
    let mut paths: Vec<PathBuf> = [
        "metadata.jpg",
        "metadata.pdf",
        "archive.zip",
        "plain.txt",
        "movie.mp4",
        "sidecar.xmp",
        "truncated.jpg",
        "empty.bin",
        "unknown.dat",
    ]
    .iter()
    .map(|name| ws.copy(name))
    .collect();
    let read_only = ws.copy_as("metadata.png", "read-only.png");
    fs::set_permissions(&read_only, fs::Permissions::from_mode(0o444)).unwrap();
    paths.push(read_only.clone());
    let vanished = ws.path().join("vanished.jpg");
    paths.push(vanished.clone());
    let before = ws.files();

    let results = summarize(&engine.tool, &batch(&paths), &CancelToken::default()).unwrap();
    let ids: Vec<_> = results.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, (1..=11).map(|n| format!("f{n}")).collect::<Vec<_>>());

    let outcome = |r: &ReadSummary| (r.file_type.clone(), r.error.clone(), !r.warnings.is_empty());
    let text = |s: &str| Some(s.to_string());
    // Only the unknown format is "unsupported"; empty, truncated and missing files are not.
    let unsupported: Vec<_> = results
        .iter()
        .filter(|r| r.unsupported)
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(unsupported, ["f9"]);
    assert_eq!(
        results.iter().map(outcome).collect::<Vec<_>>(),
        [
            (text("JPEG"), None, false),
            (text("PDF"), None, false),
            (text("ZIP"), None, false),
            (text("TXT"), None, false),
            (text("MP4"), None, false),
            (text("XMP"), None, false),
            (text("JPEG"), None, true), // truncated: a warning, still read
            (None, text("File is empty"), false),
            (None, text("Unknown file type"), false),
            (text("PNG"), None, false), // read-only files read normally
            (
                None,
                text(&format!("Error: File not found - {}", vanished.display())),
                false
            ),
        ]
    );

    // Each summary belongs to its own file: its tag count equals that file's single read.
    for (summary, path) in results.iter().zip(&paths).take(10) {
        assert_eq!(
            summary.tag_count as usize,
            engine.read(path).tags.len(),
            "{path:?}"
        );
    }
    // The non-image and the read-only file show their own format groups, not just File/System.
    for (path, group) in [(&paths[1], "PDF"), (&read_only, "PNG")] {
        let read = engine.read(path);
        assert!(read.tags.iter().any(|tag| tag.group1 == group), "{path:?}");
    }
    assert_eq!(
        fs::metadata(&read_only).unwrap().permissions().mode() & 0o777,
        0o444
    );
    for path in paths.iter().take(10) {
        ws.expect_unchanged(path);
    }
    ws.expect_no_new_outputs(&before);
}

// @req FR-017, NFR-004
#[test]
fn a_batch_that_fails_as_a_whole_is_split_until_only_the_bad_file_fails() {
    let engine = Engine::new();
    let mut ws = Workspace::new("read-job-poison");
    let dir = TempDir::new("read-job-poison-tool");
    let runs = dir.0.join("runs");
    // Wraps the real ExifTool, but prints garbage whenever poison.jpg is among its files.
    let script = format!(
        r#"echo run >> '{runs}'
for arg; do case "$arg" in */poison.jpg) echo 'not json'; exit 2;; esac; done
exec '{real}' "$@""#,
        runs = runs.display(),
        real = engine.tool.path.display(),
    );
    let mut tool = engine.tool.clone();
    tool.path = fake_executable(&dir.0, "exiftool", &script);

    let paths: Vec<PathBuf> = (0..7)
        .map(|n| match n {
            4 => ws.copy_as("metadata.jpg", "poison.jpg"),
            n => ws.copy_as("metadata.png", &format!("ok-{n}.png")),
        })
        .collect();
    let results = summarize(&tool, &batch(&paths), &CancelToken::default()).unwrap();

    assert_eq!(results.len(), 7);
    for (n, summary) in results.iter().enumerate() {
        if n == 4 {
            let error = summary.error.as_deref().unwrap();
            assert!(error.starts_with("unexpected ExifTool output"), "{error}");
        } else {
            assert_eq!(summary.file_type.as_deref(), Some("PNG"), "file {n}");
            assert_eq!(summary.error, None);
        }
    }
    // 7 → 3 + 4 → 3 healthy at once, 4 → 2 + 2 → poison's pair → 1 + 1: seven runs, not one per file
    // times retries; a split never re-reads a half that already succeeded.
    let runs = fs::read_to_string(runs).unwrap().lines().count();
    assert_eq!(runs, 7, "{runs} runs");
}

/// Runs [`drain`] on a thread, sending each update back.
fn spawn_drain(
    queue: &Arc<Mutex<ReadQueue>>,
    tool: Result<exifbee_lib::adapter::exiftool::resolver::ExifTool, String>,
) -> mpsc::Receiver<exifbee_lib::service::reads::ReadUpdate> {
    let (sender, receiver) = mpsc::channel();
    let queue = Arc::clone(queue);
    std::thread::spawn(move || drain(&queue, tool, |update| sender.send(update).unwrap()));
    receiver
}

// @req NFR-002, FR-005
#[test]
fn the_queue_reads_in_bounded_batches_and_a_stop_keeps_the_counts_honest() {
    let engine = Engine::new();
    let mut ws = Workspace::new("read-job-queue");
    let paths: Vec<PathBuf> = (0..250)
        .map(|n| ws.copy_as("metadata.jpg", &format!("{n:03}.jpg")))
        .collect();
    let next =
        |receiver: &mpsc::Receiver<_>| receiver.recv_timeout(Duration::from_secs(60)).unwrap();

    let queue = Arc::new(Mutex::new(ReadQueue::default()));
    assert!(queue.lock().unwrap().enqueue(batch(&paths)));
    // A second import while the worker is due joins the same run instead of starting another.
    assert!(!queue.lock().unwrap().enqueue(batch(&paths[..0])));
    let updates = spawn_drain(&queue, Ok(engine.tool.clone()));
    let mut seen = Vec::new();
    loop {
        let update = next(&updates);
        let state = update.state;
        seen.push(update);
        if state != ReadState::Running {
            break;
        }
    }
    let sizes: Vec<_> = seen.iter().map(|u| u.results.len()).collect();
    assert_eq!(sizes, [READ_BATCH, READ_BATCH, 50, 0]);
    let complete = seen.last().unwrap();
    assert_eq!(complete.state, ReadState::Complete);
    assert_eq!(
        complete.counts,
        ReadCounts {
            done: 250,
            total: 250,
            errors: 0,
            warnings: 0,
            unsupported: 0,
        }
    );
    let ids: Vec<_> = seen
        .iter()
        .flat_map(|u| &u.results)
        .map(|r| r.id.clone())
        .collect();
    assert_eq!(
        ids,
        batch(&paths)
            .into_iter()
            .map(|(id, _)| id)
            .collect::<Vec<_>>()
    );

    // Stop during the second batch: the killed batch is not counted, and files queued after the
    // stop are read in a fresh run instead of being lost.
    assert!(queue.lock().unwrap().enqueue(batch(&paths)));
    let updates = spawn_drain(&queue, Ok(engine.tool.clone()));
    let first = next(&updates);
    assert_eq!(first.counts.done, 100);
    {
        let mut queue = queue.lock().unwrap();
        assert!(queue.cancel());
        assert!(!queue.enqueue(batch(&paths[..5])));
    }
    let stopped = next(&updates);
    assert_eq!(stopped.state, ReadState::Cancelled);
    assert!(
        [100, 200].contains(&stopped.counts.done),
        "{:?}",
        stopped.counts
    );
    assert_eq!(stopped.counts.total, 250);
    let fresh = next(&updates);
    assert_eq!(fresh.results.len(), 5);
    let fresh_end = next(&updates);
    assert_eq!(fresh_end.state, ReadState::Complete);
    assert_eq!(
        fresh_end.counts,
        ReadCounts {
            done: 5,
            total: 5,
            errors: 0,
            warnings: 0,
            unsupported: 0,
        }
    );
    assert!(!queue.lock().unwrap().cancel(), "idle after the run");
}

// @req NFR-004
#[test]
fn without_a_usable_exiftool_the_run_fails_once_and_the_queue_resets() {
    let queue = Arc::new(Mutex::new(ReadQueue::default()));
    let paths = [PathBuf::from("/nowhere/a.jpg")];
    assert!(queue.lock().unwrap().enqueue(batch(&paths)));
    let updates = spawn_drain(&queue, Err("ExifTool was not found".into()));
    let failed = updates.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(failed.state, ReadState::Failed);
    assert_eq!(failed.message.as_deref(), Some("ExifTool was not found"));
    assert_eq!(failed.counts.total, 1);
    assert!(
        updates.recv_timeout(Duration::from_secs(1)).is_err(),
        "exactly one update"
    );
    assert!(
        queue.lock().unwrap().enqueue(batch(&paths)),
        "a later import starts a new run"
    );
}

// @req NFR-002, FR-005
#[test]
fn rows_in_view_are_read_next_and_unknown_ids_change_nothing() {
    let engine = Engine::new();
    let mut ws = Workspace::new("read-job-priority");
    let paths: Vec<PathBuf> = (0..300)
        .map(|n| ws.copy_as("metadata.png", &format!("{n:03}.png")))
        .collect();
    let queue = Arc::new(Mutex::new(ReadQueue::default()));
    {
        let mut queue = queue.lock().unwrap();
        assert!(queue.enqueue(batch(&paths)));
        // The user scrolled to the end of the list: those rows jump the queue, in list order.
        let wanted = ["f298", "f300", "f299", "no-such-id"]
            .map(String::from)
            .into();
        queue.prioritize(&wanted);
    }
    let updates = spawn_drain(&queue, Ok(engine.tool.clone()));
    let first = updates.recv_timeout(Duration::from_secs(60)).unwrap();
    let ids: Vec<_> = first.results.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(&ids[..4], ["f298", "f299", "f300", "f1"]);
    assert_eq!(ids.len(), READ_BATCH);
    // Everything is still read exactly once.
    let mut seen: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
    loop {
        let update = updates.recv_timeout(Duration::from_secs(60)).unwrap();
        seen.extend(update.results.iter().map(|r| r.id.clone()));
        if update.state != ReadState::Running {
            assert_eq!(update.counts.done, 300);
            break;
        }
    }
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 300);
}
