//! The isolated executor (S2-T03, SEC-007): the single way ExifBee runs an executable. Validated
//! path, separate OS arguments, no shell (SEC-002); bounded time and output; cancellable; and it
//! never leaves the child, its descendants, or a zombie behind.

use std::ffi::OsStr;
use std::fmt;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(10);

#[derive(Debug)]
pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// The program could not be started (missing, not executable) or waiting on it failed.
    Launch(String),
    Timeout(Duration),
    OutputTooLarge(usize),
    /// The caller's [`CancelToken`] was triggered, before or during the run.
    Cancelled,
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Launch(message) => write!(f, "could not start: {message}"),
            Self::Timeout(after) => write!(f, "did not finish within {} s", after.as_secs_f32()),
            Self::OutputTooLarge(limit) => write!(f, "printed more than {limit} bytes"),
            Self::Cancelled => write!(f, "was cancelled"),
        }
    }
}

/// Lets another thread stop a run: cheap to clone, shared by clones. A job (S5) hands one to each
/// ExifTool invocation and calls [`CancelToken::cancel`] when the user presses Cancel; the
/// executor notices within one poll interval (10 ms) and terminates the process group.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Runs `program args...` to completion within `timeout` and `max_output` bytes per stream,
/// unless `cancel` fires first. Returns exit status and raw output; a non-zero exit is *not* an
/// error here (ExifTool exits 1 with valid JSON for per-file errors), callers interpret it.
///
/// Flow:
/// 1. Cancelled already → `Cancelled` without spawning (cancel-before-start, FR-018).
/// 2. Spawn with stdin closed, in its **own process group** (Unix), so killing the group also
///    kills anything the child started.
/// 3. One thread drains stdout and one stderr, so a chatty child never blocks on a full pipe;
///    reading `max_output + 1` bytes flags overflow.
/// 4. Poll every 10 ms for cancel / overflow / timeout / exit. Exit is detected *without reaping*
///    the child (`waitid` + `WNOWAIT`).
/// 5. Exit or failure: kill the whole group, then reap the child. Because the child is still an
///    unreaped zombie when the group is signalled, its pid (= the group id) cannot have been
///    reused, so the kill can never hit an unrelated process. Leftover background descendants are
///    removed even when the child itself exited normally.
/// 6. Collect stream output with a deadline, so a process that escaped the group (`setsid`)
///    while holding a pipe cannot hang the caller.
///
/// Cleanup is also guaranteed on unwinding: a drop guard kills and reaps the child.
///
/// Not applied: OS memory/CPU limits (`setrlimit`). ExifTool's memory needs scale with the file,
/// so a hard cap would cause false failures; output caps and batching bound memory instead
/// (NFR-002). Windows (S8) only kills the direct child until job objects are added.
///
/// Example: `run(exiftool, ["-ver"], Duration::from_secs(10), 64 * 1024, &CancelToken::default())`.
pub fn run<I, S>(
    program: &Path,
    args: I,
    timeout: Duration,
    max_output: usize,
    cancel: &CancelToken,
) -> Result<Output, RunError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    if cancel.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = Guard(Some(
        command
            .spawn()
            .map_err(|error| RunError::Launch(error.to_string()))?,
    ));

    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = collect(child.get().stdout.take(), max_output, &overflow);
    let stderr = collect(child.get().stderr.take(), max_output, &overflow);

    let started = Instant::now();
    let outcome = loop {
        if cancel.is_cancelled() {
            break Err(RunError::Cancelled);
        }
        if overflow.load(Ordering::SeqCst) {
            break Err(RunError::OutputTooLarge(max_output));
        }
        if started.elapsed() >= timeout {
            break Err(RunError::Timeout(timeout));
        }
        match has_exited(child.get()) {
            Ok(true) => break Ok(()),
            Ok(false) => thread::sleep(POLL),
            Err(error) => break Err(RunError::Launch(error)),
        }
    };

    let status = child.finish();
    outcome?;
    let status = status.map_err(|error| RunError::Launch(error.to_string()))?;
    // Every writer is gone after the group kill; the grace period only matters if a descendant
    // escaped the group while holding a pipe.
    let grace = timeout
        .saturating_sub(started.elapsed())
        .max(Duration::from_secs(1));
    let deadline = Instant::now() + grace;
    let stdout = receive(&stdout, deadline).ok_or(RunError::Timeout(timeout))?;
    let stderr = receive(&stderr, deadline).ok_or(RunError::Timeout(timeout))?;
    if overflow.load(Ordering::SeqCst) {
        return Err(RunError::OutputTooLarge(max_output));
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Owns the child until it is reaped; dropping it (normally or while unwinding) terminates the
/// process group and reaps, so no path leaves a running process or a zombie.
struct Guard(Option<Child>);

impl Guard {
    fn get(&mut self) -> &mut Child {
        self.0.as_mut().expect("child already reaped")
    }

    /// Kills the process group (and the child), then reaps the child and returns its status.
    fn finish(&mut self) -> std::io::Result<ExitStatus> {
        let mut child = self.0.take().expect("child already reaped");
        kill_group(&mut child);
        child.wait()
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if self.0.is_some() {
            let _ = self.finish();
        }
    }
}

/// Signals the child's whole process group. Safe because it runs before the child is reaped.
#[cfg(unix)]
fn kill_group(child: &mut Child) {
    let Ok(group) = libc::pid_t::try_from(child.id()) else {
        let _ = child.kill();
        return;
    };
    // SAFETY: `kill` takes plain integers; a negative pid addresses the group the child leads
    // (spawned with `process_group(0)`). ESRCH (nothing left) is fine and ignored.
    unsafe {
        libc::kill(-group, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(child: &mut Child) {
    let _ = child.kill();
}

/// Whether the child has exited, without reaping it (so its pid stays reserved).
#[cfg(unix)]
fn has_exited(child: &mut Child) -> Result<bool, String> {
    let pid = libc::id_t::from(child.id());
    // SAFETY: a zeroed `siginfo_t` is a valid out-parameter for `waitid`.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: valid pointer to `info`; WNOHANG never blocks, WNOWAIT leaves the child waitable.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // SAFETY: after a successful `waitid`, `si_pid` is initialized (0 means still running).
    Ok(unsafe { info.si_pid() } != 0)
}

#[cfg(not(unix))]
fn has_exited(child: &mut Child) -> Result<bool, String> {
    // shortcut: try_wait reaps, so the group-before-reap ordering does not apply off Unix;
    // S8 replaces this with a Windows job object that also covers descendants.
    child
        .try_wait()
        .map(|status| status.is_some())
        .map_err(|error| error.to_string())
}

/// Drains one pipe on its own thread, keeping at most `max_output` bytes, and sends the bytes
/// when the pipe closes. Reading `max_output + 1` bytes is how overflow is detected; the shared
/// flag lets [`run`] stop the child promptly instead of waiting for it to finish writing.
fn collect(
    pipe: Option<impl Read + Send + 'static>,
    max_output: usize,
    overflow: &Arc<AtomicBool>,
) -> Receiver<Vec<u8>> {
    let overflow = Arc::clone(overflow);
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = pipe {
            let _ = pipe.take(max_output as u64 + 1).read_to_end(&mut bytes);
        }
        if bytes.len() > max_output {
            overflow.store(true, Ordering::SeqCst);
            bytes.truncate(max_output);
        }
        let _ = send.send(bytes);
    });
    receive
}

fn receive(stream: &Receiver<Vec<u8>>, deadline: Instant) -> Option<Vec<u8>> {
    stream
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()
}
