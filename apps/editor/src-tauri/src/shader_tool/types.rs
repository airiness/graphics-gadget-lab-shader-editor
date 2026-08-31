//! The boundary's DTO surface — the exact shapes the toolchain client
//! package declares (`packages/shader-toolchain-client/src/host-boundary.ts`,
//! `native-compile-request.ts`), one to one. Field names are camelCase on
//! the wire by design: the client package READS these values strictly, and
//! this service is the product implementation of the same contract the
//! reference fake implements.
//!
//! What these types are NOT:
//!
//! - no argv — `NativeCompileRequest` is the domain-shaped request; the
//!   serialization into the tool's invocation is host-internal (see
//!   `service.rs`);
//! - no protocol content — `BoundaryOutput` is raw bytes plus exit code
//!   plus the timeout/cancel state, and nothing interprets them here;
//! - no readiness — the service cannot be asked whether a request is a
//!   good one; that judgment lives above it.

/// One concrete asynchronous attempt, ordered within its session. Session-
/// local: the service allocates it, the client records it; both axes (what
/// it compiles vs. which attempt it is) stay separate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BuildId {
    pub sequence: u64,
}

/// The discovery rules the tool resolution walks, first hit wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscoveryRule {
    #[serde(rename = "explicit-config")]
    ExplicitConfig,
    #[serde(rename = "sibling-build")]
    SiblingBuild,
    #[serde(rename = "bundled")]
    Bundled,
}

/// A resolved candidate — a FACT record of one candidate observation, never
/// a readiness claim. `observation_identity` is the host-generated identity
/// of the file at the moment of resolution (here: a SHA-256 content hash,
/// the host's opaque token — the client never parses it). `resolved_at` is
/// session time in epoch milliseconds — observation METADATA, not identity.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCandidate {
    pub rule: DiscoveryRule,
    pub tool_path: String,
    pub observation_identity: String,
    pub resolved_at: u64,
}

/// One structured failure reason for one discovery rule — closed
/// vocabulary, one per rule that did not resolve.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DiscoveryRuleFailure {
    pub rule: DiscoveryRule,
    /// `not-configured` (the rule's input was not present), `missing`
    /// (no entry at the expected location), `not-a-file` (an entry is
    /// there, but it is not a file), or `identity-unreadable` (a file the
    /// host could not read to observe its identity).
    pub reason: String,
}

/// The discovery configuration the service resolves over its host facts.
/// Bookkeeping input: which of the three rule inputs the configuration
/// supplied.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverRequest {
    /// An explicit path the user set in editor settings, when present —
    /// the executable itself.
    #[serde(default)]
    pub explicit_config: Option<String>,
    /// A configured sibling GGLab build-output DIRECTORY, when present —
    /// the executable is expected as its `gglab-shaderc.exe` child.
    #[serde(default)]
    pub sibling_build_output: Option<String>,
    /// Whether this deployment bundles the tool next to the service's own
    /// executable (absent in development).
    pub bundled: bool,
}

/// Discovery outcome: the first resolved candidate, or one structured
/// failure reason per rule that did not resolve. Discovery neither
/// executes the tool nor interprets any of its output.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverOutcome {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<ToolCandidate>,
    pub failures: Vec<DiscoveryRuleFailure>,
}

/// The boundary's ENTIRE output surface: raw stdout bytes, raw stderr
/// bytes, the process exit code, and the timeout/cancel state. No parsed
/// document, no verdict, no diagnostics — those are the client's work on
/// the bytes, on the other side of this boundary.
///
/// Byte representation on the wire: serde serializes a `Vec<u8>` as a
/// JSON array of byte values (one `number` per byte). The TS adapter is
/// the one that materializes those arrays into `Uint8Array`; it may not
/// `as`-cast a plain array into one and pass it to the client readers.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
    pub timed_out: bool,
    pub canceled: bool,
}

/// The host's provenance observation when a candidate was refuted at
/// spawn time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum CandidateObservation {
    /// The path holds a DIFFERENT file than the candidate observed (its
    /// current identity is reported by the refusal, for re-discovery).
    #[serde(rename = "changed")]
    Changed,
    /// No file at the path anymore.
    #[serde(rename = "missing")]
    Missing,
    /// A file that cannot be observed (no readable handle).
    #[serde(rename = "unreadable")]
    Unreadable,
}

