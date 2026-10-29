//! The single way ExifBee runs an executable: validated path, separate OS arguments, no shell
//! (SPEC §4.4, SEC-002), with a timeout and an output limit.

use std::ffi::OsStr;
use std::fmt;
use std::io::Read;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    Launch(String),
    Timeout(Duration),
    OutputTooLarge(usize),
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Launch(message) => write!(f, "could not start: {message}"),
            Self::Timeout(after) => write!(f, "did not finish within {} s", after.as_secs_f32()),
            Self::OutputTooLarge(limit) => write!(f, "printed more than {limit} bytes"),
        }
    }
}

/// Runs `program args...` with stdin closed; stdout and stderr are read on their own threads so
/// a chatty child never blocks on a full pipe. The child is killed on timeout or when either
/// stream exceeds `max_output` bytes.
// shortcut: no cancellation token, streaming events or process-group kill (a grandchild that
// keeps the pipes open is abandoned, not killed); S2-T03 builds the full isolated executor.
pub fn run<I, S>(
    program: &Path,
    args: I,
    timeout: Duration,
    max_output: usize,
) -> Result<Output, RunError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| RunError::Launch(error.to_string()))?;

    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = collect(child.stdout.take(), max_output, &overflow);
    let stderr = collect(child.stderr.take(), max_output, &overflow);

    let started = Instant::now();
    let status = loop {
        let failure = if overflow.load(Ordering::Relaxed) {
            Some(RunError::OutputTooLarge(max_output))
        } else if started.elapsed() >= timeout {
            Some(RunError::Timeout(timeout))
        } else {
            None
        };
        if let Some(error) = failure {
            let _ = child.kill();
            let _ = child.wait();
            // Reader threads are detached: they end when the last pipe writer exits.
            return Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Launch(error.to_string()));
            }
        }
    };

    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if overflow.load(Ordering::Relaxed) {
        return Err(RunError::OutputTooLarge(max_output));
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn collect(
    pipe: Option<impl Read + Send + 'static>,
    max_output: usize,
    overflow: &Arc<AtomicBool>,
) -> JoinHandle<Vec<u8>> {
    let overflow = Arc::clone(overflow);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = pipe {
            let _ = pipe.take(max_output as u64 + 1).read_to_end(&mut bytes);
        }
        if bytes.len() > max_output {
            overflow.store(true, Ordering::Relaxed);
            bytes.truncate(max_output);
        }
        bytes
    })
}
