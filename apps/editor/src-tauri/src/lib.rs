//! GGLab Shader Graph Editor — desktop shell + ShaderToolService.
//!
//! Two layers in one crate (see the crate-level note in `Cargo.toml`):
//! the thin shell (the two official plugins — dialog and scoped fs),
//! and the four service commands. The thin layer of commands below owns
//! no logic of its own: it takes the client's values in, hands them to
//! the service, and returns the service's values back — the service is
//! the only place where host internals live.
//!
//! The commands are plain (blocking) Tauri commands: the service is a
//! blocking host boundary by construction, and Tauri schedules command
//! work outside the window's message loop — so no runtime is smuggled in
//! here. The one thread this file owns is the settlement forwarder of
//! an admitted compile (settle on its own thread, deliver to the UI's
//! channel when it lands); the UI's `compile(..., channel)` call
//! resolves immediately with the attempt's identity.

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
#[tauri::command(rename = "shader-tool-discover")]
fn shader_tool_discover(
    state: tauri::State<'_, ServiceShared>,
    request: DiscoverRequest,
) -> Result<DiscoverOutcome, ServiceError> {
    Ok(state.service().discover(&request))
}

/// `handshake(candidate)` → the raw output surface — or the structured
/// pre-spawn refusal (`candidate-invalidated` / `launch-failed`). Always
/// a value; the refusal IS the observation, and the observation is a
/// fact.
#[tauri::command(rename = "shader-tool-handshake")]
fn shader_tool_handshake(
    state: tauri::State<'_, ServiceShared>,
    candidate: ToolCandidate,
) -> Result<BoundaryResult, ServiceError> {
    Ok(state.service().handshake(&candidate))
}

/// `compile(candidate, request)` → the attempt's identity; its
/// settlement (the raw output surface, or the structured pre-spawn
/// refusal) is delivered on the channel — and is cancellable by build id
/// until it settles. The command itself returns the identity, not the
/// settlement.
#[tauri::command(rename = "shader-tool-compile")]
fn shader_tool_compile(
    state: tauri::State<'_, ServiceShared>,
    candidate: ToolCandidate,
    request: NativeCompileRequest,
    channel: tauri::ipc::Channel<BoundaryResult>,
) -> Result<BuildId, ServiceError> {
    let attempt = state.service().compile(&candidate, &request)?;
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
/// plus the four service commands (the host boundary), and nothing else
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
    NativeCompileRequest, ToolCandidate,
};

/// The production entry: the two official plugins (the access model)
/// plus the four service commands (the host boundary), and nothing else
/// in the web-facing surface.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ServiceShared(Arc::new(ShaderToolService::production())))
        .invoke_handler(tauri::generate_handler![
            shader_tool_discover,
            shader_tool_handshake,
            shader_tool_compile,
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
