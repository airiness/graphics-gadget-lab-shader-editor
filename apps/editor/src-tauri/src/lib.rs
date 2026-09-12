//! GGLab Shader Graph Editor — desktop shell and bounded native services.
//!
//! Bounded service groups in one crate (see the crate-level note in
//! `Cargo.toml`): the thin shell and scoped auxiliary-file plugins, the
//! Workspace/revisioned-document boundary, and the six tool commands plus
//! compiler-free observation and attached Runtime lifecycle commands, plus
//! Environment selection, filesystem observation, registry reads and guarded discovery. The
//! thin layer of commands below owns
//! no logic of its own: it takes the client's values in, hands them to
//! the service, and returns the service's values back — the service is
//! the only place where host internals live.
//!
//! The service itself is a blocking host boundary; the commands around
//! it are async so the blocking work runs ON Tauri's runtime worker
//! thread, never on the thread that owns the window: a 30-second
//! handshake must not be able to hold the UI open-mouth. `cancel` stays
//! a plain command — it is a flag write and a lookup, not work. The one
//! worker this file owns besides that is the settlement forwarder of an
//! admitted ordinary or Preview build (settle on its own thread, deliver to
//! the UI's channel when it lands); the build call resolves immediately with
//! the attempt's identity.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod application_preferences;
mod document_io;
mod environment_io;
mod environment_process_job;
mod environment_mutation;
mod environment_storage;
mod environment_registration;
mod environment_execution;
mod shader_tool;
mod workspace_io;

use std::sync::Arc;
use tauri_plugin_dialog::DialogExt;
use tauri::Manager;

use document_io::{
    DocumentFileService, DocumentIoError, DocumentSaveOutcome, DocumentSnapshot,
    ReadDocumentSnapshotRequest, SaveDocumentAsRequest, SaveDocumentRequest,
};
use workspace_io::{
    WorkspaceDiscoveryCancelOutcome, WorkspaceDiscoveryId, WorkspaceDiscoveryRequest,
    WorkspaceDiscoverySettlement, WorkspaceFileService, WorkspaceIoError, WorkspaceRoot,
};

struct EnvironmentMutationShared(Arc<environment_mutation::MutationService>);
struct EnvironmentRegistrationShared(Arc<environment_registration::RegistrationService>);
struct EnvironmentShared(Arc<environment_io::EnvironmentService>);
struct EnvironmentStorageShared(Arc<environment_storage::EnvironmentStorageService>);
struct EnvironmentExecutionShared(Arc<environment_execution::EnvironmentExecutionService>);

struct ServiceShared(Arc<ShaderToolService>);
struct DocumentFileShared(Arc<DocumentFileService>);
struct WorkspaceFileShared(Arc<WorkspaceFileService>);

impl ServiceShared {
    fn service(&self) -> &ShaderToolService {
        &self.0
    }
}

fn preferences(app: &tauri::AppHandle) -> Result<application_preferences::PreferencesStore, String> {
    Ok(application_preferences::PreferencesStore::new(app.path().app_data_dir().map_err(|e| e.to_string())?))
}

fn history_dialog(app: &tauri::AppHandle, kind: application_preferences::DialogKind) -> Result<tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>, String> {
    let dialog = app.dialog().file();
    Ok(match preferences(app)?.directory(kind)? { Some(path) => dialog.set_directory(path), None => dialog })
}

fn remember_directory(app: &tauri::AppHandle, kind: application_preferences::DialogKind, path: &std::path::Path) -> Result<(), String> {
    preferences(app)?.remember(kind, path)
}

/// A saved location is only intent. Re-admit it through the normal Workspace
/// host before returning a fresh capability; no caller-supplied path is accepted.
#[tauri::command(rename = "shader-workspace-reopen-last")]
async fn shader_workspace_reopen_last(app: tauri::AppHandle, state: tauri::State<'_, WorkspaceFileShared>) -> Result<Option<WorkspaceRoot>, WorkspaceIoError> {
    let service = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = preferences(&app).and_then(|p| p.directory(application_preferences::DialogKind::Workspace))
            .map_err(|detail| WorkspaceIoError::HostTask { detail })?;
        path.map(|path| service.register_selected_root(path)).transpose()
    }).await.map_err(|e| WorkspaceIoError::HostTask { detail: e.to_string() })?
}

