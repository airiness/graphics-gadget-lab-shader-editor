//! Host tests for the ShaderToolService boundary — the exit criteria:
//! a trivial dummy executable (compiled from `fixture/dummy_tool.rs`)
//! emitting fixed bytes proves execution, whole-stream capture, timeout,
//! cancel, provenance, and invocation serialization.
//!
//! Deliberately absent from every test here: protocol content (no JSON
//! parsing, no document shape), readiness logic (no compatibility
//! judgment), and anything the client package owns. The assertions are
//! exactly the settlement surface — bytes, argv order, exit code, end
//! state — and the structured refusal values (observation facts and
//! request-shape refusals).

use std::path::{Path, PathBuf};
use std::time::Duration;

use gglab_shader_graph_editor::{
    hash_bytes, BuildId, BoundaryResult, CandidateObservation, DiscoveryRule,
    NativeCompileRequest, ServiceError, ShaderToolService, ToolCandidate, ToolchainRoots,
};

fn temp_base(name: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!("gglab-host-tests-{name}"));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    base
}

/// Compile the dummy tool with plain rustc and return the executable.
fn build_dummy(dir: &Path, name: &str) -> PathBuf {
    let out = dir.join(name);
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixture").join("dummy_tool.rs");
    let status = std::process::Command::new("rustc")
        .args(["--edition", "2021", "-O", "-o", out.to_str().unwrap(), source.to_str().unwrap()])
        .status()
        .expect("rustc must be available to build the dummy tool");
    assert!(status.success(), "the dummy tool must compile (status {status:?})");
    out
}

fn service(dir: &Path, budget_ms: u64) -> ShaderToolService {
    let budget_ms = Duration::from_millis(budget_ms);
    ShaderToolService::for_test(
        ToolchainRoots::under(dir.to_path_buf()),
        gglab_shader_graph_editor::ExecutionBudget::for_test(budget_ms),
        gglab_shader_graph_editor::ExecutionBudget::for_test(budget_ms),
        None,
    )
}

fn candidate(tool_path: &Path, content: &[u8]) -> ToolCandidate {
    ToolCandidate {
        rule: DiscoveryRule::ExplicitConfig,
        tool_path: tool_path.to_string_lossy().replace('\\', "/"),
        observation_identity: hash_bytes(content),
        resolved_at: 1,
    }
}

fn unwrap_spawned(result: BoundaryResult) -> gglab_shader_graph_editor::BoundaryOutput {
    match result {
        BoundaryResult::Spawned { output } => output,
        other => panic!("expected spawned, got: {other:?}"),
    }
}

// ---------------------------------------------------------------- execution

