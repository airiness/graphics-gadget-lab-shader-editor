//! Selected Environment/state execution through the existing ShaderToolService.
use crate::environment_io::{error, ordinary_path, EnvironmentHostError as Error};
use crate::environment_storage::{DirectoryKind, EnvironmentStorageService};
use crate::shader_tool::{
    service::ShaderToolService,
    staging::{EnvironmentRoots, ToolchainRoots},
    types::*,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    StartCompile { request: NativeCompileRequest },
    StartPreview { request: NativePreviewBuildRequest },
    BuildResult { build_id: BuildId },
    CancelBuild { build_id: BuildId },
    RuntimeExit { runtime_id: PreviewRuntimeId },
    StopRuntime { runtime_id: PreviewRuntimeId },
    Handshake,
    PreviewHandshake,
    CompileProbe {
        profile_version: u32,
        target: String,
    },
    BuildPreview {
        request: NativePreviewBuildRequest,
    },
    Launch {
        session_id: String,
        backend: String,
    },
    Observe {
        session_id: String,
    },
    Stop,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    execution_id: String,
    environment_id: String,
    environment_root: String,
    state_root: String,
    candidate: ToolCandidate,
    runtime_path: String,
    runtime_sha256: String,
    descriptors: Vec<String>,
    preview_descriptor_sha256: String,
}
struct Context {
    service: ShaderToolService,
    builds: Mutex<HashMap<u64, std::thread::JoinHandle<BoundaryResult>>>,
    last_exit: Mutex<Option<PreviewRuntimeExit>>,
    candidate: ToolCandidate,
    state: PathBuf,
    busy: Mutex<()>,
    cancelled: Arc<AtomicBool>,
    termination_unproven: AtomicBool,
    runtime: Mutex<
        Option<(
            String,
            PreviewRuntimeId,
            std::thread::JoinHandle<PreviewRuntimeExit>,
        )>,
    >,
    sequence: AtomicU64,
    nonce: String,
}
#[derive(Default)]
pub struct EnvironmentExecutionService {
    contexts: Mutex<HashMap<String, Arc<Context>>>,
    sequence: AtomicU64,
}
impl Drop for EnvironmentExecutionService {
    fn drop(&mut self) {
        if let Ok(contexts) = self.contexts.lock() {
            for context in contexts.values() {
                context.cancelled.store(true, Ordering::SeqCst);
                context.service.cancel_all_builds();
                if let Ok(runtime) = context.runtime.lock() {
                    if let Some((_, id, _)) = runtime.as_ref() {
                        context.service.stop_preview_runtime(*id);
                    }
                }
            }
        }
    }
}
fn io(e: impl ToString) -> Error {
    error("io-error", e)
}
fn held_text(path: &std::path::Path) -> Result<String, Error> {
    ordinary_path(path)?;
    if std::fs::metadata(path).map_err(io)?.len() > 16 * 1024 * 1024 {
        return Err(error("limit-exceeded", "Metadata too large"));
    }
    let (_guard, _) = crate::shader_tool::provenance::observe_and_hold(&path.to_string_lossy())
        .map_err(|e| error("source-changed", format!("{e:?}")))?;
    if std::fs::metadata(path).map_err(io)?.len() > 16 * 1024 * 1024 {
        return Err(error("limit-exceeded", "Metadata too large"));
    }
    std::fs::read_to_string(path).map_err(io)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn asynchronous_results_are_owned_by_execution_and_sequence() {
        let executions = EnvironmentExecutionService::default();
        let candidate = ToolCandidate {
            rule: DiscoveryRule::ExplicitConfig,
            tool_path: "unused".into(),
            observation_identity: "a".repeat(64),
            resolved_at: 1,
        };
        let runtime_id = PreviewRuntimeId { sequence: 9 };
        let runtime_join = std::thread::spawn(move || PreviewRuntimeExit {
            runtime_id, kind: PreviewRuntimeExitKind::Exited, exit_code: Some(0),
        });
        while !runtime_join.is_finished() { std::thread::yield_now(); }
        let build_candidate = candidate.clone();
        let build_join = std::thread::spawn(move || BoundaryResult::LaunchFailed { candidate: build_candidate });
        while !build_join.is_finished() { std::thread::yield_now(); }
        executions.contexts.lock().unwrap().insert("owned".into(), Arc::new(Context {
            service: ShaderToolService::production(),
            builds: Mutex::new(HashMap::from([(7, build_join)])),
            last_exit: Mutex::new(None), candidate, state: "unused".into(),
            busy: Mutex::new(()), cancelled: Arc::new(AtomicBool::new(false)),
            termination_unproven: AtomicBool::new(false),
            runtime: Mutex::new(Some(("session".into(), runtime_id, runtime_join))),
            sequence: AtomicU64::new(1), nonce: "unused".into(),
        }));
        let foreign = PreviewRuntimeId { sequence: 10 };
        assert_eq!(executions.execute("owned", Operation::StopRuntime { runtime_id: foreign }).unwrap_err().code, "invalid-handle");
        assert_eq!(executions.execute("owned", Operation::RuntimeExit { runtime_id: foreign }).unwrap_err().code, "invalid-handle");
        assert_eq!(executions.execute("owned", Operation::BuildResult { build_id: BuildId { sequence: 8 } }).unwrap_err().code, "invalid-handle");
        assert_eq!(executions.execute("owned", Operation::CancelBuild { build_id: BuildId { sequence: 8 } }).unwrap()["canceled"], false);
        assert_eq!(executions.execute("owned", Operation::BuildResult { build_id: BuildId { sequence: 7 } }).unwrap()["kind"], "launch-failed");
        assert_eq!(executions.execute("owned", Operation::BuildResult { build_id: BuildId { sequence: 7 } }).unwrap_err().code, "invalid-handle");
        assert_eq!(executions.execute("owned", Operation::RuntimeExit { runtime_id }).unwrap()["kind"], "exited");
        assert_eq!(executions.execute("owned", Operation::StopRuntime { runtime_id }).unwrap()["alreadySettled"], true);
        executions.close("owned").unwrap();
        assert!(executions.contexts.lock().unwrap().is_empty());
    }

    #[test]
    fn unproven_runtime_exit_remains_a_refusal_on_close_retry() {
        let executions = EnvironmentExecutionService::default();
        let parent = ShaderToolService::production();
        let runtime_id = PreviewRuntimeId { sequence: 1 };
        let join = std::thread::spawn(move || PreviewRuntimeExit {
            runtime_id,
            kind: PreviewRuntimeExitKind::WaitFailed,
            exit_code: None,
        });
        executions.contexts.lock().unwrap().insert(
            "test".into(),
            Arc::new(Context {
                builds: Mutex::new(HashMap::new()), last_exit: Mutex::new(None),
                service: parent.for_environment(ToolchainRoots::under(PathBuf::from("unused"))),
                candidate: ToolCandidate {
                    rule: DiscoveryRule::ExplicitConfig,
                    tool_path: "unused".into(),
                    observation_identity: "a".repeat(64),
                    resolved_at: 1,
                },
                state: "unused".into(),
                busy: Mutex::new(()),
                cancelled: Arc::new(AtomicBool::new(false)),
                termination_unproven: AtomicBool::new(false),
                runtime: Mutex::new(Some(("session".into(), runtime_id, join))),
                sequence: AtomicU64::new(1),
                nonce: "unused".into(),
            }),
        );
        assert_eq!(
            executions.close("test").unwrap_err().code,
            "runtime-unavailable"
        );
        assert_eq!(
            executions.close("test").unwrap_err().code,
            "runtime-unavailable"
        );
        assert_eq!(executions.contexts.lock().unwrap().len(), 1);
    }

    #[test]
    fn execution_requests_cannot_supply_paths_or_native_arguments() {
        for request in [
            serde_json::json!({"operation":"compile-probe","profileVersion":1,"target":"gglab-dx12","sourceRoot":"elsewhere"}),
            serde_json::json!({"operation":"launch","sessionId":"a","backend":"dx12","arguments":["--self-test"]}),
            serde_json::json!({"operation":"compile","request":{}}),
        ] {
            assert!(serde_json::from_value::<Operation>(request).is_err());
        }
    }

    #[test]
    #[ignore = "requires explicit published Environment/state fixtures; no native fixture fallback"]
    fn real_environment_execution_bridge() {
        use std::io::{BufRead, Write};
        let storage = EnvironmentStorageService::default();
        let environment = storage
            .select(
                &PathBuf::from(std::env::var("GGLAB_PROOF_ENVIRONMENT").expect("Environment root")),
                DirectoryKind::Environment,
            )
            .unwrap();
        let state = storage
            .select(
                &PathBuf::from(std::env::var("GGLAB_PROOF_STATE").expect("State root")),
                DirectoryKind::State,
            )
            .unwrap();
        let tools = ShaderToolService::production();
        let execution = EnvironmentExecutionService::default();
        let registration = crate::environment_registration::RegistrationService::default();
        for line in std::io::stdin().lock().lines() {
            let request: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
            let args = &request["args"];
            let result: Result<serde_json::Value, Error> = (|| {
                Ok(match request["command"].as_str().unwrap() {
                    "shader-environment-prepare-registration" => serde_json::to_value(registration.prepare(&storage, args["environmentDirectoryId"].as_str().unwrap(), args["stateDirectoryId"].as_str().unwrap())?).unwrap(),
                    "shader-environment-discard-registration" => { registration.discard(args["registrationId"].as_str().unwrap())?; serde_json::Value::Null },
                    "shader-environment-commit-registration" | "shader-environment-registry-scan" => {
                        let registry = crate::environment_storage::RegistryStorage::new(PathBuf::from(std::env::var("GGLAB_REGISTRATION_ROOT").expect("Test registry root")))?;
                        if request["command"] == "shader-environment-registry-scan" { serde_json::to_value(registry.scan()?).unwrap() }
                        else { serde_json::to_value(registration.commit(&storage, &registry, args["registrationId"].as_str().unwrap())?).unwrap() }
                    }
                    "selections" => serde_json::json!({"environment":environment,"state":state}),
                    "shader-environment-observe-directory" => serde_json::to_value(
                        storage.observe(args["directoryId"].as_str().unwrap())?,
                    )
                    .unwrap(),
                    "shader-environment-open-execution" => serde_json::to_value(execution.open(
                        &storage,
                        &tools,
                        args["environmentDirectoryId"].as_str().unwrap(),
                        args["stateDirectoryId"].as_str().unwrap(),
                    )?)
                    .unwrap(),
                    "shader-environment-execute" => execution.execute(
                        args["executionId"].as_str().unwrap(),
                        serde_json::from_value(args["operation"].clone()).map_err(io)?,
                    )?,
                    "shader-environment-cancel-execution" => {
                        execution.cancel(args["executionId"].as_str().unwrap())?;
                        serde_json::Value::Null
                    }
                    "shader-environment-close-execution" => {
                        execution.close(args["executionId"].as_str().unwrap())?;
                        serde_json::Value::Null
                    }
                    _ => return Err(error("invalid-request", "Unknown bridge test command")),
                })
            })();
            println!(
                "GGLAB_PROOF_REPLY:{}",
                serde_json::to_string(&match result {
                    Ok(value) => serde_json::json!({"value": value}),
                    Err(error) => serde_json::json!({"error": error}),
                })
                .unwrap()
            );
            std::io::stdout().flush().unwrap();
        }
    }
}
/// Qualified Windows host limit, not an Environment manifest or native wire field.
/// Reserve room for native cache/publication temporary names below writable state.
pub(crate) fn validate_state_path(path: &std::path::Path) -> Result<(), Error> {
    if path.as_os_str().to_string_lossy().encode_utf16().count() > 90 {
        return Err(error("path-too-long", "Environment state root exceeds the qualified 90 UTF-16 unit limit; select a shorter independent state root. Existing state is retained."));
    }
    Ok(())
}
impl EnvironmentExecutionService {
    pub fn open(
        &self,
        storage: &EnvironmentStorageService,
        parent: &ShaderToolService,
        environment: &str,
        state: &str,
    ) -> Result<Admission, Error> {
        let root = storage.selected_path(environment, DirectoryKind::Environment)?;
        let state_root = storage.selected_path(state, DirectoryKind::State)?;
        validate_state_path(&state_root)?;
        if root.starts_with(&state_root) || state_root.starts_with(&root) {
            return Err(error("invalid-path", "Overlapping execution roots"));
        }
        // Use the storage observer to reject links throughout both trees before forming paths.
        storage.observe(environment)?;
        storage.observe(state)?;
        let manifest: serde_json::Value =
            serde_json::from_str(&held_text(&root.join("environment.json"))?).map_err(io)?;
        let binding: serde_json::Value =
            serde_json::from_str(&held_text(&state_root.join("state.json"))?).map_err(io)?;
        let id = manifest["environmentId"]
            .as_str()
            .ok_or_else(|| error("identity-mismatch", "Missing Environment identity"))?;
        if manifest["manifestVersion"] != 1
            || binding["stateVersion"] != 1
            || binding["environmentId"] != id
        {
            return Err(error(
                "state-conflict",
                "Execution state does not match Environment",
            ));
        }
        let payload = root.join("payload");
        for role in [
            "Generated",
            "ShaderCache",
            "ShaderArtifacts",
            "Logs",
            "ShaderArtifacts/shader-preview",
            "ShaderArtifacts/shader-preview-sessions",
            "DerivedDataCache",
            "Settings",
        ] {
            if !ordinary_path(&state_root.join(role))?.is_dir() {
                return Err(error("missing-member", "Missing writable role"));
            }
        }
        let tool = ordinary_path(&payload.join("gglab-shaderc.exe"))?;
        let runtime = ordinary_path(&payload.join("GraphicsGadgetLab.exe"))?;
        let (_tool_guard, tool_hash) =
            crate::shader_tool::provenance::observe_and_hold(&tool.to_string_lossy())
                .map_err(|e| error("source-changed", format!("{e:?}")))?;
        let (_runtime_guard, runtime_hash) =
            crate::shader_tool::provenance::observe_and_hold(&runtime.to_string_lossy())
                .map_err(|e| error("source-changed", format!("{e:?}")))?;
        let mut descriptors = Vec::new();
        for profile in [1, 2] {
            descriptors.push(held_text(&payload.join(format!(
                "Shaders/Profiles/GGLab.Surface/{profile}/descriptor.json"
            )))?);
        }
        let preview_path =
            ordinary_path(&payload.join("Shaders/Programs/ShaderGraphPreview/descriptor.json"))?;
        let (_, preview_hash) =
            crate::shader_tool::provenance::observe_and_hold(&preview_path.to_string_lossy())
                .map_err(|e| error("source-changed", format!("{e:?}")))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io)?;
        let candidate = ToolCandidate {
            rule: DiscoveryRule::ExplicitConfig,
            tool_path: tool.to_string_lossy().into(),
            observation_identity: tool_hash,
            resolved_at: now.as_millis() as u64,
        };
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let nonce = format!(
            "execution-{}-{}-{sequence}",
            std::process::id(),
            now.as_nanos()
        );
        let execution_id = format!("environment-execution:{sequence}");
        let roots = ToolchainRoots::for_environment(
            EnvironmentRoots {
                source: ordinary_path(&payload.join("Shaders"))?,
                state: state_root.clone(),
                runtime_identity: runtime_hash.clone(),
                vulkan_layers: ordinary_path(&payload.join("VulkanLayers"))?,
            },
            &nonce,
        );
        let service = parent.for_environment(roots);
        let mut contexts = self.contexts.lock().map_err(io)?;
        if contexts.len() >= 4 {
            return Err(error("limit-exceeded", "Too many Environment executions"));
        }
        contexts.insert(
            execution_id.clone(),
            Arc::new(Context {
                service,
                builds: Mutex::new(HashMap::new()), last_exit: Mutex::new(None),
                candidate: candidate.clone(),
                state: state_root.clone(),
                busy: Mutex::new(()),
                cancelled: Arc::new(AtomicBool::new(false)),
                termination_unproven: AtomicBool::new(false),
                runtime: Mutex::new(None),
                sequence: AtomicU64::new(1),
                nonce,
            }),
        );
        Ok(Admission {
            execution_id,
            environment_id: id.into(),
            environment_root: root.to_string_lossy().into(),
            state_root: state_root.to_string_lossy().into(),
            candidate,
            runtime_path: runtime.to_string_lossy().into(),
            runtime_sha256: runtime_hash,
            descriptors,
            preview_descriptor_sha256: preview_hash,
        })
    }
    fn get(&self, id: &str) -> Result<Arc<Context>, Error> {
        self.contexts
            .lock()
            .map_err(io)?
            .get(id)
            .cloned()
            .ok_or_else(|| error("invalid-handle", "Unknown execution"))
    }
    pub fn cancel(&self, id: &str) -> Result<(), Error> {
        let context = self.get(id)?;
        context.cancelled.store(true, Ordering::SeqCst);
        context.service.cancel_all_builds();
        if let Some((_, id, _)) = context.runtime.lock().map_err(io)?.as_ref() {
            context.service.stop_preview_runtime(*id);
        }
        Ok(())
    }
    pub fn execute(&self, id: &str, operation: Operation) -> Result<serde_json::Value, Error> {
        let context = self.get(id)?;
        let _busy = context
            .busy
            .try_lock()
            .map_err(|_| error("host-busy", "Execution already running"))?;
        if context.cancelled.load(Ordering::SeqCst) && !matches!(operation, Operation::Stop | Operation::BuildResult { .. } | Operation::RuntimeExit { .. } | Operation::CancelBuild { .. } | Operation::StopRuntime { .. }) {
            return Err(error("cancelled", "Execution cancelled"));
        }
        if !matches!(operation, Operation::Stop | Operation::BuildResult { .. } | Operation::RuntimeExit { .. } | Operation::CancelBuild { .. } | Operation::StopRuntime { .. }) {
            for role in [
                "",
                "Generated",
                "ShaderCache",
                "ShaderArtifacts",
                "Logs",
                "ShaderArtifacts/shader-preview",
                "ShaderArtifacts/shader-preview-sessions",
                "DerivedDataCache",
                "Settings",
            ] {
                ordinary_path(&context.state.join(role))?;
            }
        }
        let candidate = &context.candidate;
        let result = match operation {
            Operation::StartCompile { request } => {
                let mut builds = context.builds.lock().map_err(io)?;
                if builds.len() >= 16 { return Err(error("host-busy", "Too many uncollected builds")); }
                let attempt = context.service.compile(candidate, &request).map_err(io)?;
                let id = attempt.build_id;
                if context.cancelled.load(Ordering::SeqCst) { context.service.cancel(id); }
                builds.insert(id.sequence, attempt.settle);
                serde_json::to_value(id).map_err(io)?
            }
            Operation::StartPreview { request } => {
                let mut builds = context.builds.lock().map_err(io)?;
                if builds.len() >= 16 { return Err(error("host-busy", "Too many uncollected builds")); }
                let attempt = context.service.build_preview(candidate, &request).map_err(io)?;
                let id = attempt.build_id;
                if context.cancelled.load(Ordering::SeqCst) { context.service.cancel(id); }
                builds.insert(id.sequence, attempt.settle);
                serde_json::to_value(id).map_err(io)?
            }
            Operation::BuildResult { build_id } => {
                let mut builds = context.builds.lock().map_err(io)?;
                let join = builds.get(&build_id.sequence).ok_or_else(|| error("invalid-handle", "Unknown or collected build"))?;
                if !join.is_finished() { serde_json::Value::Null }
                else { serde_json::to_value(builds.remove(&build_id.sequence).unwrap().join().map_err(|_|error("host-task-failed", "Build worker failed"))?).map_err(io)? }
            }
            Operation::CancelBuild { build_id } => {
                let owned = context.builds.lock().map_err(io)?.contains_key(&build_id.sequence);
                let result = if owned { context.service.cancel(build_id) } else { CancelOutcome { build_id, canceled: false, already_settled: true } };
                serde_json::to_value(result).map_err(io)?
            },
            Operation::StopRuntime { runtime_id } => {
                if !context.runtime.lock().map_err(io)?.as_ref().is_some_and(|(_, id, _)| *id == runtime_id) {
                    if context.last_exit.lock().map_err(io)?.as_ref().is_some_and(|e|e.runtime_id == runtime_id) {
                        return serde_json::to_value(PreviewRuntimeStopOutcome { runtime_id, stop_requested: false, already_settled: true }).map_err(io);
                    }
                    return Err(error("invalid-handle", "Runtime does not belong to this execution"));
                }
                serde_json::to_value(context.service.stop_preview_runtime(runtime_id)).map_err(io)?
            }
            Operation::RuntimeExit { runtime_id } => {
                let mut runtime = context.runtime.lock().map_err(io)?;
                if runtime.as_ref().is_some_and(|(_, id, join)| *id == runtime_id && join.is_finished()) {
                    let (_, _, join) = runtime.take().unwrap();
                    context.termination_unproven.store(true, Ordering::SeqCst);
                    let exit = join.join().map_err(|_|error("host-task-failed", "Runtime monitor failed"))?;
                    context.termination_unproven.store(exit.kind == PreviewRuntimeExitKind::WaitFailed, Ordering::SeqCst);
                    *context.last_exit.lock().map_err(io)? = Some(exit);
                }
                if runtime.as_ref().is_some_and(|(_, id, _)| *id == runtime_id) { serde_json::Value::Null }
                else {
                    let exit = context.last_exit.lock().map_err(io)?;
                    if !exit.as_ref().is_some_and(|e|e.runtime_id == runtime_id) { return Err(error("invalid-handle", "Unknown Runtime exit")); }
                    serde_json::to_value(exit.as_ref()).map_err(io)?
                }
            }
            Operation::Handshake => {
                serde_json::to_value(context.service.handshake(candidate)).map_err(io)?
            }
            Operation::PreviewHandshake => {
                serde_json::to_value(context.service.preview_handshake(candidate)).map_err(io)?
            }
            Operation::CompileProbe {
                profile_version,
                target,
            } => serde_json::to_value(
                context
                    .service
                    .compile_environment_probe(
                        candidate,
                        profile_version,
                        &target,
                        context.cancelled.clone(),
                    )
                    .map_err(io)?,
            )
            .map_err(io)?,
            Operation::BuildPreview { request } => {
                let attempt = context
                    .service
                    .build_preview(candidate, &request)
                    .map_err(io)?;
                if context.cancelled.load(Ordering::SeqCst) {
                    context.service.cancel(attempt.build_id);
                }
                serde_json::to_value(
                    attempt
                        .settle
                        .join()
                        .map_err(|_| error("host-task-failed", "Preview worker failed"))?,
                )
                .map_err(io)?
            }
            Operation::Launch {
                session_id,
                backend,
            } => {
                let mut runtime = context.runtime.lock().map_err(io)?;
                if context.termination_unproven.load(Ordering::SeqCst) { return Err(error("runtime-unavailable", "Previous Runtime exit is unproven")); }
                if runtime.is_some() {
                    return Err(error("host-busy", "Stop and join previous Runtime first"));
                }
                let admission = context
                    .service
                    .launch_environment_runtime(candidate, &session_id, &backend)
                    .map_err(io)?;
                if let (PreviewRuntimeLaunchResult::Launched { runtime_id, .. }, Some(join)) =
                    (&admission.result, admission.settle)
                {
                    *runtime = Some((session_id, *runtime_id, join));
                }
                serde_json::to_value(admission.result).map_err(io)?
            }
            Operation::Observe { session_id } => {
                let runtime = context.runtime.lock().map_err(io)?;
                if !runtime
                    .as_ref()
                    .is_some_and(|(session, _, join)| session == &session_id && !join.is_finished())
                {
                    return Err(error(
                        "runtime-unavailable",
                        "Observation requires this live Runtime",
                    ));
                }
                serde_json::to_value(
                    context
                        .service
                        .read_preview_observation(candidate, &session_id)
                        .map_err(io)?,
                )
                .map_err(io)?
            }
            Operation::Stop => {
                let mut runtime = context.runtime.lock().map_err(io)?;
                if let Some((_, runtime_id, join)) = runtime.as_ref() {
                    context.service.stop_preview_runtime(*runtime_id);
                    let start = std::time::Instant::now();
                    while !join.is_finished() {
                        if start.elapsed().as_secs() >= 10 {
                            return Err(error(
                                "runtime-unavailable",
                                "Runtime termination remains unproven",
                            ));
                        }
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                }
                if context.termination_unproven.load(Ordering::SeqCst) {
                    return Err(error(
                        "runtime-unavailable",
                        "Runtime termination remains unproven",
                    ));
                }
                context.termination_unproven.store(true, Ordering::SeqCst);
                let exit = runtime
                    .take()
                    .map(|(_, _, join)| {
                        join.join()
                            .map_err(|_| error("host-task-failed", "Runtime monitor failed"))
                    })
                    .transpose()?;
                if exit
                    .as_ref()
                    .is_some_and(|e| e.kind == PreviewRuntimeExitKind::WaitFailed)
                {
                    return Err(error("runtime-unavailable", "Runtime exit is unproven"));
                }
                context.termination_unproven.store(false, Ordering::SeqCst);
                if exit.is_some() { *context.last_exit.lock().map_err(io)? = exit.clone(); }
                serde_json::to_value(exit).map_err(io)?
            }
        };
        if result["kind"] == "spawned" {
            use std::io::Write;
            let sequence = context.sequence.fetch_add(1, Ordering::SeqCst);
            let path = context
                .state
                .join("Logs")
                .join(format!("{}-{sequence}.json", context.nonce));
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(io)?
                .write_all(serde_json::to_string(&result).map_err(io)?.as_bytes())
                .map_err(io)?;
        }
        Ok(result)
    }
    pub fn close(&self, id: &str) -> Result<(), Error> {
        self.cancel(id)?;
        let context = self.get(id)?;
        {
            // Wait for any admitted start before draining its worker. Cancellation
            // prevents subsequent admissions from creating new work.
            let _busy = context.busy.lock().map_err(io)?;
            let workers: Vec<_> = context.builds.lock().map_err(io)?.drain().collect();
            let mut failed = false;
            for (_, join) in workers { failed |= join.join().is_err(); }
            if failed { return Err(error("host-task-failed", "Build cleanup failed")); }
        }
        self.execute(id, Operation::Stop)?;
        self.contexts.lock().map_err(io)?.remove(id);
        Ok(())
    }
}
