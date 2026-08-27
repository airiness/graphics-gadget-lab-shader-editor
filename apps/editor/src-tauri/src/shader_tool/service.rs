//! The ShaderToolService — the product implementation of the declared
//! host boundary (design §9), exactly four capabilities:
//!
//! ```text
//! discover(config)            → candidate facts + per-rule failure reasons
//! handshake(candidate)        → the settlement (raw output — or the
//!                               structured pre-spawn refusal)
//! compile(candidate, request) → buildId + the same settlement when it
//!                               settles
//! cancel(buildId)             → the explicit canceled state of that build
//! ```
//!
//! and the host-internal work behind them, in order:
//!
//! - **allowance** — the request is one of the allowlisted shapes in the
//!   declared shape (structured refusal when it is not — the service has
//!   no other answer to a malformed request);
//! - **serialization** — an APPROVED request becomes the tool's
//!   invocation, structural arguments only, no shell string, no policy:
//!   the grammar is the tool's (the main repository's accepted command
//!   line), and THIS crate merely maps the request facts onto it;
//! - **execution** — the provenance guard runs FIRST (never a spawn of an
//!   unverified executable), then bounded execution (budget, per-attempt
//!   cancel, whole-stream capture);
//! - **staging** — the private per-attempt area the delivered emission is
//!   staged into, owned by the service, visible to nobody outside it but
//!   its name.
//!
//! What is not here: protocol interpretation (no envelope parsing, no
//! status vocabulary, no version comparison, no diagnostic
//! classification — the raw output surface is the ENTIRE output),
//! readiness logic (the service cannot be asked whether a request is a
//! good one — that is decided above it), graph or profile knowledge, and
//! any argv in any TypeScript-facing surface.

use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use super::discovery::discover as discover_core;
use super::error::ServiceError;
use super::execution::{run_bounded, ExecutionBudget, SpawnError};
use super::provenance::{verify_and_hold, GuardRefusal};
use super::staging::ToolchainRoots;
use super::types::{
    BoundaryResult, BuildId, CancelOutcome, CandidateObservation, DiscoverOutcome, DiscoverRequest,
    NativeCompileRequest, ToolCandidate,
};

/// The service state, shared across the (few) async command tasks:
/// the private roots, the execution budgets, the attempt sequence, and
/// the in-flight cancel flags (one per running compile attempt).
pub struct ShaderToolService {
    roots: ToolchainRoots,
    handshake_budget: ExecutionBudget,
    compile_budget: ExecutionBudget,
    service_executable_dir: Option<std::path::PathBuf>,
    next_build_id: AtomicU64,
    /// Single-flight for discovery: held for the (cheap) discovery walk,
    /// released after — the rule, not a scheduler.
    discovery_gate: std::sync::Mutex<()>,
    /// The in-flight compile attempts and their cancel flags — shared
    /// with the settlement threads by an owned `Arc`; every access is a
    /// short synchronous step.
    in_flight: Arc<std::sync::Mutex<std::collections::HashMap<u64, Arc<AtomicBool>>>>,
}

/// A compile attempt admitted by the service: its identity, and the
/// settlement it will produce (joined by the caller — the Tauri command
/// forwards it to the UI's channel; the tests join it directly).
pub struct CompileAttempt {
    pub build_id: BuildId,
    pub settle: std::thread::JoinHandle<BoundaryResult>,
}

impl std::fmt::Debug for CompileAttempt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The settlement handle is an OS thread: reporting its ID is the
        // honest amount of detail; its payload is the attempt's result,
        // not format metadata.
        f.debug_struct("CompileAttempt")
            .field("build_id", &self.build_id)
            .field("settle", &std::thread::current().id())
            .finish()
    }
}

