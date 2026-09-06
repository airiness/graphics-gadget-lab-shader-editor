//! GGLab Shader Graph Editor — desktop shell and bounded native services.
//!
//! Three bounded service groups in one crate (see the crate-level note in
//! `Cargo.toml`): the thin shell and scoped auxiliary-file plugins, the
//! Workspace/revisioned-document boundary, and the six tool commands plus
//! compiler-free observation and attached Runtime lifecycle commands. The
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

mod document_io;
mod shader_tool;
mod workspace_io;

use std::sync::Arc;
use tauri_plugin_dialog::DialogExt;

use document_io::{
    DocumentFileService, DocumentIoError, DocumentSaveOutcome, DocumentSnapshot,
    ReadDocumentSnapshotRequest, SaveDocumentAsRequest, SaveDocumentRequest,
};
use workspace_io::{
    WorkspaceDiscoveryCancelOutcome, WorkspaceDiscoveryId, WorkspaceDiscoveryRequest,
    WorkspaceDiscoverySettlement, WorkspaceFileService, WorkspaceIoError, WorkspaceRoot,
};

struct ServiceShared(Arc<ShaderToolService>);
struct DocumentFileShared(Arc<DocumentFileService>);
struct WorkspaceFileShared(Arc<WorkspaceFileService>);

impl ServiceShared {
    fn service(&self) -> &ShaderToolService {
        &self.0
    }
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
        let selected = app
            .dialog()
            .file()
            .set_title("Open shader graph document")
            .add_filter("Shader graph document", &["shadergraph", "json"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|error| DocumentIoError::InvalidRequest {
            detail: format!("the selected document is not a local filesystem path: {error}"),
        })?;
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
        let selected = app
            .dialog()
            .file()
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
        let selected = app
            .dialog()
            .file()
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
        service.register_selected_root(path).map(Some)
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
        .manage(DocumentFileShared(document_files))
        .manage(WorkspaceFileShared(workspace_files))
        .invoke_handler(tauri::generate_handler![
            shader_document_open,
            shader_document_read_snapshot,
            shader_document_save,
            shader_document_save_as,
            shader_workspace_choose_root,
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
