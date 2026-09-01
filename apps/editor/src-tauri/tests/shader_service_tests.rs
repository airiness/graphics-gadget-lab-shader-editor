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
    hash_bytes, BoundaryResult, BuildId, CandidateObservation, DiscoveryRule, NativeCompileRequest,
    NativePreviewBuildRequest, PreviewObservationHostReadResult,
    PreviewRuntimeAvailabilityObservation, PreviewRuntimeExitKind, PreviewRuntimeLaunchResult,
    ServiceError, ShaderToolService, ToolCandidate, ToolchainRoots,
};

fn temp_base(name: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!("gglab-host-tests-{name}"));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    base
}

/// Compile the dummy tool with plain rustc and return the executable.
fn build_dummy(dir: &Path, name: &str) -> PathBuf {
    build_fixture(dir, name, "dummy_tool.rs")
}

fn build_fixture(dir: &Path, name: &str, fixture: &str) -> PathBuf {
    let out = dir.join(name);
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixture")
        .join(fixture);
    let status = std::process::Command::new("rustc")
        .args([
            "--edition",
            "2021",
            "-O",
            "-o",
            out.to_str().unwrap(),
            source.to_str().unwrap(),
        ])
        .status()
        .expect("rustc must be available to build the dummy tool");
    assert!(
        status.success(),
        "the dummy tool must compile (status {status:?})"
    );
    out
}

