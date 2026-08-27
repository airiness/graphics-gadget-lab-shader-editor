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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BoundaryResult {
    Spawned {
        output: BoundaryOutput,
    },
    CandidateInvalidated {
        candidate: ToolCandidate,
        observation: CandidateObservation,
        /// The identity the path observes now — present (and meaningful)
        /// only when `observation` is `Changed`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observed_identity: Option<String>,
    },
    LaunchFailed {
        candidate: ToolCandidate,
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
