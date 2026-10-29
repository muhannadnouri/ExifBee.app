//! The shared process runner: bounds, independent streams, and prompt return on timeout.

use exifbee_lib::adapter::exiftool::process::{run, CancelToken, RunError};
use std::path::Path;
use std::time::{Duration, Instant};

const SH: &str = "/bin/sh";

fn sh(script: &str, timeout: Duration, max_output: usize) -> Result<Vec<Vec<u8>>, RunError> {
    run(
        Path::new(SH),
        ["-c", script],
        timeout,
        max_output,
        &CancelToken::default(),
    )
    .map(|output| vec![output.stdout, output.stderr])
}

// @req SEC-002, NFR-004
#[test]
fn stdout_and_stderr_are_captured_independently_with_exit_status() {
    let output = run(
        Path::new(SH),
        ["-c", "printf out; printf err >&2; exit 4"],
        Duration::from_secs(5),
        1024,
        &CancelToken::default(),
    )
    .unwrap();
    assert_eq!(output.status.code(), Some(4));
    assert_eq!(output.stdout, b"out");
    assert_eq!(output.stderr, b"err");
}

// @req SEC-002
#[test]
fn oversized_output_is_stopped() {
    let started = Instant::now();
    assert_eq!(
        sh(
            "head -c 1000000 /dev/zero; sleep 30",
            Duration::from_secs(20),
            1000
        ),
        Err(RunError::OutputTooLarge(1000))
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

// @req SEC-002
#[test]
fn timeout_returns_promptly_even_if_a_grandchild_keeps_the_pipes_open() {
    // A compound script stops shells from exec-ing `sleep`, so a grandchild holds the pipes.
    let started = Instant::now();
    assert_eq!(
        sh("sleep 30; :", Duration::from_millis(200), 1024),
        Err(RunError::Timeout(Duration::from_millis(200)))
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

// @req SEC-002
#[test]
fn missing_program_is_a_launch_error() {
    assert!(matches!(
        run(
            Path::new("/nonexistent/exiftool"),
            ["-ver"],
            Duration::from_secs(1),
            64,
            &CancelToken::default()
        ),
        Err(RunError::Launch(_))
    ));
}

mod common;
use common::TempDir;
use std::fs;
use std::thread;

/// `true` while `pid` is a live (non-zombie) process; polls briefly because a killed process is
/// reaped asynchronously by whichever process adopts it.
fn still_running(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let state = fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|stat| stat.rsplit(')').next().map(|rest| rest.trim().to_string()));
        match state {
            None => return false,
            Some(rest) if rest.starts_with('Z') => return false,
            Some(_) if Instant::now() >= deadline => return true,
            Some(_) => thread::sleep(Duration::from_millis(20)),
        }
    }
}

fn read_pid(path: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(pid) = text.trim().parse() {
                return pid;
            }
        }
        assert!(Instant::now() < deadline, "no pid written to {path:?}");
        thread::sleep(Duration::from_millis(10));
    }
}

// @req SEC-007, FR-018
#[test]
fn a_cancelled_token_stops_the_run_before_anything_is_spawned() {
    let dir = TempDir::new("cancel-before");
    let marker = dir.0.join("ran");
    let cancel = CancelToken::default();
    cancel.cancel();
    let result = run(
        Path::new(SH),
        ["-c", &format!("touch '{}'", marker.display())],
        Duration::from_secs(5),
        1024,
        &cancel,
    );
    assert_eq!(result.unwrap_err(), RunError::Cancelled);
    assert!(
        !marker.exists(),
        "nothing may run after cancel-before-start"
    );
}

// @req SEC-007, FR-018
#[test]
fn cancelling_in_progress_kills_the_child_and_its_descendants_promptly() {
    let dir = TempDir::new("cancel-during");
    let (child_pid, background_pid) = (dir.0.join("child.pid"), dir.0.join("bg.pid"));
    let script = format!(
        "echo $$ > '{}'; sleep 30 & echo $! > '{}'; wait",
        child_pid.display(),
        background_pid.display()
    );
    let cancel = CancelToken::default();
    let trigger = cancel.clone();
    let canceller = thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        trigger.cancel();
    });

    let started = Instant::now();
    let result = run(
        Path::new(SH),
        ["-c", &script],
        Duration::from_secs(30),
        1024,
        &cancel,
    );
    canceller.join().unwrap();
    assert_eq!(result.unwrap_err(), RunError::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(3));
    // The direct child was reaped (no zombie) and its background sleep was killed with it.
    assert!(!still_running(read_pid(&child_pid)));
    assert!(!still_running(read_pid(&background_pid)));
}

// @req SEC-007
#[test]
fn a_timeout_leaves_no_child_zombie_or_descendant_behind() {
    let dir = TempDir::new("timeout-cleanup");
    let (child_pid, background_pid) = (dir.0.join("child.pid"), dir.0.join("bg.pid"));
    let script = format!(
        "echo $$ > '{}'; sleep 30 & echo $! > '{}'; wait",
        child_pid.display(),
        background_pid.display()
    );
    let result = run(
        Path::new(SH),
        ["-c", &script],
        Duration::from_millis(300),
        1024,
        &CancelToken::default(),
    );
    assert_eq!(
        result.unwrap_err(),
        RunError::Timeout(Duration::from_millis(300))
    );
    assert!(!still_running(read_pid(&child_pid)));
    assert!(!still_running(read_pid(&background_pid)));
}

// @req SEC-007
#[test]
fn a_child_that_exits_normally_cannot_leave_a_pipe_holding_descendant_running() {
    // The child prints and exits at once, but its background sleep inherited stdout; before
    // S2-T03 the read would have waited the full 30 s for that pipe to close.
    let dir = TempDir::new("leftover");
    let background_pid = dir.0.join("bg.pid");
    let script = format!(
        "sleep 30 & echo $! > '{}'; echo done",
        background_pid.display()
    );
    let started = Instant::now();
    let output = run(
        Path::new(SH),
        ["-c", &script],
        Duration::from_secs(20),
        1024,
        &CancelToken::default(),
    )
    .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(output.stdout, b"done\n");
    assert!(!still_running(read_pid(&background_pid)));
}
