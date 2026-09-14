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
//! The life is split at the process-creation boundary on purpose:
//! `spawn` is where the provenance guard must still be alive (it closes
//! the check-to-launch window), and it is DROPPED the instant the
//! process is created — the guard never holds the path through the
//! process's working life (a rebuild of the tool must not be impossible
//! while a compile runs). `bounded_wait` then owns budget, cancel, and
//! capture on the running child.
//!
//! The runtime is plain std (process + threads), not an async scheduler:
//! a bounded child is a blocking concern, and nothing about the shape of
//! the settlement depends on the runtime; only the plumbing does.

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

/// A created process with its two streams already being captured —
/// the state between a successful spawn and the settlement.
pub struct RunningChild {
    child: std::process::Child,
    stdout_reader: std::thread::JoinHandle<Vec<u8>>,
    stderr_reader: std::thread::JoinHandle<Vec<u8>>,
}

/// Create the process with both pipes taken and their reader threads
/// running. This is the call the provenance guard must span — and the
/// call after which the guard may go immediately: the launch HAS
/// happened by the time this returns.
pub(crate) fn spawn_in(executable: &std::path::Path, args: &[String], working_directory: Option<&std::path::Path>) -> Result<RunningChild, SpawnError> {
    let mut command = std::process::Command::new(executable);
    if let Some(directory) = working_directory { command.current_dir(directory); }
    #[cfg(windows)]
    if working_directory.is_some() { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command
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
    Ok(RunningChild {
        child,
        stdout_reader: std::thread::spawn(move || read_all_bytes(stdout)),
        stderr_reader: std::thread::spawn(move || read_all_bytes(stderr)),
    })
}

impl RunningChild {
    /// Wait for the settlement under a budget, observing the cancel
    /// flag. The end state is the fact (`canceled` / `timed_out`), never
    /// an error: a budget or cancel ends the child (kill, reap) and
    /// reports what was captured; the child's own exit reports its own
    /// exit code and bytes, verbatim.
    ///
    /// A failure of the OS WAIT on a child that IS running is not a
    /// launch failure — the spawn already happened. It is an execution
    /// fact: the child is terminated and reaped, and the settlement is
    /// the captured bytes plus the reaped status, with neither end flag
    /// set. The client reads that settlement as malformed; the host
    /// has reported only things that happened.
    pub fn bounded_wait(mut self, budget: ExecutionBudget, cancel: Option<Arc<AtomicBool>>) -> BoundaryOutput {
        enum Pass {
            Exited(std::io::Result<std::process::ExitStatus>),
            Canceled,
            TimedOut,
        }
        // The child's own exit settles the attempt; the cancel flag and
        // the clock are observed, in that order, on every pass.
        let deadline = Instant::now() + budget.timeout;
        let outcome = loop {
            match self.child.try_wait() {
                Ok(Some(status)) => break Pass::Exited(Ok(status)),
                Ok(None) => {}
                Err(err) => break Pass::Exited(Err(err)),
            }
            if let Some(flag) = cancel.as_ref() {
                if flag.load(Ordering::SeqCst) {
                    break Pass::Canceled;
                }
            }
            if Instant::now() >= deadline {
                break Pass::TimedOut;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let timed_out = matches!(outcome, Pass::TimedOut);

        match outcome {
            Pass::Exited(Ok(status)) => BoundaryOutput {
                stdout: self.stdout_reader.join().unwrap_or_default(),
                stderr: self.stderr_reader.join().unwrap_or_default(),
                exit_code: status.code().unwrap_or(-1),
                timed_out: false,
                canceled: false,
            },
            Pass::Exited(Err(_wait_error)) => {
                // Wait failed on a child that IS running: terminate and
                // reap, and report the reaped facts.
                let _ = self.child.kill();
                let status = self.child.wait();
                BoundaryOutput {
                    stdout: self.stdout_reader.join().unwrap_or_default(),
                    stderr: self.stderr_reader.join().unwrap_or_default(),
                    // The reap may or may not yield an exit code; a
                    // forced end never fabricates one.
                    exit_code: status.ok().and_then(|s| s.code()).unwrap_or(-1),
                    timed_out: false,
                    canceled: false,
                }
            }
            Pass::Canceled | Pass::TimedOut => {
                let _ = self.child.kill();
                let _ = self.child.wait();
                // Whatever landed before the end is still the bytes that
                // happened; the end state is the fact.
                BoundaryOutput {
                    stdout: self.stdout_reader.join().unwrap_or_default(),
                    stderr: self.stderr_reader.join().unwrap_or_default(),
                    exit_code: -1,
                    timed_out,
                    canceled: !timed_out,
                }
            }
        }
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