/// Host-owned Open dialog followed by one canonical, revisioned snapshot.
/// No caller-supplied path crosses this command boundary.
#[tauri::command(rename = "shader-document-open")]
async fn shader_document_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, DocumentFileShared>,
) -> Result<Option<DocumentSnapshot>, DocumentIoError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let selected = history_dialog(&app, application_preferences::DialogKind::Graph)
            .map_err(|detail| DocumentIoError::HostTask { detail })?
            .set_title("Open shader graph document")
            .add_filter("Shader graph document", &["shadergraph", "json"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|error| DocumentIoError::InvalidRequest {
            detail: format!("the selected document is not a local filesystem path: {error}"),
        })?;
        remember_directory(&app, application_preferences::DialogKind::Graph, path.parent().ok_or_else(|| DocumentIoError::InvalidRequest { detail: "Selected graph has no parent directory".into() })?)
            .map_err(|detail| DocumentIoError::HostTask { detail })?;
        service.open_selected_path(path).map(Some)
    })
    .await
    .map_err(|error| DocumentIoError::HostTask {
        detail: format!("the host task ended: {error}"),
    })?
}

/// Re-read a snapshot only through a canonical URI admitted by Open/Save As.
#[tauri::command(rename = "shader-document-read-snapshot")]
async fn shader_document_read_snapshot(
    state: tauri::State<'_, DocumentFileShared>,
    request: ReadDocumentSnapshotRequest,
) -> Result<DocumentSnapshot, DocumentIoError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        service.read_snapshot(&request.canonical_document_uri)
    })
    .await
    .map_err(|error| DocumentIoError::HostTask {
        detail: format!("the host task ended: {error}"),
    })?
}

/// Compare the expected revision and atomically replace an authorized file.
#[tauri::command(rename = "shader-document-save")]
async fn shader_document_save(
    state: tauri::State<'_, DocumentFileShared>,
    request: SaveDocumentRequest,
) -> Result<DocumentSaveOutcome, DocumentIoError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || service.save(&request))
        .await
        .map_err(|error| DocumentIoError::HostTask {
            detail: format!("the host task ended: {error}"),
        })?
}

/// Host-owned Save As dialog. A pre-existing target is a conflict value, not
/// an implicit overwrite; no destination path is accepted from the WebView.
#[tauri::command(rename = "shader-document-save-as")]
async fn shader_document_save_as(
    app: tauri::AppHandle,
    state: tauri::State<'_, DocumentFileShared>,
    request: SaveDocumentAsRequest,
) -> Result<DocumentSaveOutcome, DocumentIoError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let default_name = std::path::Path::new(&request.default_name);
        if default_name.file_name().and_then(|value| value.to_str())
            != Some(request.default_name.as_str())
        {
            return Err(DocumentIoError::InvalidRequest {
                detail: "defaultName must be one file name, not a path".to_string(),
            });
        }
        let selected = history_dialog(&app, application_preferences::DialogKind::Graph)
            .map_err(|detail| DocumentIoError::HostTask { detail })?
            .set_title("Save shader graph document")
            .set_file_name(request.default_name)
            .add_filter("Shader graph document", &["shadergraph", "json"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(DocumentSaveOutcome::Cancelled);
        };
        let path = selected.into_path().map_err(|error| DocumentIoError::InvalidRequest {
            detail: format!("the selected destination is not a local filesystem path: {error}"),
        })?;
        remember_directory(&app, application_preferences::DialogKind::Graph, path.parent().ok_or_else(|| DocumentIoError::InvalidRequest { detail: "Save destination has no parent directory".into() })?)
            .map_err(|detail| DocumentIoError::HostTask { detail })?;
        service.save_as_selected_path(path, &request.text)
    })
    .await
    .map_err(|error| DocumentIoError::HostTask {
        detail: format!("the host task ended: {error}"),
    })?
}