fn build_preview_runtime(dir: &Path) -> PathBuf {
    build_fixture(dir, "GraphicsGadgetLab.exe", "dummy_preview_runtime.rs")
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

fn preview_request(attempt_sequence: u64) -> NativePreviewBuildRequest {
    NativePreviewBuildRequest {
        session_id: "12".repeat(16),
        target_profile: "gglab-dx12".to_string(),
        profile_id: "gglab.surface".to_string(),
        profile_version: 2,
        preview_input_contract_id: "gglab.preview-input.surface.texture2d".to_string(),
        preview_program_descriptor_identity: "a".repeat(64),
        generated_source_identity: "b".repeat(64),
        generated_source_bytes: b"generated Preview HLSL".to_vec(),
        attempt_sequence,
    }
}

fn preview_observation_path(base: &Path, session_id: &str) -> PathBuf {
    base.join("ShaderArtifacts")
        .join("shader-preview-sessions")
        .join(session_id)
        .join("observed.ggsh.preview-observed")
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
fn preview_handshake_executes_the_dedicated_command_on_the_exact_candidate() {
    let base = temp_base("preview-handshake");
    let tool = build_dummy(&base, "dummy.exe");
    let content = std::fs::read(&tool).unwrap();
    let svc = service(&base, 5_000);
    let output = unwrap_spawned(svc.preview_handshake(&candidate(&tool, &content)));
    assert_eq!(output.stdout, b"PREVIEW-DESCRIPT-BYTES\n");
    assert_eq!(output.stderr, b"PREVIEW-DESCRIPT-ERR\n");
    assert_eq!(output.exit_code, 0);
    assert!(!output.timed_out && !output.canceled);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn preview_observation_read_is_candidate_and_session_scoped_and_bounded() {
    let base = temp_base("preview-observation-read");
    let tool = build_dummy(&base, "dummy.exe");
    let content = std::fs::read(&tool).unwrap();
    let bound_candidate = candidate(&tool, &content);
    let svc = service(&base, 5_000);
    let session_id = "34".repeat(16);

    assert_eq!(
        svc.read_preview_observation(&bound_candidate, &session_id)
            .unwrap(),
        PreviewObservationHostReadResult::NotFound
    );

    let path = preview_observation_path(&base, &session_id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let bytes: Vec<u8> = (0..90).collect();
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(
        svc.read_preview_observation(&bound_candidate, &session_id)
            .unwrap(),
        PreviewObservationHostReadResult::Read {
            bytes: bytes.clone()
        }
    );

    std::fs::write(&path, vec![7_u8; 91]).unwrap();
    assert_eq!(
        svc.read_preview_observation(&bound_candidate, &session_id)
            .unwrap(),
        PreviewObservationHostReadResult::TooLarge
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn preview_observation_read_refuses_bad_session_ids_before_touching_the_candidate() {
    let base = temp_base("preview-observation-session-shape");
    let missing_tool = base.join("missing.exe");
    let svc = service(&base, 5_000);
    let unobservable = candidate(&missing_tool, b"never existed");

    match svc.read_preview_observation(&unobservable, "../outside") {
        Err(ServiceError::RequestShape { field, .. }) => assert_eq!(field, "sessionId"),
        other => panic!("expected session request-shape refusal, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn preview_observation_read_never_uses_a_changed_candidate_deployment() {
    let base = temp_base("preview-observation-provenance");
    let tool = base.join("dummy.exe");
    let observed = b"observed candidate";
    std::fs::write(&tool, observed).unwrap();
    let bound_candidate = candidate(&tool, observed);
    std::fs::write(&tool, b"replacement candidate").unwrap();
    let svc = service(&base, 5_000);

    match svc
        .read_preview_observation(&bound_candidate, &"56".repeat(16))
        .unwrap()
    {
        PreviewObservationHostReadResult::CandidateInvalidated {
            candidate,
            observation: CandidateObservation::Changed,
            observed_identity: Some(identity),
        } => {
            assert_eq!(candidate, bound_candidate);
            assert_eq!(identity, hash_bytes(b"replacement candidate"));
        }
        other => panic!("expected changed-candidate refusal, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn attached_preview_runtime_launch_is_candidate_scoped_exact_and_single_flight() {
    let base = temp_base("preview-runtime-launch");
    let tool = build_dummy(&base, "gglab-shaderc.exe");
    let runtime = build_preview_runtime(&base);
    let tool_content = std::fs::read(&tool).unwrap();
    let runtime_content = std::fs::read(&runtime).unwrap();
    let bound_candidate = candidate(&tool, &tool_content);
    let svc = service(&base, 5_000);
    let session_id = "78".repeat(16);

    let admission = svc
        .launch_preview_runtime(&bound_candidate, &session_id)
        .unwrap();
    let (runtime_id, settle) = match (admission.result, admission.settle) {
        (
            PreviewRuntimeLaunchResult::Launched {
                runtime_id,
                runtime_identity,
            },
            Some(settle),
        ) => {
            assert_eq!(runtime_identity, hash_bytes(&runtime_content));
            (runtime_id, settle)
        }
        other => panic!("expected one launched Runtime, got {other:?}"),
    };

    let record_path = base.join("preview-runtime-launch.txt");
    for _ in 0..100 {
        if record_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let record = std::fs::read_to_string(record_path).unwrap();
    let mut lines = record.lines();
    let expected_args = [
        "--lab",
        "gglab.lab.shader_graph_preview",
        "--shader-preview-session",
        session_id.as_str(),
        "--absolute-mouse",
    ]
    .join("\u{1}");
    assert_eq!(lines.next(), Some(expected_args.as_str()));
    assert_eq!(
        PathBuf::from(lines.next().unwrap()).canonicalize().unwrap(),
        base.canonicalize().unwrap()
    );

    let duplicate = svc
        .launch_preview_runtime(&bound_candidate, &session_id)
        .unwrap();
    assert_eq!(
        duplicate.result,
        PreviewRuntimeLaunchResult::SessionAlreadyRunning { runtime_id }
    );
    assert!(duplicate.settle.is_none());

    let stopped = svc.stop_preview_runtime(runtime_id);
    assert!(stopped.stop_requested && !stopped.already_settled);
    let exit = settle.join().unwrap();
    assert_eq!(exit.runtime_id, runtime_id);
    assert_eq!(exit.kind, PreviewRuntimeExitKind::Stopped);
    assert!(svc.stop_preview_runtime(runtime_id).already_settled);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn attached_preview_runtime_refuses_missing_runtime_and_changed_candidate() {
    let base = temp_base("preview-runtime-refusals");
    let tool = build_dummy(&base, "gglab-shaderc.exe");
    let tool_content = std::fs::read(&tool).unwrap();
    let bound_candidate = candidate(&tool, &tool_content);
    let svc = service(&base, 5_000);
    let session_id = "9a".repeat(16);

    let missing = svc
        .launch_preview_runtime(&bound_candidate, &session_id)
        .unwrap();
    assert_eq!(
        missing.result,
        PreviewRuntimeLaunchResult::RuntimeUnavailable {
            observation: PreviewRuntimeAvailabilityObservation::Missing
        }
    );
    assert!(missing.settle.is_none());

    std::fs::write(&tool, b"changed candidate").unwrap();
    let changed = svc
        .launch_preview_runtime(&bound_candidate, &session_id)
        .unwrap();
    assert!(matches!(
        changed.result,
        PreviewRuntimeLaunchResult::CandidateInvalidated {
            observation: CandidateObservation::Changed,
            ..
        }
    ));
    assert!(changed.settle.is_none());
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn dropping_the_host_service_stops_and_reaps_an_attached_preview_runtime() {
    let base = temp_base("preview-runtime-service-drop");
    let tool = build_dummy(&base, "gglab-shaderc.exe");
    let _runtime = build_preview_runtime(&base);
    let tool_content = std::fs::read(&tool).unwrap();
    let bound_candidate = candidate(&tool, &tool_content);
    let svc = service(&base, 5_000);

    let admission = svc
        .launch_preview_runtime(&bound_candidate, &"ab".repeat(16))
        .unwrap();
    let settle = admission.settle.expect("the attached Runtime must launch");
    assert!(matches!(
        admission.result,
        PreviewRuntimeLaunchResult::Launched { .. }
    ));

    drop(svc);
    let exit = settle.join().unwrap();
    assert_eq!(exit.kind, PreviewRuntimeExitKind::Stopped);
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
fn preview_handshake_uses_the_bounded_handshake_budget() {
    let base = temp_base("preview-handshake-timeout");
    let tool = build_dummy(&base, "slow-dummy-sleep.exe");
    let content = std::fs::read(&tool).unwrap();
    let svc = service(&base, 400);
    let output = unwrap_spawned(svc.preview_handshake(&candidate(&tool, &content)));
    assert!(output.timed_out);
    assert!(!output.canceled);
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
fn preview_operations_never_spawn_a_candidate_with_a_changed_observation() {
    let base = temp_base("preview-provenance-changed");
    let tool = base.join("dummy.exe");
    let observed = b"preview-tool-first";
    std::fs::write(&tool, observed).unwrap();
    let bound_candidate = candidate(&tool, observed);
    std::fs::write(&tool, b"preview-tool-replaced").unwrap();
    let current_identity = gglab_shader_graph_editor::hash_file(&tool).unwrap();
    let svc = service(&base, 5_000);

    for result in [
        svc.preview_handshake(&bound_candidate),
        svc.build_preview(&bound_candidate, &preview_request(1))
            .unwrap()
            .settle
            .join()
            .unwrap(),
    ] {
        match result {
            BoundaryResult::CandidateInvalidated {
                candidate,
                observation,
                observed_identity,
            } => {
                assert_eq!(candidate, bound_candidate);
                assert_eq!(observation, CandidateObservation::Changed);
                assert_eq!(observed_identity, Some(current_identity.clone()));
            }
            other => panic!("expected Preview candidate-invalidated, got {other:?}"),
        }
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
fn the_preview_invocation_contains_only_approved_intent_and_host_derived_roots() {
    let base = temp_base("preview-argv");
    let tool = build_dummy(&base, "dummy.exe");
    let content = std::fs::read(&tool).unwrap();
    let svc = service(&base, 5_000);
    let request = preview_request(41);
    let attempt = svc
        .build_preview(&candidate(&tool, &content), &request)
        .unwrap();
    let output = unwrap_spawned(attempt.settle.join().unwrap());
    assert_eq!(
        output.exit_code, 5,
        "the raw dummy exit code is not interpreted"
    );
    let actual: Vec<String> = String::from_utf8(output.stdout)
        .unwrap()
        .split('\u{1}')
        .map(|value| value.replace('\\', "/"))
        .collect();
    let private = base.join("toolchain-service");
    let staging = private
        .join("staging")
        .join(attempt.build_id.sequence.to_string());
    let source = staging.join(format!("{}.hlsl", request.generated_source_identity));
    let expected = vec![
        "build-preview".to_string(),
        "--source-root".to_string(),
        base.join("Shaders").to_string_lossy().replace('\\', "/"),
        "--generated-source".to_string(),
        source.to_string_lossy().replace('\\', "/"),
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
        base.join("ShaderCache")
            .to_string_lossy()
            .replace('\\', "/"),
        "--artifact-root".to_string(),
        base.join("ShaderArtifacts")
            .to_string_lossy()
            .replace('\\', "/"),
        "--result-format".to_string(),
        "json".to_string(),
    ];
    assert_eq!(actual, expected);
    assert_eq!(output.stderr, b"PREVIEW-BUILD-ERR-BYTES\n");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn preview_build_staging_is_per_host_attempt_cancellable_and_cleaned() {
    let base = temp_base("preview-staging-cancel");
    let tool = build_dummy(&base, "slow-dummy-sleep.exe");
    let content = std::fs::read(&tool).unwrap();
    let svc = service(&base, 10_000);
    let request = preview_request(9);
    let attempt = svc
        .build_preview(&candidate(&tool, &content), &request)
        .unwrap();
    let staged = base
        .join("toolchain-service")
        .join("staging")
        .join(attempt.build_id.sequence.to_string())
        .join(format!("{}.hlsl", request.generated_source_identity));
    assert_eq!(
        std::fs::read(&staged).unwrap(),
        request.generated_source_bytes
    );
    let canceled = svc.cancel(attempt.build_id);
    assert!(canceled.canceled && !canceled.already_settled);
    let output = unwrap_spawned(attempt.settle.join().unwrap());
    assert!(output.canceled && !output.timed_out);
    assert!(
        !staged.exists(),
        "Preview staging must be cleaned on cancel settlement"
    );
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
fn unsorted_defines_are_a_structured_refusal() {
    let base = temp_base("shape-defines");
    let svc = service(&base, 5_000);
    let bad = NativeCompileRequest {
        source: b"emitted bytes".to_vec(),
        source_identity: "a".repeat(64),
        target: "gglab-dx12".into(),
        stage: "vertex".into(),
        entry: "main".into(),
        defines: vec![
            gglab_shader_graph_editor::CompileDefine { name: "B".into(), value: "1".into() },
            gglab_shader_graph_editor::CompileDefine { name: "A".into(), value: "2".into() },
        ],
        includes: vec![],
    };
    let tool = base.join("dummy.exe");
    match svc.compile(&candidate(&tool, b"whatever"), &bad) {
        Err(ServiceError::RequestShape { field, .. }) => assert_eq!(field, "defines"),
        other => panic!("expected a request-shape refusal, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn an_empty_source_is_well_formed_like_the_client_declares() {
    // The client's isWellFormedRequest accepts the empty byte array; the
    // host mirror must not invent a stricter rule (conformance fixture
    // "empty-source" locks this from both sides).
    let base = temp_base("shape-empty-source");
    let svc = service(&base, 5_000);
    let request = NativeCompileRequest {
        source: Vec::new(),
        source_identity: "a".repeat(64),
        target: "gglab-dx12".into(),
        stage: "vertex".into(),
        entry: "main".into(),
        defines: vec![],
        includes: vec![],
    };
    let tool = build_dummy(&base, "dummy.exe");
    let content = std::fs::read(&tool).unwrap();
    let attempt = svc.compile(&candidate(&tool, &content), &request).unwrap();
    let _ = attempt.settle.join().unwrap();
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
