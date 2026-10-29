//! The shared process runner: bounds, independent streams, and prompt return on timeout.

use exifbee_lib::adapter::exiftool::process::{run, RunError};
use std::path::Path;
use std::time::{Duration, Instant};

const SH: &str = "/bin/sh";

fn sh(script: &str, timeout: Duration, max_output: usize) -> Result<Vec<Vec<u8>>, RunError> {
    run(Path::new(SH), ["-c", script], timeout, max_output)
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
            64
        ),
        Err(RunError::Launch(_))
    ));
}
