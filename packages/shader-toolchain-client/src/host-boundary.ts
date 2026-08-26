/**
 * The declared host boundary (design authority: the toolchain integration
 * design, section 9): exactly four allowlisted capabilities and their
 * request/result shapes — no generic spawn, no protocol interpretation,
 * no readiness logic, and no argv anywhere in the TypeScript world.
 *
 * The client package DECLARES this contract. Two independent
 * implementations exist for it and never import each other:
 *
 * - the product implementation: the Tauri ShaderToolService, whose whole
 *   job is host-internal — validate the allowlisted request shape,
 *   serialize an APPROVED request into the tool's invocation (structural
 *   arguments, no shell string, no backend policy), execute bounded
 *   (timeout, cancel, whole-output capture), and stage per attempt;
 * - the reference fake in this package (testing/fake-host-boundary): the
 *   test-side implementation of the same boundary, deterministic, with no
 *   process and no argv.
 *
 * The boundary's output is exactly this: the raw stdout bytes, the raw
 * stderr bytes, the exit code, and the timeout/cancel state. Envelope
 * parsing, status interpretation, channel discipline (the contract
 * places exactly one machine document on stdout and leaves stderr
 * EMPTY), version comparison, and diagnostic classification all happen
 * above it, on the client's readers — the raw bytes and exit code ARE
 * the boundary's entire output. The host owns bounded execution; it
 * captures both streams, it never interprets either one.
 *
 * And one guarantee the boundary owes the client: a spawn happens ONLY
 * after the host's provenance check confirms the candidate's path still
 * observes the candidate's identity — otherwise the call settles as the
 * structured `candidate-invalidated` refusal, not a spawn of an unverified
 * executable; and bounded execution failing to launch at all settles as
 * the structured `launch-failed` fact. Neither is a crash, an exception,
 * a forged output, or an OS error code promoted to protocol (see
 * `BoundaryResult`).
 *
 * TOCTOU is part of the contract: the check-to-launch window must be
 * closed by a real provenance guard (for example a file handle held with
 * a share mode that blocks write/delete/replace until process creation
 * settles) — "look at the metadata, then CreateProcess(a path)" is NOT
 * continuity and does not satisfy this boundary.
 */
import type { BuildId, NativeCompileRequest } from "./native-compile-request.js";

/** The discovery rules the tool resolution walks, first hit wins. */
export type DiscoveryRule = "explicit-config" | "sibling-build" | "bundled";

/** A resolved candidate — a FACT record of one candidate observation,
 *  never a readiness claim. */
export interface ToolCandidate {
    readonly rule: DiscoveryRule;
    readonly toolPath: string;
    /** The host-generated observation identity of the file AT the moment
     *  of resolution (file identity, size/mtime, a hash, or the host's
     *  opaque provenance token — the host implementation decides what it
     *  is). A changed observation of the same path — the binary replaced
     *  under the path — is a DIFFERENT candidate, and a proof taken under
     *  the old observation stops applying. */
    readonly observationIdentity: string;
    /** Session time (epoch milliseconds) the candidate resolved.
     *  OBSERVATION METADATA for inspection — NOT part of the candidate's
     *  identity: looking at the same unmodified executable again does
     *  not invalidate a proof. */
    readonly resolvedAt: number;
}

/**
 * Two candidate observations are the same when their identity facts
 * agree: the path and the observed identity of the file at that path.
 * The discovery rule is WHERE the path was found (not what the
 * executable is), and `resolvedAt` is when it was looked at — neither
 * is identity. Same unmodified executable under the same path: the same
 * candidate, no matter how often it is re-resolved or found by a
 * different rule.
 */
export function candidatesEqual(a: ToolCandidate, b: ToolCandidate): boolean {
    return a.toolPath === b.toolPath && a.observationIdentity === b.observationIdentity;
}

/** One structured failure reason for one discovery rule. */
export interface DiscoveryRuleFailure {
    readonly rule: DiscoveryRule;
    readonly reason: string;
}

/** The discovery configuration the service resolves over its host facts. */
export interface DiscoverRequest {
    /** An explicit path the user set in editor settings, when present. */
    readonly explicitConfig?: string | undefined;
    /** A configured sibling GGLab build-output location, when present. */
    readonly siblingBuildOutput?: string | undefined;
    /** Whether a bundled deployment exists (absent in development). */
    readonly bundled: boolean;
}

