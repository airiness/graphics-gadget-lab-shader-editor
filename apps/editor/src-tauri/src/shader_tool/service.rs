//! The ShaderToolService — the product implementation of the declared
//! host boundary (design §9 plus the approved Preview Milestone B extension),
//! exactly six capabilities:
//!
//! ```text
//! discover(config)            → candidate facts + per-rule failure reasons
//! handshake(candidate)        → the settlement (raw output — or the
//!                               structured pre-spawn refusal)
//! preview_handshake(candidate) → the dedicated Preview settlement
//! compile(candidate, request) → buildId + the same settlement when it
//!                               settles
//! build_preview(candidate, request) → buildId + Preview settlement
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
use super::execution::{spawn, ExecutionBudget, SpawnError};
use super::provenance::{verify_and_hold, GuardRefusal};
use super::staging::ToolchainRoots;
use super::types::{
    BoundaryResult, BuildId, CancelOutcome, CandidateObservation, DiscoverOutcome, DiscoverRequest,
    NativeCompileRequest, NativePreviewBuildRequest, ToolCandidate,
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
    /// The host's **allowance** step, on its own: the allowlisted request
    /// shape, judged exactly as the client package's
    /// `isWellFormedRequest` declares it (the client is the authority;
    /// this is its mirror). A value either way — the shape verdict, or
    /// the structured refusal naming the same field.
    pub fn validate_request(request: &NativeCompileRequest) -> Result<(), ServiceError> {
        validate_request(request)
    }

    /// The host-side mirror of the client's dedicated Preview request shape.
    /// This is allowance only; no profile, target, or descriptor compatibility
    /// judgment belongs in the service.
    pub fn validate_preview_request(
        request: &NativePreviewBuildRequest,
    ) -> Result<(), ServiceError> {
        validate_preview_request(request)
    }

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
        self.execute_handshake(candidate, "describe")
    }

    /// The dedicated zero-side-effect Preview handshake. It is a distinct
    /// operation, but it has the same provenance and bounded-execution
    /// guarantees as ordinary `describe`; its bytes remain uninterpreted.
    pub fn preview_handshake(&self, candidate: &ToolCandidate) -> BoundaryResult {
        self.execute_handshake(candidate, "describe-preview")
    }

    fn execute_handshake(&self, candidate: &ToolCandidate, command: &str) -> BoundaryResult {
        let guard_result = verify_and_hold(&candidate.tool_path, &candidate.observation_identity);
        match guard_result {
            Err(refusal) => guard_refusal(refusal, candidate),
            Ok(guard) => {
                // Both describe operations take no options, content, or
                // policy: the service selects only the allowlisted command.
                let args = vec![command.to_string()];
                let executable = std::path::PathBuf::from(&candidate.tool_path);
                let child = match spawn(&executable, &args) {
                    Ok(child) => child,
                    Err(SpawnError { source: _ }) => {
                        // The process-creation itself could not be
                        // attempted — the guard releases with the scope.
                        return BoundaryResult::LaunchFailed {
                            candidate: candidate.clone(),
                        };
                    }
                };
                // The process EXISTS now — the guard released the path
                // the instant creation settled. A rebuild may replace
                // the binary while this spawn runs; that is intended.
                drop(guard);
                BoundaryResult::Spawned {
                    output: child.bounded_wait(self.handshake_budget, None),
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

    /// `build-preview` admission mirrors `compile` mechanically while keeping
    /// the product distinct: validate the Preview value, allocate one service
    /// BuildId, stage its exact generated bytes, then settle through the same
    /// provenance guard / budget / cancel / cleanup chain.
    pub fn build_preview(
        &self,
        candidate: &ToolCandidate,
        request: &NativePreviewBuildRequest,
    ) -> Result<CompileAttempt, ServiceError> {
        validate_preview_request(request)?;
        let sequence = self
            .next_build_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.roots
            .write_attempt_source(
                sequence,
                &request.generated_source_identity,
                &request.generated_source_bytes,
            )
            .map_err(|err| ServiceError::Host {
                detail: format!("Preview staging failed: {err}"),
            })?;

        let build_id = BuildId { sequence };
        let candidate = candidate.clone();
        let request = request.clone();
        let executable = std::path::PathBuf::from(&candidate.tool_path);
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut in_flight = self
                .in_flight
                .lock()
                .expect("no panic path holds the registry");
            in_flight.insert(sequence, Arc::clone(&cancel));
        }

        let roots = self.roots.clone();
        let compile_budget = self.compile_budget;
        let in_flight = Arc::clone(&self.in_flight);
        let settle = std::thread::spawn(move || {
            let result = settle_preview_build(
                &candidate,
                &executable,
                &request,
                sequence,
                roots.clone(),
                compile_budget,
                Arc::clone(&cancel),
            );
            roots.clean_attempt_staging(sequence);
            in_flight
                .lock()
                .expect("no panic path holds the registry")
                .remove(&sequence);
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

/// Admission-time validation of the allowlisted shape — a MIRROR of the
/// client package's `isWellFormedRequest` (its authority, in the same
/// order, naming the same field for the same refusal). This host must
/// not run a second rulebook: a request the client declares well-formed
/// is admitted here, and a request it rejects is refused here for the
/// SAME field. (The semantic owner of `sourceIdentity` remains
/// `shader-graph-core`; the host checks only the shape, not the value
/// against the bytes.) The conformance fixtures
/// (`tests/toolchain-boundary-requests.json`) run both sides against the
/// same cases.
fn validate_request(request: &NativeCompileRequest) -> Result<(), ServiceError> {
    fn field(field: &str, detail: &str) -> ServiceError {
        ServiceError::RequestShape {
            field: field.to_string(),
            detail: detail.to_string(),
        }
    }
    // source: the exact emitted bytes — a SHAPE on the wire (always a
    // byte array by construction here), no content rule: the client's
    // well-formedness accepts the empty array, and so does this.
    if request.source_identity.len() != 64
        || !request.source_identity.chars().all(|ch| ch.is_ascii_hexdigit())
    {
        return Err(field(
            "sourceIdentity",
            "the source identity must be a 64-character hex digest",
        ));
    }
    for field_name in ["target", "stage", "entry"] {
        let value = match field_name {
            "target" => request.target.as_str(),
            "stage" => request.stage.as_str(),
            _ => request.entry.as_str(),
        };
        if value.is_empty() {
            return Err(field(field_name, "must be a non-empty wire name"));
        }
    }
    for define in &request.defines {
        if define.name.is_empty() {
            return Err(field(
                "defines",
                "a define carries a non-empty name and a string value",
            ));
        }
    }
    if request
        .defines
        .windows(2)
        .any(|window| window[0].name >= window[1].name)
    {
        return Err(field("defines", "defines must be sorted by name with no duplicates"));
    }
    for include in &request.includes {
        if include.is_empty() {
            return Err(field("includes", "an include must be a non-empty string"));
        }
    }
    Ok(())
}

/// Admission-time mirror of `isWellFormedPreviewBuildRequest`. The request is
/// still only a value here: semantic support is proven by the Preview
/// handshake and judged by the TypeScript client, never by this service.
fn validate_preview_request(request: &NativePreviewBuildRequest) -> Result<(), ServiceError> {
    fn field(field: &str, detail: &str) -> ServiceError {
        ServiceError::RequestShape {
            field: field.to_string(),
            detail: detail.to_string(),
        }
    }
    fn is_lower_hex(value: &str, length: usize) -> bool {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    if !is_lower_hex(&request.session_id, 32) {
        return Err(field(
            "sessionId",
            "the session identity must be exactly 32 lowercase hexadecimal characters",
        ));
    }
    for (field_name, value) in [
        ("targetProfile", request.target_profile.as_str()),
        ("profileId", request.profile_id.as_str()),
        (
            "previewInputContractId",
            request.preview_input_contract_id.as_str(),
        ),
    ] {
        if value.is_empty() {
            return Err(field(field_name, "must be a non-empty wire name"));
        }
    }
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    if request.profile_version == 0 || request.profile_version > MAX_SAFE_INTEGER {
        return Err(field("profileVersion", "must be a positive safe integer"));
    }
    if !is_lower_hex(&request.preview_program_descriptor_identity, 64) {
        return Err(field(
            "previewProgramDescriptorIdentity",
            "must be a canonical lowercase SHA-256 digest",
        ));
    }
    if !is_lower_hex(&request.generated_source_identity, 64) {
        return Err(field(
            "generatedSourceIdentity",
            "must be a canonical lowercase SHA-256 digest",
        ));
    }
    // TypeScript's request value deliberately owns the positive safe-integer
    // subset of the wire u64; mirror that exact admission boundary.
    if request.attempt_sequence == 0 || request.attempt_sequence > MAX_SAFE_INTEGER {
        return Err(field("attemptSequence", "must be a positive safe integer"));
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

/// Host-internal serialization of the approved Preview intent onto the main
/// toolchain's published `build-preview` grammar. Paths are derived only from
/// private staging and the selected candidate's deployment closure; adapter,
/// PSMain, compiler policy, publication, and Registry composition are
/// deliberately absent because the tool owns them.
fn serialize_preview_build(
    roots: &ToolchainRoots,
    executable: &std::path::Path,
    sequence: u64,
    request: &NativePreviewBuildRequest,
) -> Vec<String> {
    // `gglab-shaderc` is deployed next to the ordinary runtime closure. The
    // Preview operation must read that deployment's active base Registry and
    // publish its immutable overlay into the SAME canonical ShaderArtifacts
    // root; an empty service-private artifact root could never produce a valid
    // Preview publication. These paths remain host-internal.
    let deployment_root = executable
        .parent()
        .unwrap_or_else(|| std::path::Path::new(""));
    let source_root = deployment_root.join("Shaders");
    let cache_root = deployment_root.join("ShaderCache");
    let artifact_root = deployment_root.join("ShaderArtifacts");
    let generated_source = roots
        .attempt_staging(sequence)
        .join(format!("{}.hlsl", request.generated_source_identity));
    vec![
        "build-preview".to_string(),
        "--source-root".to_string(),
        source_root.to_string_lossy().into_owned(),
        "--generated-source".to_string(),
        generated_source.to_string_lossy().into_owned(),
        "--generated-source-identity".to_string(),
        request.generated_source_identity.clone(),
        "--target".to_string(),
        request.target_profile.clone(),
        "--profile-id".to_string(),
        request.profile_id.clone(),
        "--profile-version".to_string(),
        request.profile_version.to_string(),
        "--preview-input-contract-id".to_string(),
        request.preview_input_contract_id.clone(),
        "--preview-program-descriptor-identity".to_string(),
        request.preview_program_descriptor_identity.clone(),
        "--session-id".to_string(),
        request.session_id.clone(),
        "--attempt-sequence".to_string(),
        request.attempt_sequence.to_string(),
        "--cache-root".to_string(),
        cache_root.to_string_lossy().into_owned(),
        "--artifact-root".to_string(),
        artifact_root.to_string_lossy().into_owned(),
        "--result-format".to_string(),
        "json".to_string(),
    ]
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
        Ok(guard) => guard,
        Err(refusal) => return guard_refusal(refusal, candidate),
    };
    let args = serialize_compile(&roots, sequence, request);
    let child = match spawn(executable, &args) {
        Ok(child) => child,
        Err(SpawnError { source: _ }) => {
            return BoundaryResult::LaunchFailed {
                candidate: candidate.clone(),
            };
        }
    };
    // The process EXISTS now — the guard released the path the instant
    // creation settled; the candidate's file may be rebuilt while this
    // run continues.
    drop(guard);
    BoundaryResult::Spawned {
        output: child.bounded_wait(compile_budget, Some(Arc::clone(&cancel))),
    }
}

fn settle_preview_build(
    candidate: &ToolCandidate,
    executable: &std::path::Path,
    request: &NativePreviewBuildRequest,
    sequence: u64,
    roots: ToolchainRoots,
    compile_budget: ExecutionBudget,
    cancel: Arc<AtomicBool>,
) -> BoundaryResult {
    let guard = verify_and_hold(&candidate.tool_path, &candidate.observation_identity);
    let guard = match guard {
        Ok(guard) => guard,
        Err(refusal) => return guard_refusal(refusal, candidate),
    };
    let args = serialize_preview_build(&roots, executable, sequence, request);
    let child = match spawn(executable, &args) {
        Ok(child) => child,
        Err(SpawnError { source: _ }) => {
            return BoundaryResult::LaunchFailed {
                candidate: candidate.clone(),
            };
        }
    };
    drop(guard);
    BoundaryResult::Spawned {
        output: child.bounded_wait(compile_budget, Some(Arc::clone(&cancel))),
    }
}

/// The shared mapping of a pre-spawn guard refusal onto the client's
/// settlement vocabulary — one place, so the handshake and the compile
/// paths cannot drift apart.
fn guard_refusal(refusal: GuardRefusal, candidate: &ToolCandidate) -> BoundaryResult {
    match refusal {
        GuardRefusal::Changed { current_identity } => BoundaryResult::CandidateInvalidated {
            candidate: candidate.clone(),
            observation: CandidateObservation::Changed,
            observed_identity: Some(current_identity),
        },
        GuardRefusal::Missing => BoundaryResult::CandidateInvalidated {
            candidate: candidate.clone(),
            observation: CandidateObservation::Missing,
            observed_identity: None,
        },
        GuardRefusal::Unreadable => BoundaryResult::CandidateInvalidated {
            candidate: candidate.clone(),
            observation: CandidateObservation::Unreadable,
            observed_identity: None,
        },
        // Not the toolchain's platform: no check possible, no spawn
        // allowed — the honest structured fact the client reads.
        GuardRefusal::Unsupported => BoundaryResult::LaunchFailed {
            candidate: candidate.clone(),
        },
    }
}
