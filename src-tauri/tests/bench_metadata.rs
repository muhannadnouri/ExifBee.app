//! Performance baseline scenarios (S3-T06, NFR-006, TST-005), run by `npm run bench:metadata`
//! (tests/performance/run.mjs), one scenario per process so peak memory belongs to it alone.
//! Ignored in normal test runs: they take minutes and their numbers depend on the machine.
//!
//! Each scenario writes `<EXIFBEE_BENCH_OUT>/<scenario>.json`: millisecond samples per metric and
//! the process's peak RSS plus the largest ExifTool child's peak RSS (both from `getrusage`).

mod common;

use common::harness::{golden_dir, Engine};
use common::TempDir;
use exifbee_lib::adapter::exiftool::process::CancelToken;
use exifbee_lib::service::files::FileRegistry;
use exifbee_lib::service::reads::{drain, ReadQueue, ReadState};
use exifbee_lib::service::scan::{scan, ScanOptions, ScanState, UPDATE_INTERVAL};
use serde_json::{json, Map, Value};
use std::fs;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;

/// Samples (ms) per metric, written out as one JSON report.
#[derive(Default)]
struct Report(Map<String, Value>);

impl Report {
    fn sample(&mut self, metric: &str, ms: f64) {
        let entry = self.0.entry(metric).or_insert_with(|| json!([]));
        entry
            .as_array_mut()
            .unwrap()
            .push(json!((ms * 100.0).round() / 100.0));
    }

