//! The ShaderToolService — the product implementation of the declared
//! host boundary (design §9 plus the approved Preview Milestone B extension),
//! exactly six tool capabilities, plus the compiler-free Runtime observation
//! and attached-process lifecycle boundaries:
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
//! read_preview_observation(candidate, session_id) → bounded raw observation
//! launch_preview_runtime(candidate, session_id) → attached Runtime admission
//! stop_preview_runtime(runtime_id) → bounded process stop request
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

use std::io::Read as _;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use super::discovery::discover as discover_core;
use super::error::ServiceError;
use super::execution::{spawn_in, ExecutionBudget, SpawnError};
use super::provenance::{observe_and_hold, verify_and_hold, GuardRefusal};
use super::staging::ToolchainRoots;
use super::types::{
    BoundaryResult, BuildId, CancelOutcome, CandidateObservation, DiscoverOutcome, DiscoverRequest,
    NativeCompileRequest, NativePreviewBuildRequest, PreviewObservationHostReadResult,
    PreviewRuntimeAvailabilityObservation, PreviewRuntimeExit, PreviewRuntimeExitKind,
    PreviewRuntimeId, PreviewRuntimeLaunchResult, PreviewRuntimeStopOutcome, ToolCandidate,
};

/// The service state, shared across the (few) async command tasks:
/// the private roots, the execution budgets, the attempt sequence, and
/// the in-flight cancel flags (one per running compile attempt).
pub struct ShaderToolService {
    roots: ToolchainRoots,
    handshake_budget: ExecutionBudget,
    compile_budget: ExecutionBudget,
    service_executable_dir: Option<std::path::PathBuf>,
    next_build_id: Arc<AtomicU64>,
    next_runtime_id: Arc<AtomicU64>,
    owns_runtime_registry: bool,
    /// Single-flight for discovery: held for the (cheap) discovery walk,
    /// released after — the rule, not a scheduler.
    discovery_gate: std::sync::Mutex<()>,
    /// The in-flight compile attempts and their cancel flags — shared
    /// with the settlement threads by an owned `Arc`; every access is a
    /// short synchronous step.
    in_flight: Arc<std::sync::Mutex<std::collections::HashMap<u64, Arc<AtomicBool>>>>,
    /// Live attached processes, keyed by the opaque session identity. The
    /// monitor thread removes its own entry after reaping the child.
    preview_runtimes: Arc<
        std::sync::Mutex<std::collections::HashMap<String, (PreviewRuntimeId, Arc<AtomicBool>)>>,
    >,
}

/// A compile attempt admitted by the service: its identity, and the
/// settlement it will produce (joined by the caller — the Tauri command
/// forwards it to the UI's channel; the tests join it directly).
pub struct CompileAttempt {
    pub build_id: BuildId,
    pub settle: std::thread::JoinHandle<BoundaryResult>,
}