impl ShaderToolService {
    /// Production configuration: the host data location, the service
    /// budgets (host policy), and the service's own executable location
    /// (the `bundled` discovery rule's expected directory).
    pub fn production() -> Self {
        let (handshake_budget, compile_budget) = ExecutionBudget::service_budgets();
        let service_executable_dir = std::env::current_exe()
            .ok()
            .map(|exe| exe.parent().map(|dir| dir.to_path_buf()))
            .flatten();
        Self {
            roots: ToolchainRoots::from_host_environment(),
            handshake_budget,
            compile_budget,
            service_executable_dir,
            next_build_id: AtomicU64::new(1),
            discovery_gate: std::sync::Mutex::new(()),
            in_flight: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    /// Test / fixture configuration: roots under a caller-chosen
    /// directory, explicit (tight) budgets, and an explicit
    /// `bundled`-rule location. A test seam; not reachable from the
    /// production surface.
    #[allow(dead_code)]
    pub fn for_test(
        roots: ToolchainRoots,
        handshake_budget: ExecutionBudget,
        compile_budget: ExecutionBudget,
        service_executable_dir: Option<std::path::PathBuf>,
    ) -> Self {
        Self {
            roots,
            handshake_budget,
            compile_budget,
            service_executable_dir,
            next_build_id: AtomicU64::new(1),
            discovery_gate: std::sync::Mutex::new(()),
            in_flight: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    /// `discover`: bookkeeping only — it neither executes the tool nor
    /// interprets any of its output. Single-flight by construction: one
    /// session, one in-flight discovery (the lock is the rule, not a
    /// scheduling system).
    pub fn discover(&self, request: &DiscoverRequest) -> DiscoverOutcome {
        // The lock is the single-flight rule itself: discovery is light
        // bookkeeping, and it needs no scheduling system of its own.
        let _flight = self.discovery_gate.lock().expect("no panic path holds the discovery gate");
        discover_core(request, self.service_executable_dir.as_deref())
    }

    /// `handshake`: the provenance guard runs FIRST, then bounded
    /// execution, and the settlement is always a value:
    ///
    /// - guard refused  → `candidate-invalidated` (the structured
    ///   observation: changed / missing / unreadable — changed carries
    ///   the current identity for re-discovery);
    /// - spawn failed   → `launch-failed` (a fact, not a crash);
    /// - executed       → `spawned` with the raw output surface.
    pub fn handshake(&self, candidate: &ToolCandidate) -> BoundaryResult {
        let guard_result = verify_and_hold(&candidate.tool_path, &candidate.observation_identity);
        match guard_result {
            Err(GuardRefusal::Changed { current_identity }) => {
                return BoundaryResult::CandidateInvalidated {
                    candidate: candidate.clone(),
                    observation: CandidateObservation::Changed,
                    observed_identity: Some(current_identity),
                };
            }
            Err(GuardRefusal::Missing) => {
                return BoundaryResult::CandidateInvalidated {
                    candidate: candidate.clone(),
                    observation: CandidateObservation::Missing,
                    observed_identity: None,
                };
            }
            Err(GuardRefusal::Unreadable) => {
                return BoundaryResult::CandidateInvalidated {
                    candidate: candidate.clone(),
                    observation: CandidateObservation::Unreadable,
                    observed_identity: None,
                };
            }
            Err(GuardRefusal::Unsupported) => {
                // Not the toolchain's platform: no check possible, no
                // spawn allowed — the honest structured fact.
                return BoundaryResult::LaunchFailed {
                    candidate: candidate.clone(),
                };
            }
            Ok(guard) => {
                // `describe` is the tool's zero-argument machine
                // self-description command — no options, no content, no
                // policy: the service adds nothing and owns nothing here.
                let args = vec!["describe".to_string()];
                let executable = std::path::PathBuf::from(&candidate.tool_path);
                let outcome =
                    run_bounded(&executable, &args, self.handshake_budget, None);
                // The guard is dropped HERE — after the spawn settled.
                // Until that line, the path was held fixed.
                drop(guard);
                match outcome {
                    Ok(output) => BoundaryResult::Spawned { output },
                    Err(SpawnError { source: _ }) => BoundaryResult::LaunchFailed {
                        candidate: candidate.clone(),
                    },
                }
            }
        }
    }

    /// `compile` (admit): validation of the allowlisted shape, allocation
    /// of the attempt's identity, staging of the delivered emission into
    /// the attempt's private area, and admission of the attempt's
    /// settlement as a task. The settlement is produced by: guard →
    /// invocation serialization → bounded execution → per-attempt staging
    /// cleanup.
    pub fn compile(
        &self,
        candidate: &ToolCandidate,
        request: &NativeCompileRequest,
    ) -> Result<CompileAttempt, ServiceError> {
        validate_request(request)?;
        let sequence = self.next_build_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.roots
            .write_attempt_source(sequence, &request.source_identity, &request.source)
            .map_err(|err| ServiceError::Host {
                detail: format!("staging failed: {err}"),
            })?;

        let build_id = BuildId { sequence };
        let candidate = candidate.clone();
        let request = request.clone();
        let executable = std::path::PathBuf::from(&candidate.tool_path);

        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut in_flight = self.in_flight.lock().expect("no panic path holds the registry");
            in_flight.insert(sequence, Arc::clone(&cancel));
        }

        let roots = self.roots.clone();
        let compile_budget = self.compile_budget;
        let in_flight = Arc::clone(&self.in_flight);
        let settle = std::thread::spawn(move || {
            let result = settle_compile(
                &candidate,
                &executable,
                &request,
                sequence,
                roots.clone(),
                compile_budget,
                Arc::clone(&cancel),
            );
            // The attempt is settled: its staging area is cleaned, its
            // registry slot released, its artifact evidence kept.
            roots.clean_attempt_staging(sequence);
            in_flight.lock().expect("no panic path holds the registry").remove(&sequence);
            result
        });

        Ok(CompileAttempt { build_id, settle })
    }

    /// `cancel`: always a value. The flag is set (the in-flight task ends
    /// as `canceled`), the attempt was already settled (no state change —
    /// cancel is an action, not a fact about the tool), or neither
    /// (an unknown identity reports the structured unknown).
    pub fn cancel(&self, build_id: BuildId) -> CancelOutcome {
        let in_flight = self.in_flight.lock().expect("no panic path holds the registry");
        match in_flight.get(&build_id.sequence) {
            Some(flag) => {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                CancelOutcome {
                    build_id,
                    canceled: true,
                    already_settled: false,
                }
            }
            None => CancelOutcome {
                build_id,
                canceled: false,
                already_settled: true,
            },
        }
    }
}

/// Admission-time validation of the allowlisted shape — the only place
/// the service may refuse a compile request, and the refusal it gives is
/// structured (the field, and why).
fn validate_request(request: &NativeCompileRequest) -> Result<(), ServiceError> {
    fn field(field: &str, detail: &str) -> ServiceError {
        ServiceError::RequestShape {
            field: field.to_string(),
            detail: detail.to_string(),
        }
    }
    if request.source.is_empty() {
        return Err(field("source", "the emitted bytes are required"));
    }
    if request.source_identity.len() != 64
        || !request.source_identity.chars().all(|ch| ch.is_ascii_hexdigit())
    {
        return Err(field(
            "sourceIdentity",
            "the durable source identity is the 64-hex SHA-256 of the exact bytes",
        ));
    }
    if request.target.trim().is_empty() {
        return Err(field("target", "the target wire name is required"));
    }
    if request.stage.trim().is_empty() {
        return Err(field("stage", "the stage is required"));
    }
    if request.entry.trim().is_empty() {
        return Err(field("entry", "the entry function name is required"));
    }
    for define in &request.defines {
        if define.name.trim().is_empty() {
            return Err(field("defines", "each define carries a name"));
        }
    }
    Ok(())
}

/// The invocation serialization — host-internal by contract, and it owns
/// the tool's grammar: the main repository's accepted command line for
/// `compile` (structural arguments, no shell string, no backend policy —
/// `gglab-shaderc compile --source-root <dir> --source <name> --stage <s>
/// --entry <e> --target <t> [--define NAME[=VALUE]]... [--include <dir>]...
/// [--cache-root <dir>] [--artifact-root <dir>] --result-format json`).
/// The tool emits the machine
/// document through its JSON channel, which is exactly what this
/// boundary reports back — the service still does not read it.
fn serialize_compile(
    roots: &ToolchainRoots,
    sequence: u64,
    request: &NativeCompileRequest,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    args.push("compile".to_string());
    args.push("--source-root".to_string());
    args.push(roots.attempt_staging(sequence).to_string_lossy().into_owned());
    args.push("--source".to_string());
    args.push(format!("{}.hlsl", request.source_identity));
    args.push("--stage".to_string());
    args.push(request.stage.clone());
    args.push("--entry".to_string());
    args.push(request.entry.clone());
    args.push("--target".to_string());
    args.push(request.target.clone());
    for define in &request.defines {
        args.push("--define".to_string());
        args.push(if define.value.is_empty() {
            define.name.clone()
        } else {
            format!("{}={}", define.name, define.value)
        });
    }
    for include in &request.includes {
        args.push("--include".to_string());
        args.push(include.clone());
    }
    args.push("--cache-root".to_string());
    args.push(roots.cache_root().to_string_lossy().into_owned());
    args.push("--artifact-root".to_string());
    args.push(roots.attempt_artifacts(sequence).to_string_lossy().into_owned());
    // The machine channel — the service's internal choice of wire mode;
    // the client's readers still do all the interpretation.
    args.push("--result-format".to_string());
    args.push("json".to_string());
    args
}

/// The attempt's settlement: guard first, then invocation, then bounded
/// execution under its cancel flag, and finally the per-attempt staging
/// cleanup.
fn settle_compile(
    candidate: &ToolCandidate,
    executable: &std::path::Path,
    request: &NativeCompileRequest,
    sequence: u64,
    roots: ToolchainRoots,
    compile_budget: ExecutionBudget,
    cancel: Arc<AtomicBool>,
) -> BoundaryResult {
    let guard = verify_and_hold(&candidate.tool_path, &candidate.observation_identity);
    let guard = match guard {
        Err(GuardRefusal::Changed { current_identity }) => {
            return BoundaryResult::CandidateInvalidated {
                candidate: candidate.clone(),
                observation: CandidateObservation::Changed,
                observed_identity: Some(current_identity),
            };
        }
        Err(GuardRefusal::Missing) => {
            return BoundaryResult::CandidateInvalidated {
                candidate: candidate.clone(),
                observation: CandidateObservation::Missing,
                observed_identity: None,
            };
        }
        Err(GuardRefusal::Unreadable) => {
            return BoundaryResult::CandidateInvalidated {
                candidate: candidate.clone(),
                observation: CandidateObservation::Unreadable,
                observed_identity: None,
            };
        }
        Err(GuardRefusal::Unsupported) => {
            return BoundaryResult::LaunchFailed {
                candidate: candidate.clone(),
            };
        }
        Ok(guard) => guard,
    };
    let args = serialize_compile(&roots, sequence, request);
    let outcome = run_bounded(executable, &args, compile_budget, Some(Arc::clone(&cancel)));
    // The guard is dropped here — after the spawn settled.
    drop(guard);
    match outcome {
        Ok(output) => BoundaryResult::Spawned { output },
        Err(SpawnError { source: _ }) => BoundaryResult::LaunchFailed {
            candidate: candidate.clone(),
        },
    }
}
