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
    /** Session time (epoch milliseconds) the candidate resolved. */
    readonly resolvedAt: number;
}

/** Two candidate observations are the same when every observation fact
 *  agrees — path, provenance identity, rule, and resolution moment. */
export function candidatesEqual(a: ToolCandidate, b: ToolCandidate): boolean {
    return (
        a.rule === b.rule &&
        a.toolPath === b.toolPath &&
        a.observationIdentity === b.observationIdentity &&
        a.resolvedAt === b.resolvedAt
    );
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
 *  BuildId and its eventual output. */
export interface CompileAttemptHandle {
    readonly buildId: BuildId;
    readonly result: Promise<BoundaryOutput>;
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
 * The four capabilities and their shapes. The service implements this
 * boundary and nothing else: it cannot be asked to spawn an argv, to
 * judge a readiness, or to read a protocol.
 */
export interface HostToolBoundary {
    discover(request: DiscoverRequest): Promise<DiscoverOutcome>;
    /** Handshakes the tool AT the candidate path; the result bytes are
     *  the client's to read. */
    handshake(candidate: ToolCandidate): Promise<BoundaryOutput>;
    /** Compiles by spawning the tool at the candidate path — the EXACT
     *  candidate the editor holds (and, for proof, the candidate the
     *  client's proof was taken under). The boundary owns no "current
     *  tool" of its own. */
    compile(candidate: ToolCandidate, request: NativeCompileRequest): Promise<CompileAttemptHandle>;
    cancel(buildId: BuildId): Promise<CancelOutcome>;
}