    fn write(self, scenario: &str, extra: Value) {
        let Some(out) = std::env::var_os("EXIFBEE_BENCH_OUT") else {
            panic!("set EXIFBEE_BENCH_OUT (run through `npm run bench:metadata`)");
        };
        let report = json!({
            "scenario": scenario,
            "samplesMs": self.0,
            "peakRssKiB": max_rss(libc::RUSAGE_SELF),
            "exiftoolPeakRssKiB": max_rss(libc::RUSAGE_CHILDREN),
            "extra": extra,
        });
        let path = Path::new(&out).join(format!("{scenario}.json"));
        fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
}

/// Peak resident memory in KiB (Linux reports `ru_maxrss` in KiB): of this process, or of the
/// largest child it has waited for.
fn max_rss(who: libc::c_int) -> i64 {
    let mut usage = unsafe { std::mem::zeroed::<libc::rusage>() };
    // SAFETY: `usage` is a valid, writable rusage for the call.
    assert_eq!(unsafe { libc::getrusage(who, &mut usage) }, 0);
    usage.ru_maxrss
}

/// A folder on the build's disk, not the system temp folder: that is often tmpfs, which has no
/// page cache to evict, so "cold" reads would be warm. Removed when dropped.
fn bench_dir(scenario: &str) -> TempDir {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("bench-{scenario}"));
    fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

/// `count` files in folders of 100, as copies of the fixture corpus in turn (JPEG, PNG, PDF, XMP,
/// ZIP, MP4, text, empty, truncated, unknown…), so reads see the real mix of formats and errors.
fn mixed_files(dir: &Path, count: usize) -> Vec<PathBuf> {
    let corpus: Vec<String> = fs::read_to_string(golden_dir().join("SHA256SUMS"))
        .unwrap()
        .lines()
        .map(|line| line.split_once("  ").unwrap().1.to_string())
        .collect();
    (0..count)
        .map(|n| {
            let fixture = &corpus[n % corpus.len()];
            let folder = dir.join(format!("{:03}", n / 100));
            fs::create_dir_all(&folder).unwrap();
            let path = folder.join(format!("{n:05}-{fixture}"));
            fs::copy(golden_dir().join(fixture), &path).unwrap();
            path
        })
        .collect()
}

/// Drops the files' data from the page cache (`POSIX_FADV_DONTNEED` after a sync), so the next
/// read comes from the disk: a cold read without root. ExifTool's own modules stay cached.
/// Fails if the first file (a non-empty fixture) is still in memory, rather than report a cold
/// figure that was not cold.
fn evict(paths: &[PathBuf]) {
    // SAFETY: plain syscalls on descriptors that stay open for the call.
    unsafe { libc::sync() };
    for path in paths {
        let file = fs::File::open(path).unwrap();
        let fd = file.as_raw_fd();
        assert_eq!(
            unsafe { libc::posix_fadvise(fd, 0, 0, libc::POSIX_FADV_DONTNEED) },
            0
        );
    }
    let resident = Command::new("fincore")
        .args(["--noheadings", "--bytes", "--output", "RES"])
        .arg(&paths[0])
        .output()
        .expect("fincore (util-linux) runs");
    let resident = String::from_utf8_lossy(&resident.stdout);
    assert_eq!(resident.trim(), "0", "{:?} is still cached", paths[0]);
}

fn millis(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn bench_scan(scenario: &str, count: usize, runs: usize) {
    let dir = bench_dir(scenario);
    for n in 0..count {
        let folder = dir.0.join(format!("{:03}", n / 100));
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join(format!("{n:05}.jpg")), b"x").unwrap();
    }
    let mut report = Report::default();
    let mut updates = 0;
    for _ in 0..runs {
        let registry = Mutex::new(FileRegistry::default());
        let started = Instant::now();
        updates = 0;
        scan(
            1,
            &dir.0,
            &ScanOptions::default(),
            &CancelToken::default(),
            &registry,
            UPDATE_INTERVAL,
            |update| {
                updates += 1;
                assert_ne!(update.state, ScanState::Failed);
            },
        );
        report.sample("scanTotal", millis(started));
    }
    report.write(scenario, json!({ "entries": count, "updates": updates }));
}

/// Reads `count` mixed files through the app's real path (queue + worker, 100 files per ExifTool
/// run), `cold` runs with the files evicted from the page cache first, then `warm` runs.
fn bench_read(scenario: &str, count: usize, cold: usize, warm: usize) {
    let engine = Engine::new();
    let dir = bench_dir(scenario);
    let paths = mixed_files(&dir.0, count);
    let files: Vec<(String, PathBuf)> = paths
        .iter()
        .enumerate()
        .map(|(n, path)| (format!("f{n}"), path.clone()))
        .collect();
    let mut report = Report::default();
    for run in 0..cold + warm {
        let kind = if run < cold { "cold" } else { "warm" };
        if run < cold {
            evict(&paths);
        }
        let queue = Mutex::new(ReadQueue::default());
        assert!(queue.lock().unwrap().enqueue(files.clone()));
        let started = Instant::now();
        let mut first_progress = None;
        let mut done = 0;
        drain(&queue, Ok(engine.tool.clone()), |update| {
            if update.state == ReadState::Running {
                first_progress.get_or_insert_with(|| millis(started));
            }
            done = update.counts.done;
        });
        assert_eq!(done as usize, count);
        let total = millis(started);
        report.sample(&format!("read{}Total", capitalized(kind)), total);
        report.sample(
            &format!("read{}FirstProgress", capitalized(kind)),
            first_progress.unwrap_or(f64::NAN),
        );
        report.sample(
            &format!("read{}PerFile", capitalized(kind)),
            total / count as f64,
        );
    }
    report.write(
        scenario,
        json!({
            "files": count,
            "exiftool": engine.tool.version,
            "exiftoolPath": engine.tool.path,
            "batch": 100,
        }),
    );
}

fn capitalized(word: &str) -> String {
    word[..1].to_uppercase() + &word[1..]
}

// @req NFR-006, NFR-003, TST-005
#[test]
#[ignore = "benchmark: run with npm run bench:metadata"]
fn scan_1k() {
    bench_scan("scan_1k", 1_000, 7);
}

// @req NFR-006, NFR-003, TST-005
#[test]
#[ignore = "benchmark: run with npm run bench:metadata"]
fn scan_10k() {
    bench_scan("scan_10k", 10_000, 5);
}

// @req NFR-006, NFR-002, TST-005
#[test]
#[ignore = "benchmark: run with npm run bench:metadata"]
fn read_1k() {
    bench_read("read_1k", 1_000, 5, 5);
}

// @req NFR-006, NFR-002, TST-005
#[test]
#[ignore = "benchmark: run with npm run bench:metadata"]
fn read_10k() {
    bench_read("read_10k", 10_000, 2, 2);
}