/// Host-owned directory selection and canonical Workspace-root admission.
/// The WebView receives identity/provenance but never supplies a root path.
#[tauri::command(rename = "shader-workspace-choose-root")]
async fn shader_workspace_choose_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceFileShared>,
) -> Result<Option<WorkspaceRoot>, WorkspaceIoError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let selected = history_dialog(&app, application_preferences::DialogKind::Workspace)
            .map_err(|detail| WorkspaceIoError::HostTask { detail })?
            .set_title("Open Shader Graph Workspace")
            .blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|error| WorkspaceIoError::InvalidRequest {
                detail: format!("the selected Workspace is not a local directory: {error}"),
            })?;
        let root = service.register_selected_root(path.clone())?;
        remember_directory(&app, application_preferences::DialogKind::Workspace, &path)
            .map_err(|detail| WorkspaceIoError::HostTask { detail })?;
        Ok(Some(root))
    })
    .await
    .map_err(|error| WorkspaceIoError::HostTask {
        detail: format!("the host task ended: {error}"),
    })?
}

/// Begin bounded recursive discovery for a registered Workspace URI. Results
/// settle on the channel so the returned attempt identity can be cancelled.
#[tauri::command(rename = "shader-workspace-discover")]
fn shader_workspace_discover(
    state: tauri::State<'_, WorkspaceFileShared>,
    request: WorkspaceDiscoveryRequest,
    channel: tauri::ipc::Channel<WorkspaceDiscoverySettlement>,
) -> Result<WorkspaceDiscoveryId, WorkspaceIoError> {
    let attempt = state.0.discover(&request)?;
    let discovery_id = attempt.discovery_id;
    std::thread::spawn(move || {
        let settlement = attempt.settle.join().unwrap_or_else(|_| {
            WorkspaceDiscoverySettlement::Failed {
                discovery_id,
                error: WorkspaceIoError::HostTask {
                    detail: "the Workspace discovery worker panicked".to_string(),
                },
            }
        });
        let _ = channel.send(settlement);
    });
    Ok(discovery_id)
}

/// Request cancellation of one discovery attempt. Cancellation is an explicit
/// value and never changes the authority of already-settled snapshots.
#[tauri::command(rename = "shader-workspace-cancel-discovery")]
fn shader_workspace_cancel_discovery(
    state: tauri::State<'_, WorkspaceFileShared>,
    discovery_id: WorkspaceDiscoveryId,
) -> WorkspaceDiscoveryCancelOutcome {
    state.0.cancel_discovery(discovery_id)
}

/// `discover(config)` → candidate facts and the per-rule failure record.
/// Bookkeeping only: no execution, no interpretation.
///
/// The `rename` carries the command's IPC name in the hyphenated form
/// the web-facing surface uses: the client's invoke id is
/// `shader-tool-discover`.
///
/// Async so the bookkeeping (a file identity hash over the candidate)
/// runs on the runtime's worker thread, not the one that owns the
/// window.
#[tauri::command(rename = "shader-tool-discover")]
async fn shader_tool_discover(
    state: tauri::State<'_, ServiceShared>,
    request: DiscoverRequest,
) -> Result<DiscoverOutcome, ServiceError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || service.discover(&request))
        .await
        .map_err(|err| ServiceError::Host { detail: format!("the host task ended: {err}") })
}

/// `handshake(candidate)` → the raw output surface — or the structured
/// pre-spawn refusal (`candidate-invalidated` / `launch-failed`). Always
/// a value; the refusal IS the observation, and the observation is a
/// fact.
/// `handshake(candidate)` is the long pole (up to the 30-second budget):
/// async, so it cannot freeze the window thread.
#[tauri::command(rename = "shader-tool-handshake")]
async fn shader_tool_handshake(
    state: tauri::State<'_, ServiceShared>,
    candidate: ToolCandidate,
) -> Result<BoundaryResult, ServiceError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || service.handshake(&candidate))
        .await
        .map_err(|err| ServiceError::Host { detail: format!("the host task ended: {err}") })
}