/** Discovery outcome: the first resolved candidate, or one structured
 *  failure reason per failed rule — discovery is bookkeeping over
 *  configuration facts, and it neither executes the tool nor interprets
 *  any of its output. */
export interface DiscoverOutcome {
    readonly candidate?: ToolCandidate | undefined;
    readonly failures: readonly DiscoveryRuleFailure[];
}

/**
 * The boundary's entire output: raw stdout bytes, raw stderr bytes,
 * exit code, and the timeout/cancel state. No parsed document, no
 * verdict, no diagnostics, no channel judgment — those are the client's
 * work on the bytes.
 */
export interface BoundaryOutput {
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
    readonly exitCode: number;
    readonly timedOut: boolean;
    readonly canceled: boolean;
}

/** compile is issued, then settled: the handle carries the attempt's
 *  BuildId and its eventual settlement (execution output, or the
 *  structured pre-spawn refusal — candidate-invalidated / launch-failed).
 * */
export interface CompileAttemptHandle {
    readonly buildId: BuildId;
    readonly result: Promise<BoundaryResult>;
}

export interface CancelOutcome {
    readonly buildId: BuildId;
    /** True when the attempt was in flight and is now explicit
     *  `canceled`; a canceled attempt's output settles accordingly. */
    readonly canceled: boolean;
    /** True when the attempt had already settled — cancel reports that
     *  fact and changes nothing. */
    readonly alreadySettled: boolean;
}

/**
 * The settlement of a handshake or compile call. An OUTCOME, always a
 * value — and the candidate's provenance is part of it:
 *
 * - `spawned` — execution happened (bounded, whole-output captured); the
 *   raw output surface is the boundary's entire result;
 * - `candidate-invalidated` — the host's pre-spawn provenance check
 *   failed: the path is now `changed` (a different identity than the
 *   candidate carried — its current identity is reported, for
 *   re-discovery), `missing` (no file anymore), or `unreadable` (a file
 *   that cannot be observed). The host did NOT spawn.
 * - `launch-failed` — bounded execution itself could not launch the
 *   candidate (a host-side launch failure, structured; not an OS error
 *   code promoted to protocol, and not the host interpreting anything
 *   above it).
 *
 * This is the boundary's guarantee: `handshake(candidate)` and
 * `compile(candidate, request)` only spawn an executable whose current
 * observation matches the candidate they were given. What the candidate
 * identity MEANS (file identity, size/mtime, a hash, an opaque host
 * token) is the host implementation's business; the check-before-spawn
 * semantics and these structured failures are the contract's.
 */
export type CandidateObservation = "changed" | "missing" | "unreadable";

export type BoundaryResult =
    | { readonly kind: "spawned"; readonly output: BoundaryOutput }
    | {
        readonly kind: "candidate-invalidated";
        readonly candidate: ToolCandidate;
        readonly observation: CandidateObservation;
        /** The identity the path observes now — only present (and
         *  meaningful) when `observation` is `"changed"`. */
        readonly observedIdentity: string | null;
      }
    | { readonly kind: "launch-failed"; readonly candidate: ToolCandidate };

/**
 * The four capabilities and their shapes. The service implements this
 * boundary and nothing else: it cannot be asked to spawn an argv, to
 * judge a readiness, or to read a protocol.
 */
export interface HostToolBoundary {
    discover(request: DiscoverRequest): Promise<DiscoverOutcome>;
    /**
     * Handshakes the tool AT the candidate path, after the pre-spawn
     * provenance check: spawned-and-executed output, or the structured
     * candidate-invalidated / launch-failed refusal — never a spawn of an
     * unverified executable, never an OS-error exception.
     */
    handshake(candidate: ToolCandidate): Promise<BoundaryResult>;
    /** Compiles by spawning the tool at the candidate path — the EXACT
     *  candidate the editor holds (and, for proof, the candidate the
     *  client's proof was taken under) — under the same pre-spawn
     *  provenance guarantee. The boundary owns no "current tool" of its
     *  own. */
    compile(candidate: ToolCandidate, request: NativeCompileRequest): Promise<CompileAttemptHandle>;
    cancel(buildId: BuildId): Promise<CancelOutcome>;
}