pub struct PreviewRuntimeLaunchAdmission {
    pub result: PreviewRuntimeLaunchResult,
    pub settle: Option<std::thread::JoinHandle<PreviewRuntimeExit>>,
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

impl Drop for ShaderToolService {
    fn drop(&mut self) {
        if !self.owns_runtime_registry { return; }
        if let Ok(runtimes) = self.preview_runtimes.lock() {
            for (_, stop) in runtimes.values() {
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        // Window teardown cannot rely solely on the WebView's asynchronous
        // cleanup command. Give every monitor a bounded opportunity to kill,
        // reap, and unregister its child before the host exits.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            if self
                .preview_runtimes
                .lock()
                .map(|runtimes| runtimes.is_empty())
                .unwrap_or(true)
            {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

impl ShaderToolService {
    pub(crate) fn cancel_all_builds(&self) {
        if let Ok(attempts) = self.in_flight.lock() { for flag in attempts.values() { flag.store(true, std::sync::atomic::Ordering::SeqCst); } }
    }
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
            next_build_id: Arc::new(AtomicU64::new(1)),
            next_runtime_id: Arc::new(AtomicU64::new(1)),
            owns_runtime_registry: true,
            discovery_gate: std::sync::Mutex::new(()),
            in_flight: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            preview_runtimes: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
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
            next_build_id: Arc::new(AtomicU64::new(1)),
            next_runtime_id: Arc::new(AtomicU64::new(1)),
            owns_runtime_registry: true,
            discovery_gate: std::sync::Mutex::new(()),
            in_flight: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            preview_runtimes: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    /// A private execution view shares process identities and Runtime exclusion with the desktop service.
    pub(crate) fn for_environment(&self, roots: ToolchainRoots) -> Self {
        let mut service = Self::production();
        service.roots = roots;
        service.next_build_id = self.next_build_id.clone();
        service.next_runtime_id = self.next_runtime_id.clone();
        service.preview_runtimes = self.preview_runtimes.clone();
        service.owns_runtime_registry = false;
        service
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

    /// Read the fixed Runtime observation record for one Preview session.
    /// The web side supplies identities only: the deployment root and file
    /// name are host-owned derivations. Candidate provenance is held across
    /// the file open/read, and the host applies only a transport bound; the
    /// strict binary reader and all Current/LastGood meaning live above it.
    pub fn read_preview_observation(
        &self,
        candidate: &ToolCandidate,
        session_id: &str,
    ) -> Result<PreviewObservationHostReadResult, ServiceError> {
        validate_preview_session_id(session_id)?;
        let guard = match verify_and_hold(&candidate.tool_path, &candidate.observation_identity) {
            Ok(guard) => guard,
            Err(refusal) => return Ok(observation_guard_refusal(refusal, candidate)),
        };
        let executable = std::path::Path::new(&candidate.tool_path);
        let Some(deployment_root) = executable.parent() else {
            return Ok(PreviewObservationHostReadResult::ReadFailed);
        };
        let path = self.roots.environment.as_ref().map(|e| e.state.as_path()).unwrap_or(deployment_root)
            .join("ShaderArtifacts")
            .join("shader-preview-sessions")
            .join(session_id)
            .join("observed.ggsh.preview-observed");
        let mut file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(PreviewObservationHostReadResult::NotFound);
            }
            Err(_) => return Ok(PreviewObservationHostReadResult::ReadFailed),
        };
        const OBSERVATION_SIZE: u64 = 90;
        let mut bytes = Vec::with_capacity(OBSERVATION_SIZE as usize);
        if file
            .by_ref()
            .take(OBSERVATION_SIZE + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return Ok(PreviewObservationHostReadResult::ReadFailed);
        }
        drop(guard);
        if bytes.len() > OBSERVATION_SIZE as usize {
            return Ok(PreviewObservationHostReadResult::TooLarge);
        }
        Ok(PreviewObservationHostReadResult::Read { bytes })
    }

    /// Launch the main application's attached Shader Graph Preview Lab from
    /// the selected candidate's deployment closure. The stable executable,
    /// working directory, Lab ID, and argv are host-owned. Both the candidate
    /// and WinApp executable are held against replacement until process
    /// creation settles, and one SessionId can own at most one live process.
    pub fn launch_preview_runtime(
        &self,
        candidate: &ToolCandidate,
        session_id: &str,
    ) -> Result<PreviewRuntimeLaunchAdmission, ServiceError> {
        self.launch_runtime(candidate, session_id, None)
    }

    pub(crate) fn launch_environment_runtime(&self, candidate: &ToolCandidate, session_id: &str, backend: &str) -> Result<PreviewRuntimeLaunchAdmission, ServiceError> {
        if self.roots.environment.is_none() || !["dx12", "vulkan"].contains(&backend) { return Err(request_shape("backend", "Invalid Environment Runtime backend")); }
        self.launch_runtime(candidate, session_id, Some(backend))
    }

    fn launch_runtime(&self, candidate: &ToolCandidate, session_id: &str, backend: Option<&str>) -> Result<PreviewRuntimeLaunchAdmission, ServiceError> {
        validate_preview_session_id(session_id)?;
        let mut runtimes = self
            .preview_runtimes
            .lock()
            .expect("no panic path holds the Preview Runtime registry");
        if let Some((runtime_id, _)) = runtimes.values().next() {
            return Ok(PreviewRuntimeLaunchAdmission {
                result: PreviewRuntimeLaunchResult::SessionAlreadyRunning {
                    runtime_id: *runtime_id,
                },
                settle: None,
            });
        }

        let candidate_guard =
            match verify_and_hold(&candidate.tool_path, &candidate.observation_identity) {
                Ok(guard) => guard,
                Err(refusal) => {
                    return Ok(PreviewRuntimeLaunchAdmission {
                        result: preview_runtime_candidate_refusal(refusal, candidate),
                        settle: None,
                    });
                }
            };
        let executable = std::path::Path::new(&candidate.tool_path);
        let Some(deployment_root) = executable.parent() else {
            return Ok(PreviewRuntimeLaunchAdmission {
                result: PreviewRuntimeLaunchResult::RuntimeUnavailable {
                    observation: PreviewRuntimeAvailabilityObservation::Unreadable,
                },
                settle: None,
            });
        };
        let runtime_path = deployment_root.join("GraphicsGadgetLab.exe");
        let runtime_path_text = runtime_path.to_string_lossy().into_owned();
        let (runtime_guard, runtime_identity) = match observe_and_hold(&runtime_path_text) {
            Ok(observation) => observation,
            Err(refusal) => {
                return Ok(PreviewRuntimeLaunchAdmission {
                    result: preview_runtime_unavailable(refusal),
                    settle: None,
                });
            }
        };
        if let Some(e) = &self.roots.environment {
            if runtime_identity != e.runtime_identity { return Err(request_shape("runtimeIdentity", "Environment Runtime bytes changed")); }
        }
        let mut command = std::process::Command::new(&runtime_path);
        command.args(["--lab", "gglab.lab.shader_graph_preview", "--shader-preview-session", session_id, "--absolute-mouse"])
            .stdin(std::process::Stdio::null());
        if let Some(e) = &self.roots.environment {
            command.arg("--state-root").arg(&e.state).args(["--rhi", backend.unwrap_or("dx12")])
                .current_dir(&e.state).env("VK_LAYER_PATH", &e.vulkan_layers);
            for (suffix, stdout) in [("stdout", true), ("stderr", false)] {
                let file = std::fs::OpenOptions::new().create_new(true).write(true).open(e.state.join("Logs").join(format!("runtime-{session_id}.{suffix}.log")))
                    .map_err(|e| ServiceError::Host { detail: e.to_string() })?;
                if stdout { command.stdout(file); } else { command.stderr(file); }
            }
            #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        } else { command.current_dir(deployment_root).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()); }
        let child = command.spawn();
        let child = match child {
            Ok(child) => child,
            Err(_) => {
                return Ok(PreviewRuntimeLaunchAdmission {
                    result: PreviewRuntimeLaunchResult::LaunchFailed,
                    settle: None,
                });
            }
        };
        drop(runtime_guard);
        drop(candidate_guard);

        let runtime_id = PreviewRuntimeId {
            sequence: self
                .next_runtime_id
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst),
        };
        let stop = Arc::new(AtomicBool::new(false));
        runtimes.insert(session_id.to_string(), (runtime_id, Arc::clone(&stop)));
        drop(runtimes);

        let session_id = session_id.to_string();
        let runtime_registry = Arc::clone(&self.preview_runtimes);
        let settle = std::thread::spawn(move || {
            let exit = settle_preview_runtime(child, runtime_id, Arc::clone(&stop));
            let mut registry = runtime_registry
                .lock()
                .expect("no panic path holds the Preview Runtime registry");
            if exit.kind != PreviewRuntimeExitKind::WaitFailed && registry
                .get(&session_id)
                .is_some_and(|(current, _)| *current == runtime_id)
            {
                registry.remove(&session_id);
            }
            exit
        });
        Ok(PreviewRuntimeLaunchAdmission {
            result: PreviewRuntimeLaunchResult::Launched {
                runtime_id,
                runtime_identity,
            },
            settle: Some(settle),
        })
    }

    pub fn stop_preview_runtime(&self, runtime_id: PreviewRuntimeId) -> PreviewRuntimeStopOutcome {
        let runtimes = self
            .preview_runtimes
            .lock()
            .expect("no panic path holds the Preview Runtime registry");
        if let Some((_, stop)) = runtimes.values().find(|(id, _)| *id == runtime_id) {
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
            return PreviewRuntimeStopOutcome {
                runtime_id,
                stop_requested: true,
                already_settled: false,
            };
        }
        PreviewRuntimeStopOutcome {
            runtime_id,
            stop_requested: false,
            already_settled: true,
        }
    }

    /// Compile a deployed contract probe without copying or overwriting immutable inputs.
    pub(crate) fn compile_environment_probe(&self, candidate: &ToolCandidate, profile: u32, target: &str, cancel: Arc<AtomicBool>) -> Result<BoundaryResult, ServiceError> {
        let roots = self.roots.environment.as_ref().ok_or_else(|| request_shape("environment", "Environment execution required"))?;
        if ![1, 2].contains(&profile) || !["gglab-dx12", "gglab-vulkan13"].contains(&target) { return Err(request_shape("probe", "Unsupported contract probe")); }
        let guard = match verify_and_hold(&candidate.tool_path, &candidate.observation_identity) { Ok(guard) => guard, Err(refusal) => return Ok(guard_refusal(refusal, candidate)) };
        let args = vec!["compile".into(), "--source-root".into(), roots.source.to_string_lossy().into_owned(), "--include".into(), roots.source.to_string_lossy().into_owned(), "--source".into(), format!("Tests/SurfaceGeneratedV{profile}ContractCompile.hlsl"), "--stage".into(), "pixel".into(), "--entry".into(), "PSMain".into(), "--target".into(), target.into(), "--cache-root".into(), roots.state.join("ShaderCache").to_string_lossy().into_owned(), "--artifact-root".into(), roots.state.join("ShaderArtifacts").to_string_lossy().into_owned(), "--result-format".into(), "json".into()];
        let child = match spawn_in(std::path::Path::new(&candidate.tool_path), &args, Some(&roots.state)) { Ok(child) => child, Err(_) => return Ok(BoundaryResult::LaunchFailed { candidate: candidate.clone() }) };
        drop(guard);
        Ok(BoundaryResult::Spawned { output: child.bounded_wait(self.compile_budget, Some(cancel)) })
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
                let child = match spawn_in(&executable, &args, self.roots.environment.as_ref().map(|e| e.state.as_path())) {
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
fn request_shape(field: &str, detail: &str) -> ServiceError {
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

fn validate_preview_session_id(session_id: &str) -> Result<(), ServiceError> {
    if !is_lower_hex(session_id, 32) {
        return Err(request_shape(
            "sessionId",
            "the session identity must be exactly 32 lowercase hexadecimal characters",
        ));
    }
    Ok(())
}

fn validate_preview_request(request: &NativePreviewBuildRequest) -> Result<(), ServiceError> {
    fn field(field: &str, detail: &str) -> ServiceError {
        request_shape(field, detail)
    }

    validate_preview_session_id(&request.session_id)?;
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
    let source_root = roots.environment.as_ref().map(|e| e.source.clone()).unwrap_or_else(|| deployment_root.join("Shaders"));
    let writable = roots.environment.as_ref().map(|e| e.state.as_path()).unwrap_or(deployment_root);
    let cache_root = writable.join("ShaderCache");
    let artifact_root = writable.join("ShaderArtifacts");
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
    let child = match spawn_in(executable, &args, roots.environment.as_ref().map(|e| e.state.as_path())) {
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
    let child = match spawn_in(executable, &args, roots.environment.as_ref().map(|e| e.state.as_path())) {
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

fn observation_guard_refusal(
    refusal: GuardRefusal,
    candidate: &ToolCandidate,
) -> PreviewObservationHostReadResult {
    match refusal {
        GuardRefusal::Changed { current_identity } => {
            PreviewObservationHostReadResult::CandidateInvalidated {
                candidate: candidate.clone(),
                observation: CandidateObservation::Changed,
                observed_identity: Some(current_identity),
            }
        }
        GuardRefusal::Missing => PreviewObservationHostReadResult::CandidateInvalidated {
            candidate: candidate.clone(),
            observation: CandidateObservation::Missing,
            observed_identity: None,
        },
        GuardRefusal::Unreadable => PreviewObservationHostReadResult::CandidateInvalidated {
            candidate: candidate.clone(),
            observation: CandidateObservation::Unreadable,
            observed_identity: None,
        },
        GuardRefusal::Unsupported => PreviewObservationHostReadResult::ReadFailed,
    }
}

fn preview_runtime_candidate_refusal(
    refusal: GuardRefusal,
    candidate: &ToolCandidate,
) -> PreviewRuntimeLaunchResult {
    match refusal {
        GuardRefusal::Changed { current_identity } => {
            PreviewRuntimeLaunchResult::CandidateInvalidated {
                candidate: candidate.clone(),
                observation: CandidateObservation::Changed,
                observed_identity: Some(current_identity),
            }
        }
        GuardRefusal::Missing => PreviewRuntimeLaunchResult::CandidateInvalidated {
            candidate: candidate.clone(),
            observation: CandidateObservation::Missing,
            observed_identity: None,
        },
        GuardRefusal::Unreadable => PreviewRuntimeLaunchResult::CandidateInvalidated {
            candidate: candidate.clone(),
            observation: CandidateObservation::Unreadable,
            observed_identity: None,
        },
        GuardRefusal::Unsupported => PreviewRuntimeLaunchResult::LaunchFailed,
    }
}

fn preview_runtime_unavailable(refusal: GuardRefusal) -> PreviewRuntimeLaunchResult {
    let observation = match refusal {
        GuardRefusal::Missing => PreviewRuntimeAvailabilityObservation::Missing,
        GuardRefusal::Unreadable | GuardRefusal::Changed { .. } | GuardRefusal::Unsupported => {
            PreviewRuntimeAvailabilityObservation::Unreadable
        }
    };
    PreviewRuntimeLaunchResult::RuntimeUnavailable { observation }
}

fn settle_preview_runtime(
    mut child: std::process::Child,
    runtime_id: PreviewRuntimeId,
    stop: Arc<AtomicBool>,
) -> PreviewRuntimeExit {
    loop {
        if stop.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = child.kill();
            let waited = child.wait();
            let kind = if waited.is_ok() { PreviewRuntimeExitKind::Stopped } else { PreviewRuntimeExitKind::WaitFailed };
            let exit_code = waited.ok().and_then(|status| status.code());
            return PreviewRuntimeExit {
                runtime_id,
                kind,
                exit_code,
            };
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return PreviewRuntimeExit {
                    runtime_id,
                    kind: PreviewRuntimeExitKind::Exited,
                    exit_code: status.code(),
                };
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return PreviewRuntimeExit {
                    runtime_id,
                    kind: PreviewRuntimeExitKind::WaitFailed,
                    exit_code: None,
                };
            }
        }
    }
}

#[cfg(test)]
mod environment_tests {
    use super::*;
    use super::super::staging::EnvironmentRoots;
    #[test]
    fn environment_views_share_desktop_runtime_exclusion_without_owning_teardown() {
        let parent = ShaderToolService::production();
        let stop = Arc::new(AtomicBool::new(false));
        parent.preview_runtimes.lock().unwrap().insert("other-session".into(), (PreviewRuntimeId { sequence: 7 }, stop.clone()));
        let view = parent.for_environment(ToolchainRoots::for_environment(EnvironmentRoots { source: "final/Shaders".into(), state: "state".into(), runtime_identity: "a".repeat(64), vulkan_layers: "final/VulkanLayers".into() }, "unique"));
        assert!(Arc::ptr_eq(&parent.next_build_id, &view.next_build_id));
        let candidate = ToolCandidate { rule: super::super::types::DiscoveryRule::ExplicitConfig, tool_path: "never-launched".into(), observation_identity: "b".repeat(64), resolved_at: 1 };
        let result = view.launch_environment_runtime(&candidate, &"1".repeat(32), "dx12").unwrap();
        assert!(matches!(result.result, PreviewRuntimeLaunchResult::SessionAlreadyRunning { runtime_id: PreviewRuntimeId { sequence: 7 } }));
        drop(view);
        assert!(!stop.load(std::sync::atomic::Ordering::SeqCst));
        parent.preview_runtimes.lock().unwrap().clear();
    }
}
