//! GGLab Shader Graph Editor — desktop shell + ShaderToolService.
//!
//! Two layers in one crate (see the crate-level note in `Cargo.toml`):
//! the thin shell (the two official plugins — dialog and scoped fs),
//! and the six service commands. The thin layer of commands below owns
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

mod shader_tool;

use std::sync::Arc;

struct ServiceShared(Arc<ShaderToolService>);

impl ServiceShared {
    fn service(&self) -> &ShaderToolService {
        &self.0
    }
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

/// The production entry: the two official plugins (the access model)
/// plus the six service commands (the host boundary), and nothing else
/// in the web-facing surface.
/// The boundary's public surface — the host-side contract that the
/// toolchain client declares (and its tests implement as a fake).
pub use shader_tool::discovery::discover;
pub use shader_tool::error::ServiceError;
pub use shader_tool::execution::ExecutionBudget;
pub use shader_tool::identity::{hash_bytes, hash_file};
pub use shader_tool::service::{CompileAttempt, ShaderToolService};
pub use shader_tool::staging::ToolchainRoots;
pub use shader_tool::types::{
    BuildId, BoundaryOutput, BoundaryResult, CancelOutcome, CandidateObservation, CompileDefine,
    DiscoverOutcome, DiscoverRequest, DiscoveryRule, DiscoveryRuleFailure,
    NativeCompileRequest, NativePreviewBuildRequest, ToolCandidate,
};

/// The production entry: the two official plugins (the access model)
/// plus the six service commands (the host boundary), and nothing else
/// in the web-facing surface.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ServiceShared(Arc::new(ShaderToolService::production())))
        .invoke_handler(tauri::generate_handler![
            shader_tool_discover,
            shader_tool_handshake,
            shader_tool_preview_handshake,
            shader_tool_compile,
            shader_tool_build_preview,
            shader_tool_cancel
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