/// `previewHandshake(candidate)` → the raw `describe-preview` output surface,
/// under the exact same candidate provenance guard as ordinary describe.
#[tauri::command(rename = "shader-tool-preview-handshake")]
async fn shader_tool_preview_handshake(
    state: tauri::State<'_, ServiceShared>,
    candidate: ToolCandidate,
) -> Result<BoundaryResult, ServiceError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || service.preview_handshake(&candidate))
        .await
        .map_err(|err| ServiceError::Host {
            detail: format!("the host task ended: {err}"),
        })
}

/// `compile(candidate, request)` → the attempt's identity; its
/// settlement (the raw output surface, or the structured pre-spawn
/// refusal) is delivered on the channel — and is cancellable by build id
/// until it settles. The command itself returns the identity, not the
/// settlement.
/// The admission step (validation + staging) is short but touches disk:
/// keep it on the worker thread too; the long part (the run itself) is
/// already on its own settlement thread.
#[tauri::command(rename = "shader-tool-compile")]
async fn shader_tool_compile(
    state: tauri::State<'_, ServiceShared>,
    candidate: ToolCandidate,
    request: NativeCompileRequest,
    channel: tauri::ipc::Channel<BoundaryResult>,
) -> Result<BuildId, ServiceError> {
    let service = Arc::clone(&state.0);
    // Two layers of Result: the worker task may end (JoinError), and
    // the admission may refuse (ServiceError) — `?` on each, in order.
    let attempt = tauri::async_runtime::spawn_blocking(move || service.compile(&candidate, &request))
        .await
        .map_err(|err| ServiceError::Host { detail: format!("the host task ended: {err}") })??;
    let build_id = attempt.build_id;
    std::thread::spawn(move || match attempt.settle.join() {
        Ok(settlement) => {
            let _ = channel.send(settlement);
        }
        Err(_) => {
            // A settlement panic is not a settlement and not a refusal:
            // the attempt's own cleanup already ran on the settlement
            // thread; the identity stays honest.
        }
    });
    Ok(build_id)
}

/// `buildPreview(candidate, request)` → a service BuildId immediately, then
/// the dedicated build settlement on the channel. The request carries no
/// native path or compiler policy; those stay inside the service/toolchain.
#[tauri::command(rename = "shader-tool-build-preview")]
async fn shader_tool_build_preview(
    state: tauri::State<'_, ServiceShared>,
    candidate: ToolCandidate,
    request: NativePreviewBuildRequest,
    channel: tauri::ipc::Channel<BoundaryResult>,
) -> Result<BuildId, ServiceError> {
    let service = Arc::clone(&state.0);
    let attempt =
        tauri::async_runtime::spawn_blocking(move || service.build_preview(&candidate, &request))
            .await
            .map_err(|err| ServiceError::Host {
                detail: format!("the host task ended: {err}"),
            })??;
    let build_id = attempt.build_id;
    std::thread::spawn(move || {
        if let Ok(settlement) = attempt.settle.join() {
            let _ = channel.send(settlement);
        }
    });
    Ok(build_id)
}

/// `cancel(buildId)` → an explicit value: canceled now, or already
/// settled (no state change). Cancel is an action, never an error.
#[tauri::command(rename = "shader-tool-cancel")]
fn shader_tool_cancel(
    state: tauri::State<'_, ServiceShared>,
    build_id: BuildId,
) -> Result<CancelOutcome, ServiceError> {
    Ok(state.service().cancel(build_id))
}

/// Read one candidate/session-scoped Runtime observation without spawning
/// the tool. The service validates both identities, derives the canonical
/// deployment path, and bounds the byte read; protocol interpretation stays
/// in the headless client.
#[tauri::command(rename = "shader-preview-read-observation")]
async fn shader_preview_read_observation(
    state: tauri::State<'_, ServiceShared>,
    candidate: ToolCandidate,
    session_id: String,
) -> Result<PreviewObservationHostReadResult, ServiceError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        service.read_preview_observation(&candidate, &session_id)
    })
    .await
    .map_err(|err| ServiceError::Host {
        detail: format!("the host task ended: {err}"),
    })?
}