/// The settlement of a handshake or compile call. An OUTCOME, always a
/// value: a spawn happened (raw output surface), or the host's pre-spawn
/// provenance check refused (`candidate-invalidated`), or bounded execution
/// itself could not launch (`launch-failed`). Never an exception, never an
/// OS error code promoted to protocol, never a forged output.
///
/// Wire names are EXPLICIT, not derived: the client's vocabulary is the
/// kebab-case `kind` values and camelCase fields it declares
/// (`host-boundary.ts`), and serde's `rename_all` on an enum only renames
/// VARIANTS — the tag values and the struct-variant fields each need
/// their own `rename`. The serialization golden test locks these names;
/// do not "simplify" them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind")]
pub enum BoundaryResult {
    #[serde(rename = "spawned")]
    Spawned {
        output: BoundaryOutput,
    },
    #[serde(rename = "candidate-invalidated")]
    CandidateInvalidated {
        candidate: ToolCandidate,
        observation: CandidateObservation,
        /// The identity the path observes now — `null` except when
        /// `observation` is `Changed`, where it is the live identity.
        /// Always present on the wire (the client declares `string |
        /// null`, and a missing key is not the same as a null value).
        #[serde(default, rename = "observedIdentity")]
        observed_identity: Option<String>,
    },
    #[serde(rename = "launch-failed")]
    LaunchFailed {
        candidate: ToolCandidate,
    },
}

/// One compiler-free read of the Runtime's Preview observation record. This
/// is deliberately not a tool operation: the host derives the path from the
/// candidate deployment plus SessionId, bounds the bytes, and leaves the
/// record's protocol meaning to the TypeScript client.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind")]
pub enum PreviewObservationHostReadResult {
    #[serde(rename = "read")]
    Read { bytes: Vec<u8> },
    #[serde(rename = "not-found")]
    NotFound,
    #[serde(rename = "too-large")]
    TooLarge,
    #[serde(rename = "read-failed")]
    ReadFailed,
    #[serde(rename = "candidate-invalidated")]
    CandidateInvalidated {
        candidate: ToolCandidate,
        observation: CandidateObservation,
        #[serde(default, rename = "observedIdentity")]
        observed_identity: Option<String>,
    },
}

/// `cancel(buildId)` outcome — always a value: the attempt was in flight
/// and is now canceled, or it had already settled (cancel reports that and
/// changes nothing).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelOutcome {
    pub build_id: BuildId,
    pub canceled: bool,
    pub already_settled: bool,
}

/// One define of the domain request, `NAME[=VALUE]` on the wire grammar.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CompileDefine {
    pub name: String,
    pub value: String,
}

/// The domain-shaped compile request — the client's `NativeCompileRequest`,
/// one to one. It is the boundary's INPUT vocabulary, not an argv: the
/// serialization into the tool's invocation is host-internal and owns no
/// DXC/backend policy.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCompileRequest {
    /// The exact generated HLSL bytes — the core's emission, delivered by
    /// value; the service stages them in its private per-attempt area.
    pub source: Vec<u8>,
    /// The SHA-256 of those exact bytes — the core's durable content
    /// identity (64 lowercase hex).
    pub source_identity: String,
    pub target: String,
    pub stage: String,
    pub entry: String,
    pub defines: Vec<CompileDefine>,
    pub includes: Vec<String>,
}

/// The dedicated Preview build request — one to one with the client's
/// `NativePreviewBuildRequest`. It carries Preview intent and identities only;
/// the service owns private paths and invocation serialization, while the
/// toolchain owns adapter/PSMain/compiler/publication policy.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewBuildRequest {
    pub session_id: String,
    pub target_profile: String,
    pub profile_id: String,
    pub profile_version: u64,
    pub preview_input_contract_id: String,
    pub preview_program_descriptor_identity: String,
    pub generated_source_identity: String,
    pub generated_source_bytes: Vec<u8>,
    pub attempt_sequence: u64,
}

#[cfg(test)]
mod wire_shape_tests {
    //! Serialization golden tests: these lock the EXACT wire names the
    //! client package reads — kind values, field names, and which keys
    //! are present. Any rename in the client vocabulary breaks these,
    //! which is how a cross-language drift is found at compile-run time
    //! instead of at runtime.

    use super::*;

    fn sample_candidate() -> ToolCandidate {
        ToolCandidate {
            rule: DiscoveryRule::ExplicitConfig,
            tool_path: "C:/tools/gglab-shaderc.exe".to_string(),
            observation_identity: "a".repeat(64),
            resolved_at: 1721000000000,
        }
    }

    #[test]
    fn the_spawned_settlement_serializes_with_the_clients_kind_and_keys() {
        let result = BoundaryResult::Spawned {
            output: BoundaryOutput {
                stdout: vec![1, 2, 3],
                stderr: vec![],
                exit_code: 4,
                timed_out: false,
                canceled: true,
            },
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["kind"], "spawned");
        assert_eq!(value["output"]["stdout"], serde_json::json!([1, 2, 3]));
        assert_eq!(value["output"]["stderr"], serde_json::json!([]));
        assert_eq!(value["output"]["exitCode"], 4);
        assert_eq!(value["output"]["timedOut"], false);
        assert_eq!(value["output"]["canceled"], true);
        // No other top-level keys: the client's strict reader sees exactly
        // the declared shape.
        let keys: Vec<&str> = value.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(keys, vec!["kind", "output"]);
    }

