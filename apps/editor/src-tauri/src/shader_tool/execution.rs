//! Bounded execution — the boundary's whole execution job:
//!
//! - a budget (a timeout), a cancel flag, and nothing else;
//! - BOTH streams captured whole (or until the budget / cancel ends the
//!   attempt) — the raw bytes, and never an interpretation of them;
//! - the exit code plus the `timed_out` / `canceled` state;
//! - a spawn that could not even be attempted is a `SpawnError` the
//!   service settles as the structured `launch-failed` fact.
//!
//! Deliberately NOT here: the argv serialization of a domain request
//! (that owns the tool's grammar — see `service.rs`), the provenance
//! guard (see `provenance.rs`), and every byte of protocol meaning (the
//! client's readers, across the boundary).
//!
//! The runtime is plain std (process + threads), not an async scheduler:
//! a bounded child is a blocking concern, and this boundary owns the
//! settlement of one process at a time per attempt. Nothing about the
//! shape of the settlement depends on the runtime; only the plumbing
//! does.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::types::BoundaryOutput;

/// The execution budget for one attempt — host policy, internal to the
/// host (design §9 implementation clause): a handshake budget and a
/// compile budget, constants of the service, not client configuration.
#[derive(Debug, Clone, Copy)]
pub struct ExecutionBudget {
    pub timeout: Duration,
}

impl ExecutionBudget {
    /// The service's production budgets: a short machine handshake, and a
    /// production compile that may be real.
    pub const fn service_budgets() -> (Self, Self) {
        (
            Self { timeout: Duration::from_secs(30) },
            Self { timeout: Duration::from_secs(120) },
        )
    }
    /// A tight budget — the test seam, so the timeout behavior is
    /// observable in milliseconds rather than seconds.
    #[allow(dead_code)]
    pub const fn for_test(timeout: Duration) -> Self {
        Self { timeout }
    }
}

/// The outcome of a spawn that could not be attempted at all (the OS
/// would not even create the process). The service settles this as the
/// structured `launch-failed` fact — a fact, not a crash; no OS error
/// code crosses the boundary inside it.
#[derive(Debug)]
pub struct SpawnError {
    pub source: std::io::Error,
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "spawn: {}", self.source)
    }
}

impl std::error::Error for SpawnError {}

impl std::convert::From<std::io::Error> for SpawnError {
    fn from(source: std::io::Error) -> Self {
        Self { source }
    }
}

enum Ended {
    Done(std::process::ExitStatus),
    TimedOut,
    Canceled,
    WaitFailed(std::io::Error),
}

/// Execute `executable` with `args` (structural arguments — the caller
/// serialized them; no shell string is ever accepted anywhere in this
/// crate) under a budget, blocking until the settlement is known, and
/// returning the ENTIRE output surface.
///
/// `cancel` is the service's per-attempt cancel flag (a compile attempt
/// carries one; a handshake does not — cancel is an explicit per-build
/// operation, and handshakes have no BuildId). Flag set — or the budget
/// expiring — ends the attempt: the child is killed, the already-captured
/// bytes are still reported, and the end state is the fact (`canceled`
/// or `timed_out`), never an error.
pub fn run_bounded(
    executable: &std::path::Path,
    args: &[String],
    budget: ExecutionBudget,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<BoundaryOutput, SpawnError> {
    let mut child = std::process::Command::new(executable)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;

    // Both streams are read whole, on their own threads: a child that
    // ignores one pipe cannot stall the capture of the other, and a
    // budget or cancel is a fact about the child, not a failure of the
    // capture.
    let stdout = child.stdout.take().expect("stdout was piped at spawn");
    let stderr = child.stderr.take().expect("stderr was piped at spawn");
    let stdout_thread = std::thread::spawn(move || read_all_bytes(stdout));
    let stderr_thread = std::thread::spawn(move || read_all_bytes(stderr));
    // After the pipes are taken, the child struct owns only the process —
    // which is all try_wait / kill / wait need.

    let deadline = Instant::now() + budget.timeout;
    let ended = loop {
        // The child's own exit settles the attempt; the cancel flag and
        // the clock are observed, in that order, on every pass.
        match child.try_wait() {
            Ok(None) => {}
            Ok(Some(status)) => break Ended::Done(status),
            Err(err) => break Ended::WaitFailed(err),
        }
        if let Some(flag) = cancel.as_ref() {
            if flag.load(Ordering::SeqCst) {
                break Ended::Canceled;
            }
        }
        if Instant::now() >= deadline {
            break Ended::TimedOut;
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    match ended {
        Ended::Done(status) => Ok(BoundaryOutput {
            stdout: stdout_thread.join().unwrap_or_default(),
            stderr: stderr_thread.join().unwrap_or_default(),
            exit_code: status.code().unwrap_or(-1),
            timed_out: false,
            canceled: false,
        }),
        Ended::Canceled => Ok(end_forced(&mut child, stdout_thread, stderr_thread, false)),
        Ended::TimedOut => Ok(end_forced(&mut child, stdout_thread, stderr_thread, true)),
        Ended::WaitFailed(err) => Err(SpawnError { source: err }),
    }
}

/// A forced end (cancel or timeout): kill, reap, and report what was
/// captured — the end state is the fact the client reads, and the bytes
/// that landed before the end are still the bytes that happened.
fn end_forced(
    child: &mut std::process::Child,
    stdout_thread: std::thread::JoinHandle<Vec<u8>>,
    stderr_thread: std::thread::JoinHandle<Vec<u8>>,
    timed_out: bool,
) -> BoundaryOutput {
    let _ = child.kill();
    let status = child.wait();
    BoundaryOutput {
        stdout: stdout_thread.join().unwrap_or_default(),
        stderr: stderr_thread.join().unwrap_or_default(),
        // The end was forced — the child never exited on its own, so no
        // exit code of its own is reported; the end state carries the
        // meaning.
        exit_code: status.ok().and_then(|status| status.code()).unwrap_or(-1),
        timed_out,
        canceled: !timed_out,
    }
}

fn read_all_bytes<R>(mut reader: R) -> Vec<u8>
where
    R: std::io::Read,
{
    let mut out = Vec::new();
    let _ = std::io::Read::read_to_end(&mut reader, &mut out);
    out
}