#[tauri::command(rename = "shader-preview-launch-runtime")]
async fn shader_preview_launch_runtime(
    state: tauri::State<'_, ServiceShared>,
    candidate: ToolCandidate,
    session_id: String,
    channel: tauri::ipc::Channel<PreviewRuntimeExit>,
) -> Result<PreviewRuntimeLaunchResult, ServiceError> {
    let service = Arc::clone(&state.0);
    let admission = tauri::async_runtime::spawn_blocking(move || {
        service.launch_preview_runtime(&candidate, &session_id)
    })
    .await
    .map_err(|err| ServiceError::Host {
        detail: format!("the host task ended: {err}"),
    })??;
    if let Some(settle) = admission.settle {
        std::thread::spawn(move || {
            if let Ok(exit) = settle.join() {
                let _ = channel.send(exit);
            }
        });
    }
    Ok(admission.result)
}

#[tauri::command(rename = "shader-preview-stop-runtime")]
fn shader_preview_stop_runtime(
    state: tauri::State<'_, ServiceShared>,
    runtime_id: PreviewRuntimeId,
) -> Result<PreviewRuntimeStopOutcome, ServiceError> {
    Ok(state.service().stop_preview_runtime(runtime_id))
}

#[tauri::command(rename = "shader-environment-prepare-mutation")]
async fn shader_environment_prepare_mutation(app: tauri::AppHandle, state: tauri::State<'_, EnvironmentMutationShared>, producer: tauri::State<'_, EnvironmentShared>, storage: tauri::State<'_, EnvironmentStorageShared>, request: environment_mutation::Prepare) -> Result<environment_mutation::Intent, environment_io::EnvironmentHostError> {
    let root=app.path().app_data_dir().map_err(|e|environment_io::error("io-error",e))?;
    let service=state.0.clone(); let producer=producer.0.clone(); let storage=storage.0.clone();
    tauri::async_runtime::spawn_blocking(move ||service.prepare(&root,&producer,&storage,request)).await.map_err(|e|environment_io::error("host-task-failed",e))?
}
#[tauri::command(rename = "shader-environment-run-mutation")]
async fn shader_environment_run_mutation(app: tauri::AppHandle, state: tauri::State<'_, EnvironmentMutationShared>, producer: tauri::State<'_, EnvironmentShared>, repository_id:String, operation_id:String) -> Result<serde_json::Value, environment_io::EnvironmentHostError> {
    let root=app.path().app_data_dir().map_err(|e|environment_io::error("io-error",e))?; let service=state.0.clone(); let producer=producer.0.clone();
    tauri::async_runtime::spawn_blocking(move ||service.run(&root,&producer,&repository_id,&operation_id)).await.map_err(|e|environment_io::error("host-task-failed",e))?
}
#[tauri::command(rename = "shader-environment-inspect-mutation")]
async fn shader_environment_inspect_mutation(app: tauri::AppHandle, state: tauri::State<'_, EnvironmentMutationShared>, storage: tauri::State<'_, EnvironmentStorageShared>, operation_id:String) -> Result<environment_mutation::Inspection, environment_io::EnvironmentHostError> {
    let root=app.path().app_data_dir().map_err(|e|environment_io::error("io-error",e))?; let service=state.0.clone(); let storage=storage.0.clone();
    tauri::async_runtime::spawn_blocking(move ||service.inspect(&root,&storage,&operation_id)).await.map_err(|e|environment_io::error("host-task-failed",e))?
}
#[tauri::command(rename = "shader-environment-list-mutations")]
async fn shader_environment_list_mutations(app: tauri::AppHandle, state: tauri::State<'_, EnvironmentMutationShared>) -> Result<Vec<String>, environment_io::EnvironmentHostError> {
    let root=app.path().app_data_dir().map_err(|e|environment_io::error("io-error",e))?; let service=state.0.clone();
    tauri::async_runtime::spawn_blocking(move ||service.list(&root)).await.map_err(|e|environment_io::error("host-task-failed",e))?
}
#[tauri::command(rename = "shader-environment-cancel-mutation")]
fn shader_environment_cancel_mutation(state: tauri::State<'_, EnvironmentMutationShared>, operation_id:String) -> Result<bool, environment_io::EnvironmentHostError> { state.0.cancel(&operation_id) }

#[tauri::command(rename = "shader-environment-prepare-registration")]
async fn shader_environment_prepare_registration(state: tauri::State<'_, EnvironmentRegistrationShared>, storage: tauri::State<'_, EnvironmentStorageShared>, environment_directory_id:String, state_directory_id:String) -> Result<environment_registration::Admission, environment_io::EnvironmentHostError> {
    let service=state.0.clone(); let storage=storage.0.clone();
    tauri::async_runtime::spawn_blocking(move || service.prepare(&storage,&environment_directory_id,&state_directory_id)).await.map_err(|e|environment_io::error("host-task-failed",e))?
}
#[tauri::command(rename = "shader-environment-commit-registration")]
async fn shader_environment_commit_registration(app:tauri::AppHandle, state:tauri::State<'_,EnvironmentRegistrationShared>, storage:tauri::State<'_,EnvironmentStorageShared>, registration_id:String) -> Result<environment_registration::Settlement,environment_io::EnvironmentHostError> {
    let root=app.path().app_data_dir().map_err(|e|environment_io::error("io-error",e))?.join("environment-registry");
    let service=state.0.clone(); let storage=storage.0.clone();
    tauri::async_runtime::spawn_blocking(move ||service.commit(&storage,&environment_storage::RegistryStorage::new(root)?,&registration_id)).await.map_err(|e|environment_io::error("host-task-failed",e))?
}
#[tauri::command(rename = "shader-environment-discard-registration")]
fn shader_environment_discard_registration(state:tauri::State<'_,EnvironmentRegistrationShared>,registration_id:String) -> Result<(),environment_io::EnvironmentHostError> { state.0.discard(&registration_id) }

/// Selection is the only path admission surface; subsequent calls carry opaque IDs.
#[tauri::command(rename = "shader-environment-open-execution")]
async fn shader_environment_open_execution(
    state: tauri::State<'_, EnvironmentExecutionShared>, storage: tauri::State<'_, EnvironmentStorageShared>, tools: tauri::State<'_, ServiceShared>,
    environment_directory_id: String, state_directory_id: String,
) -> Result<environment_execution::Admission, environment_io::EnvironmentHostError> {
    let service = state.0.clone(); let storage = storage.0.clone(); let tools = tools.0.clone();
    tauri::async_runtime::spawn_blocking(move || service.open(&storage, &tools, &environment_directory_id, &state_directory_id)).await.map_err(|e| environment_io::error("host-task-failed", e))?
}
#[tauri::command(rename = "shader-environment-execute")]
async fn shader_environment_execute(state: tauri::State<'_, EnvironmentExecutionShared>, execution_id: String, operation: environment_execution::Operation) -> Result<serde_json::Value, environment_io::EnvironmentHostError> {
    let service = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || service.execute(&execution_id, operation)).await.map_err(|e| environment_io::error("host-task-failed", e))?
}
#[tauri::command(rename = "shader-environment-cancel-execution")]
fn shader_environment_cancel_execution(state: tauri::State<'_, EnvironmentExecutionShared>, execution_id: String) -> Result<(), environment_io::EnvironmentHostError> { state.0.cancel(&execution_id) }
#[tauri::command(rename = "shader-environment-close-execution")]
async fn shader_environment_close_execution(state: tauri::State<'_, EnvironmentExecutionShared>, execution_id: String) -> Result<(), environment_io::EnvironmentHostError> {
    let service = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || service.close(&execution_id)).await.map_err(|e| environment_io::error("host-task-failed", e))?
}
#[tauri::command(rename = "shader-environment-choose-directory")]
async fn shader_environment_choose_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, EnvironmentStorageShared>,
    kind: environment_storage::DirectoryKind,
) -> Result<Option<environment_storage::DirectoryHandle>, environment_io::EnvironmentHostError> {
    let service = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let history = match kind { environment_storage::DirectoryKind::Environment => application_preferences::DialogKind::PublishedEnvironment, environment_storage::DirectoryKind::State => application_preferences::DialogKind::WritableState };
        let Some(selected) = history_dialog(&app, history).map_err(|e| environment_io::error("preferences-error", e))?.blocking_pick_folder() else { return Ok(None); };
        let path = selected.into_path().map_err(|e| environment_io::error("invalid-path", e))?;
        let selected = service.select(&path, kind)?;
        remember_directory(&app, history, &path).map_err(|e| environment_io::error("preferences-error", e))?;
        Ok(Some(selected))
    }).await.map_err(|e| environment_io::error("host-task-failed", e))?
}
#[tauri::command(rename = "shader-environment-observe-directory")]
async fn shader_environment_observe_directory(
    state: tauri::State<'_, EnvironmentStorageShared>, directory_id: String,
) -> Result<environment_storage::DirectoryObservation, environment_io::EnvironmentHostError> {
    let service = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || service.observe(&directory_id))
        .await.map_err(|e| environment_io::error("host-task-failed", e))?
}
#[tauri::command(rename = "shader-environment-registry-scan")]
async fn shader_environment_registry_scan(app: tauri::AppHandle) -> Result<environment_storage::RegistryScan, environment_io::EnvironmentHostError> {
    let root = app.path().app_data_dir().map_err(|e| environment_io::error("io-error", e))?.join("environment-registry");
    tauri::async_runtime::spawn_blocking(move || environment_storage::RegistryStorage::new(root)?.scan())
        .await.map_err(|e| environment_io::error("host-task-failed", e))?
}
#[tauri::command(rename = "shader-environment-registry-open")]
async fn shader_environment_registry_open(
    app: tauri::AppHandle, state: tauri::State<'_, EnvironmentStorageShared>, key: String,
) -> Result<environment_storage::RecoverySelection, environment_io::EnvironmentHostError> {
    let root = app.path().app_data_dir().map_err(|e| environment_io::error("io-error", e))?.join("environment-registry");
    let service = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || service.open_registration(&environment_storage::RegistryStorage::new(root)?, &key))
        .await.map_err(|e| environment_io::error("host-task-failed", e))?
}
#[tauri::command(rename = "shader-environment-choose-repository")]
async fn shader_environment_choose_repository(
    app: tauri::AppHandle,
    state: tauri::State<'_, EnvironmentShared>,
) -> Result<Option<environment_io::EnvironmentRepository>, environment_io::EnvironmentHostError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = history_dialog(&app, application_preferences::DialogKind::EnvironmentSource).map_err(|e| environment_io::error("preferences-error", e))?.set_title("Select GGLab source repository").blocking_pick_folder() else { return Ok(None); };
        let path = selected.into_path().map_err(|e| environment_io::EnvironmentHostError { code: "invalid-path".into(), message: e.to_string(), data_path: "$".into() })?;
        let repository = service.register_selected_repository(path.clone())?;
        remember_directory(&app, application_preferences::DialogKind::EnvironmentSource, &path).map_err(|e| environment_io::error("preferences-error", e))?;
        Ok(Some(repository))
    }).await.map_err(|e| environment_io::EnvironmentHostError { code: "host-task-failed".into(), message: e.to_string(), data_path: "$".into() })?
}
#[tauri::command(rename = "shader-environment-discover")]
fn shader_environment_discover(
    state: tauri::State<'_, EnvironmentShared>,
    repository_id: String,
    channel: tauri::ipc::Channel<environment_io::EnvironmentDiscoverySettlement>,
) -> Result<String, environment_io::EnvironmentHostError> {
    let job = state.0.discover(&repository_id)?;
    let id = job.id.clone();
    std::thread::spawn(move || {
        let result = job.settle.join().unwrap_or_else(|_| environment_io::EnvironmentDiscoverySettlement::Failed {
            discovery_id: job.id, repository_id,
            error: environment_io::EnvironmentHostError { code: "host-task-failed".into(), message: "Discovery worker ended unexpectedly".into(), data_path: "$".into() },
        });
        let _ = channel.send(result);
    });
    Ok(id)
}
#[tauri::command(rename = "shader-environment-cancel-discovery")]
fn shader_environment_cancel_discovery(
    state: tauri::State<'_, EnvironmentShared>, discovery_id: String,
) -> Result<bool, environment_io::EnvironmentHostError> { state.0.cancel(&discovery_id) }