    #[test]
    fn the_candidate_invalidated_settlement_carries_the_live_identity_as_null_or_value() {
        let changed = BoundaryResult::CandidateInvalidated {
            candidate: sample_candidate(),
            observation: CandidateObservation::Changed,
            observed_identity: Some("b".repeat(64)),
        };
        let value = serde_json::to_value(&changed).unwrap();
        assert_eq!(value["kind"], "candidate-invalidated");
        assert_eq!(value["observation"], "changed");
        assert_eq!(value["observedIdentity"], "b".repeat(64));
        assert_eq!(value["candidate"]["rule"], "explicit-config");
        assert_eq!(value["candidate"]["toolPath"], "C:/tools/gglab-shaderc.exe");

        // A missing observation is a NULL identity, and the key is
        // PRESENT — the client declares `string | null`.
        let missing = BoundaryResult::CandidateInvalidated {
            candidate: sample_candidate(),
            observation: CandidateObservation::Missing,
            observed_identity: None,
        };
        let value = serde_json::to_value(&missing).unwrap();
        assert_eq!(value["kind"], "candidate-invalidated");
        assert_eq!(value["observation"], "missing");
        assert!(value.get("observedIdentity").is_some(), "the key must be present");
        assert!(value["observedIdentity"].is_null(), "…and null, not missing");
    }

    #[test]
    fn the_launch_failed_settlement_is_a_value_with_only_the_candidate() {
        let result = BoundaryResult::LaunchFailed {
            candidate: sample_candidate(),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["kind"], "launch-failed");
        let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["candidate", "kind"]);
    }

    #[test]
    fn the_preview_observation_read_shape_materializes_bytes_and_candidate_facts() {
        let read = PreviewObservationHostReadResult::Read {
            bytes: vec![0, 1, 255],
        };
        let value = serde_json::to_value(read).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "kind": "read", "bytes": [0, 1, 255] })
        );

        let invalidated = PreviewObservationHostReadResult::CandidateInvalidated {
            candidate: sample_candidate(),
            observation: CandidateObservation::Changed,
            observed_identity: Some("b".repeat(64)),
        };
        let value = serde_json::to_value(invalidated).unwrap();
        assert_eq!(value["kind"], "candidate-invalidated");
        assert_eq!(value["observation"], "changed");
        assert_eq!(value["observedIdentity"], "b".repeat(64));
        assert_eq!(value["candidate"]["toolPath"], "C:/tools/gglab-shaderc.exe");
    }

    #[test]
    fn the_cancel_outcome_serializes_with_the_clients_key_names() {
        let outcome = CancelOutcome {
            build_id: BuildId { sequence: 7 },
            canceled: true,
            already_settled: false,
        };
        let value = serde_json::to_value(&outcome).unwrap();
        assert_eq!(value["buildId"]["sequence"], 7);
        assert_eq!(value["canceled"], true);
        assert_eq!(value["alreadySettled"], false);
    }

    #[test]
    fn the_discover_wire_shape_is_optional_candidate_plus_failures() {
        let outcome = DiscoverOutcome {
            candidate: Some(sample_candidate()),
            failures: vec![DiscoveryRuleFailure {
                rule: DiscoveryRule::SiblingBuild,
                reason: "missing".to_string(),
            }],
        };
        let value = serde_json::to_value(&outcome).unwrap();
        assert_eq!(value["candidate"]["resolvedAt"], 1_721_000_000_000_u64);
        assert_eq!(value["failures"][0]["rule"], "sibling-build");
        assert_eq!(value["failures"][0]["reason"], "missing");

        // No candidate: the key is absent (the client declares it
        // optional).
        let empty = DiscoverOutcome {
            candidate: None,
            failures: Vec::new(),
        };
        let value = serde_json::to_value(&empty).unwrap();
        assert!(value.get("candidate").is_none());
        assert_eq!(value["failures"], serde_json::json!([]));
    }

    #[test]
    fn the_preview_request_wire_shape_contains_intent_and_identities_but_no_paths() {
        let request = NativePreviewBuildRequest {
            session_id: "12".repeat(16),
            target_profile: "gglab-dx12".to_string(),
            profile_id: "gglab.surface".to_string(),
            profile_version: 2,
            preview_input_contract_id: "gglab.preview-input.surface.texture2d".to_string(),
            preview_program_descriptor_identity: "a".repeat(64),
            generated_source_identity: "b".repeat(64),
            generated_source_bytes: vec![1, 2, 3],
            attempt_sequence: 7,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["sessionId"], "12".repeat(16));
        assert_eq!(value["targetProfile"], "gglab-dx12");
        assert_eq!(value["generatedSourceBytes"], serde_json::json!([1, 2, 3]));
        assert_eq!(value["attemptSequence"], 7);
        let keys = value.as_object().unwrap();
        assert!(!keys.contains_key("sourceRoot"));
        assert!(!keys.contains_key("cacheRoot"));
        assert!(!keys.contains_key("artifactRoot"));
        assert!(!keys.contains_key("stage"));
        assert!(!keys.contains_key("entry"));
    }
}