#[test]
fn execution_reports_fixed_bytes_and_the_exit_code() {
    let base = temp_base("exec");
    let tool = build_dummy(&base, "dummy.exe");
    let content = std::fs::read(&tool).unwrap();
    let svc = service(&base, 5_000);
    let result = svc.handshake(&candidate(&tool, &content));
    let output = unwrap_spawned(result);
    // The dummy emits a fixed byte pattern on BOTH streams — the test
    // asserts the exact bytes were captured, verbatim, on each side.
    assert_eq!(output.stdout, b"DESCRIPT-BYTES\n");
    assert_eq!(output.stderr, b"DESCRIPT-ERR\n");
    assert_eq!(output.exit_code, 0);
    assert!(!output.timed_out);
    assert!(!output.canceled);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_nonzero_exit_code_is_reported_verbatim_not_interpreted() {
    let base = temp_base("exitcode");
    let tool = build_dummy(&base, "dummy.exe");
    let content = std::fs::read(&tool).unwrap();
    let svc = service(&base, 5_000);
    // The dummy's `compile` mode exits with a fixed code; the service's
    // serialization selects that mode. The test asserts the code was
    // REPORTED — it does not ask what it means (that vocabulary is the
    // tool's, and only the client reads it, above the boundary).
    let request = NativeCompileRequest {
        source: b"hls".to_vec(),
        source_identity: "a".repeat(64),
        target: "gglab-dx12".to_string(),
        stage: "vertex".to_string(),
        entry: "main".to_string(),
        defines: vec![],
        includes: vec![],
    };
    let attempt = svc.compile(&candidate(&tool, &content), &request).unwrap();
    let result = attempt.settle.join().unwrap();
    let output = unwrap_spawned(result);
    assert_eq!(output.exit_code, 4);
    assert!(!output.timed_out && !output.canceled);
    let _ = std::fs::remove_dir_all(&base);
}

// ---------------------------------------------------------------- budget

#[test]
fn timeout_ends_the_attempt_with_the_flag_and_any_captured_bytes() {
    let base = temp_base("timeout");
    // A slow copy of the SAME program: the budget must end it.
    let tool = build_dummy(&base, "slow-dummy-sleep.exe");
    let content = std::fs::read(&tool).unwrap();
    let svc = service(&base, 400); // budget < the dummy's sleep
    let result = svc.handshake(&candidate(&tool, &content));
    let output = unwrap_spawned(result);
    assert!(output.timed_out, "the budget must end the attempt");
    assert!(!output.canceled);
    // The end state is the fact: nothing is fabricated after the end.
    assert_eq!(output.stdout, Vec::<u8>::new());
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn cancel_ends_the_attempt_with_the_flag() {
    let base = temp_base("cancel");
    let tool = build_dummy(&base, "slow-dummy-sleep.exe");
    let content = std::fs::read(&tool).unwrap();
    let svc = service(&base, 10_000);
    let request = NativeCompileRequest {
        source: b"hls".to_vec(),
        source_identity: "b".repeat(64),
        target: "gglab-vulkan13".to_string(),
        stage: "pixel".to_string(),
        entry: "main".to_string(),
        defines: vec![],
        includes: vec![],
    };
    let attempt = svc.compile(&candidate(&tool, &content), &request).unwrap();
    // Explicit cancel — an action, with a value.
    let outcome = svc.cancel(attempt.build_id);
    assert!(outcome.canceled && !outcome.already_settled);
    let result = attempt.settle.join().unwrap();
    let output = unwrap_spawned(result);
    assert!(output.canceled, "cancel must end the attempt as canceled");
    assert!(!output.timed_out);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn cancel_after_settlement_reports_already_settled_and_changes_nothing() {
    let base = temp_base("cancel-settled");
    let tool = build_dummy(&base, "dummy.exe");
    let content = std::fs::read(&tool).unwrap();
    let svc = service(&base, 5_000);
    let request = NativeCompileRequest {
        source: b"hls".to_vec(),
        source_identity: "c".repeat(64),
        target: "gglab-dx12".to_string(),
        stage: "vertex".to_string(),
        entry: "main".to_string(),
        defines: vec![],
        includes: vec![],
    };
    let attempt = svc.compile(&candidate(&tool, &content), &request).unwrap();
    let settled = attempt.settle.join().unwrap();
    let _ = settled; // the settlement stands on its own
    let outcome = svc.cancel(attempt.build_id);
    assert!(!outcome.canceled, "a settled attempt cannot be canceled");
    assert!(outcome.already_settled);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn cancel_on_an_unknown_identity_reports_already_settled() {
    let base = temp_base("cancel-unknown");
    let svc = service(&base, 5_000);
    let outcome = svc.cancel(BuildId { sequence: 999_999 });
    assert!(!outcome.canceled);
    assert!(outcome.already_settled);
    let _ = std::fs::remove_dir_all(&base);
}

// ---------------------------------------------------------------- provenance

#[test]
fn a_replaced_file_is_refused_with_the_current_observed_identity() {
    let base = temp_base("provenance-changed");
    let tool = base.join("dummy.exe");
    let first = b"tool-content-first";
    std::fs::write(&tool, first).unwrap();
    let svc = service(&base, 5_000);
    // The candidate observed the FIRST content; the file now holds MORE.
    std::fs::write(&tool, b"tool-content-second").unwrap();
    let second_identity = gglab_shader_graph_editor::hash_file(&tool).unwrap();
    let result = svc.handshake(&candidate(&tool, first));
    match result {
        BoundaryResult::CandidateInvalidated { observation, observed_identity, .. } => {
            assert_eq!(observation, CandidateObservation::Changed);
            assert_eq!(observed_identity, Some(second_identity));
        }
        other => panic!("expected candidate-invalidated, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_missing_file_is_refused_as_missing() {
    let base = temp_base("provenance-missing");
    let tool = base.join("absent.exe");
    let svc = service(&base, 5_000);
    let result = svc.handshake(&candidate(&tool, b"never-was"));
    match result {
        BoundaryResult::CandidateInvalidated { observation, observed_identity, .. } => {
            assert_eq!(observation, CandidateObservation::Missing);
            assert_eq!(observed_identity, None);
        }
        other => panic!("expected candidate-invalidated, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn an_unlaunchable_executable_is_a_launch_failed_fact() {
    let base = temp_base("launch-failed");
    let tool = base.join("not-a-real-binary.exe");
    // Bytes that are NOT an executable: the provenance check PASSES (the
    // identity is exactly these bytes), and only the spawn fails.
    let content = b"this is not a program";
    std::fs::write(&tool, content).unwrap();
    let svc = service(&base, 5_000);
    let result = svc.handshake(&candidate(&tool, content));
    match result {
        BoundaryResult::LaunchFailed { .. } => {}
        other => panic!("expected launch-failed, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&base);
}

// ---------------------------------------------------------------- serialization

#[test]
fn the_compile_invocation_is_serialized_structurally_and_in_order() {
    let base = temp_base("argv");
    let tool = build_dummy(&base, "dummy.exe");
    let content = std::fs::read(&tool).unwrap();
    let svc = service(&base, 5_000);
    let identity = "0123456789abcdef".repeat(4); // 64 hex, the stable form
    let request = NativeCompileRequest {
        source: b"generated HLSL bytes".to_vec(),
        source_identity: identity.clone(),
        target: "gglab-dx12".to_string(),
        stage: "vertex".to_string(),
        entry: "main".to_string(),
        defines: vec![
            gglab_shader_graph_editor::CompileDefine {
                name: "DEBUG".into(),
                value: "1".into(),
            },
            gglab_shader_graph_editor::CompileDefine {
                name: "PLAIN".into(),
                value: String::new(),
            },
        ],
        includes: vec![base.join("inc").to_string_lossy().into_owned()],
    };
    let attempt = svc.compile(&candidate(&tool, &content), &request).unwrap();
    let output = unwrap_spawned(attempt.settle.join().unwrap());
    // The dummy echoed the complete argv, unit-separated. The test
    // asserts the EXACT sequence — structural arguments, no shell, in
    // the grammar's order.
    let argv: Vec<String> = String::from_utf8(output.stdout)
        .unwrap()
        .split('\u{1}')
        .map(|s| s.to_string())
        .collect();
    let private = |relative: &str| {
        base.join("toolchain-service")
            .join(relative)
            .to_string_lossy()
            .into_owned()
    };
    let staging = private(&format!("staging/{}", attempt.build_id.sequence));
    let cache = private("cache");
    let artifacts = private(&format!("artifacts/{}", attempt.build_id.sequence));
    let canonical = |value: String| value.replace('\\', "/");
    let expected: Vec<String> = [
        "compile",
        "--source-root",
        "SOURCE_ROOT",
        "--source",
        "SOURCE_NAME",
        "--stage",
        "vertex",
        "--entry",
        "main",
        "--target",
        "gglab-dx12",
        "--define",
        "DEBUG=1",
        "--define",
        "PLAIN",
        "--include",
        "INCLUDE_DIR",
        "--cache-root",
        "CACHE_ROOT",
        "--artifact-root",
        "ARTIFACT_ROOT",
        "--result-format",
        "json",
    ]
    .iter()
    .map(|item| match *item {
        "SOURCE_ROOT" => canonical(staging.clone()),
        "SOURCE_NAME" => canonical(format!("{identity}.hlsl")),
        "INCLUDE_DIR" => canonical(base.join("inc").to_string_lossy().into_owned()),
        "CACHE_ROOT" => canonical(cache.clone()),
        "ARTIFACT_ROOT" => canonical(artifacts.clone()),
        other => other.to_string(),
    })
    .collect();
    let actual: Vec<String> = argv.into_iter().map(|item| canonical(item)).collect();
    // The sequence is asserted EXACTLY — order, flags, and values —
    // with path separators normalized (the OS owns the path form).
    assert_eq!(actual, expected);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn the_staged_source_is_written_per_attempt_and_cleaned_after_settlement() {
    let base = temp_base("staging");
    let tool = build_dummy(&base, "dummy.exe");
    let content = std::fs::read(&tool).unwrap();
    let svc = service(&base, 5_000);
    let identity = "f".repeat(64);
    let request = NativeCompileRequest {
        source: b"emitted bytes".to_vec(),
        source_identity: identity.clone(),
        target: "gglab-vulkan13".to_string(),
        stage: "compute".to_string(),
        entry: "main".to_string(),
        defines: vec![],
        includes: vec![],
    };
    let attempt = svc.compile(&candidate(&tool, &content), &request).unwrap();
    let staged = base
        .join("toolchain-service")
        .join("staging")
        .join(attempt.build_id.sequence.to_string())
        .join(format!("{identity}.hlsl"));
    assert!(
        staged.exists(),
        "the emission must be staged for the attempt (name = the identity)"
    );
    assert_eq!(std::fs::read(&staged).unwrap(), b"emitted bytes");
    let _ = attempt.settle.join().unwrap();
    assert!(
        !staged.exists(),
        "the per-attempt staging must be cleaned once the attempt settles"
    );
    let _ = std::fs::remove_dir_all(&base);
}

// ---------------------------------------------------------------- allowance

#[test]
fn a_malformed_request_shape_is_a_structured_refusal() {
    let base = temp_base("shape");
    let svc = service(&base, 5_000);
    let bad = NativeCompileRequest {
        source: Vec::new(), // the emitted bytes are missing
        source_identity: "a".repeat(64),
        target: "gglab-dx12".into(),
        stage: "vertex".into(),
        entry: "main".into(),
        defines: vec![],
        includes: vec![],
    };
    let tool = base.join("dummy.exe");
    match svc.compile(&candidate(&tool, b"whatever"), &bad) {
        Err(ServiceError::RequestShape { field, .. }) => assert_eq!(field, "source"),
        other => panic!("expected a request-shape refusal, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn an_identity_that_is_not_a_64_hex_digest_is_refused() {
    let base = temp_base("shape-identity");
    let svc = service(&base, 5_000);
    let bad = NativeCompileRequest {
        source: b"x".to_vec(),
        source_identity: "not-a-digest".to_string(),
        target: "gglab-dx12".into(),
        stage: "vertex".into(),
        entry: "main".into(),
        defines: vec![],
        includes: vec![],
    };
    let tool = base.join("dummy.exe");
    match svc.compile(&candidate(&tool, b"whatever"), &bad) {
        Err(ServiceError::RequestShape { field, .. }) => assert_eq!(field, "sourceIdentity"),
        other => panic!("expected a request-shape refusal, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&base);
}