/// The boundary's public surface: six tool operations plus compiler-free
/// observation and attached Runtime lifecycle capabilities. This is the
/// host-side contract that the toolchain client declares and tests with its
/// reference fakes.
pub use shader_tool::discovery::discover;
pub use shader_tool::error::ServiceError;
pub use shader_tool::execution::ExecutionBudget;
pub use shader_tool::identity::{hash_bytes, hash_file};
pub use shader_tool::service::{CompileAttempt, PreviewRuntimeLaunchAdmission, ShaderToolService};
pub use shader_tool::staging::ToolchainRoots;
pub use shader_tool::types::{
    BoundaryOutput, BoundaryResult, BuildId, CancelOutcome, CandidateObservation, CompileDefine,
    DiscoverOutcome, DiscoverRequest, DiscoveryRule, DiscoveryRuleFailure, NativeCompileRequest,
    NativePreviewBuildRequest, PreviewObservationHostReadResult,
    PreviewRuntimeAvailabilityObservation, PreviewRuntimeExit, PreviewRuntimeExitKind,
    PreviewRuntimeId, PreviewRuntimeLaunchResult, PreviewRuntimeStopOutcome, ToolCandidate,
};
pub use document_io::{DocumentFileService as NativeDocumentFileService};
pub use workspace_io::{WorkspaceFileService as NativeWorkspaceFileService};

/// The production entry: bounded Workspace/document capabilities, the two
/// official plugins for scoped auxiliary reads, the six tool commands, and
/// the compiler-free Preview observation / attached-process lifecycle
/// commands.
pub fn run() {
    let document_files = Arc::new(DocumentFileService::new());
    let workspace_files = Arc::new(WorkspaceFileService::new(Arc::clone(&document_files)));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ServiceShared(Arc::new(ShaderToolService::production())))
        .manage(EnvironmentMutationShared(Arc::new(environment_mutation::MutationService::default())))
        .manage(EnvironmentRegistrationShared(Arc::new(environment_registration::RegistrationService::default())))
        .manage(EnvironmentShared(Arc::new(environment_io::EnvironmentService::new())))
        .manage(EnvironmentStorageShared(Arc::new(environment_storage::EnvironmentStorageService::default())))
        .manage(EnvironmentExecutionShared(Arc::new(environment_execution::EnvironmentExecutionService::default())))
        .manage(DocumentFileShared(document_files))
        .manage(WorkspaceFileShared(workspace_files))
        .invoke_handler(tauri::generate_handler![
            shader_environment_prepare_mutation,
            shader_environment_run_mutation,
            shader_environment_inspect_mutation,
            shader_environment_list_mutations,
            shader_environment_cancel_mutation,
            shader_environment_prepare_registration,
            shader_environment_commit_registration,
            shader_environment_discard_registration,
            shader_environment_open_execution,
            shader_environment_execute,
            shader_environment_cancel_execution,
            shader_environment_close_execution,
            shader_environment_choose_directory,
            shader_environment_observe_directory,
            shader_environment_registry_scan,
            shader_environment_registry_open,
            shader_environment_choose_repository,
            shader_environment_discover,
            shader_environment_cancel_discovery,
            shader_document_open,
            shader_document_read_snapshot,
            shader_document_save,
            shader_document_save_as,
            shader_workspace_choose_root,
            shader_workspace_reopen_last,
            shader_workspace_discover,
            shader_workspace_cancel_discovery,
            shader_tool_discover,
            shader_tool_handshake,
            shader_tool_preview_handshake,
            shader_tool_compile,
            shader_tool_build_preview,
            shader_tool_cancel,
            shader_preview_read_observation,
            shader_preview_launch_runtime,
            shader_preview_stop_runtime
        ])
        .run(tauri::generate_context!())
        .expect("error while running the GGLab Shader Graph Editor desktop shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_state_exposes_the_service() {
        let shared = ServiceShared(Arc::new(ShaderToolService::for_test(
            shader_tool::staging::ToolchainRoots::under(std::env::temp_dir().join("gglab-lib-test")),
            ExecutionBudget::for_test(std::time::Duration::from_millis(50)),
            ExecutionBudget::for_test(std::time::Duration::from_millis(50)),
            None,
        )));
        let _ = shared.service();
    }
}
