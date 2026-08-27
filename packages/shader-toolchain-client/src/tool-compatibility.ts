/**
 * The ToolCompatibility state machine — the client's verdict over the
 * TOOL itself (design authority: the toolchain integration design,
 * section 6). The build's readiness is a separate state space composed by
 * the editor, never mixed here: the same executable must not oscillate
 * between incompatible and compatible when the TARGET changes, because
 * target coverage is one build's compatibility, judged where the
 * configuration lives.
 *
 * Tool-side transitions fire only on tool-side events. The handshake is
 * the operation that establishes or refreshes proof, and it stays legal
 * for any RESOLVED candidate — discovered, unproven, and incompatible
 * alike; refusing it on unproven would make compatible unreachable. Only
 * `unavailable` has no candidate to handshake.
 *
 * Every RESOLVED state carries its candidate — the state owns the
 * current candidate, and the proof owns the proof facts (the contract
 * axis it was taken under). One invariant follows, and it closes the
 * async race the client explicitly supports (in-flight handshakes and
 * compiles settling out of order): a CANDIDATE-SCOPED event (a handshake
 * settlement, a candidate invalidation) applies ONLY to the candidate
 * the state currently carries; a settlement that lands over a different
 * candidate is stale — the machine ignores it, exactly as the build line
 * never lets a slow old attempt become current. A refuted candidate
 * observation (changed / missing / unreadable, reported alike on a
 * handshake or a compile attempt) is that lifecycle event: the
 * observation is no longer a FACT and, if it is the current one, the
 * tool returns to `unavailable` until a fresh discovery + handshake
 * re-enters. A candidate-resolved event is the one that may SUPERSEDE
 * the current candidate — a new observation is a new fact.
 *
 * A handshake CANCELED by the operator is NOT tool evidence: no fact was
 * reported, so the state stays as it was.
 */
import type { HandshakeRejection } from "./handshake-document.js";
import type { ContractSupportVerdict } from "./contract-range.js";
import type { ToolDiagnostic, ToolFacts, ToolRequirement } from "./contract-facts.js";
import type { CandidateObservation, ToolCandidate } from "./host-boundary.js";
import { candidatesEqual } from "./host-boundary.js";
import type { ChannelViolation, HandshakeProcessOutcome } from "./process-output.js";
import {
    judgeToolIdentity,
    judgeToolVersion,
    type IdentityVerdict,
    type VersionVerdict,
} from "./verdicts.js";

/** One structured unproven reason — what the client knows about WHY the
 *  proof is missing, visible and explainable. */
export type UnprovenReason =
    | {
        readonly reason: "contract-not-supported";
        readonly contract: ContractSupportVerdict;
      }
    | {
        readonly reason: "handshake-facts-absent";
        readonly detail: string;
        readonly diagnostics: readonly ToolDiagnostic[];
      }
    | {
        readonly reason: "handshake-unreadable";
        readonly rejection: HandshakeRejection;
      }
    | {
        readonly reason: "channel-violated";
        readonly violation: ChannelViolation;
      }
    | { readonly reason: "handshake-timed-out" }
    | { readonly reason: "launch-failed" };

/** One structured incompatibility — a fact the tool itself reports
 *  contradicting the required one, with both sides visible. */
export type CompatibilityMismatch =
    | {
        readonly kind: "identity";
        readonly identity: IdentityVerdict;
      }
    | {
        readonly kind: "version";
        readonly version: VersionVerdict;
      }
    | {
        readonly kind: "contract-axis";
        readonly contract: ContractSupportVerdict;
      };

/** The proof the client holds: the proof FACTS — the contract axis the
 *  facts were proven under. The candidate the proof was taken under is
 *  NOT stored here: the compatible state itself owns the current
 *  candidate, and the proof inherently applies to it (one authority for
 *  "which candidate", one for "what was proven about it"). */
export interface ToolProof {
    readonly processContractVersion: number;
}

/** The tool's state as the client judges it — and its ownership rules:
 *  EVERY resolved state carries the candidate it is about; a candidate-
 *  scoped event applies only to that candidate (see
 *  `applyCompatibilityEvent`). `unavailable` means NO currently valid
 *  resolved candidate: the discovery rules found nothing, or the resolved
 *  observation was refuted (invalidated) by the host at spawn time. It
 *  is the initial state, and the state the tool returns to until
 *  discovery and handshake re-establish a candidate and its proof. */
export type ToolCompatibilityState =
    | { readonly status: "unavailable" }
    | { readonly status: "discovered"; readonly candidate: ToolCandidate }
    | {
        readonly status: "unproven";
        readonly candidate: ToolCandidate;
        readonly reasons: readonly UnprovenReason[];
      }
    | {
        readonly status: "incompatible";
        readonly candidate: ToolCandidate;
        readonly mismatches: readonly CompatibilityMismatch[];
      }
    | {
        readonly status: "compatible";
        readonly candidate: ToolCandidate;
        readonly provenFacts: ToolFacts;
        readonly proof: ToolProof;
      };

/** The state before any discovery event: the tool is not resolvable. */
export const initialToolState: ToolCompatibilityState = { status: "unavailable" };

/**
 * What the state machine receives for a handshake: the boundary's
 * settlement, fully read. `spawned` carries the PROCESS-LEVEL outcome of
 * the read — the terminal states (canceled, timed-out), the channel
 * discipline (channel-violated), the unsupported-axis observation, the
 * structured rejection, or the intact document (read); `launch-failed`
 * is the bounded-execution launch failure. Candidate invalidation does
 * NOT ride a handshake settlement: it is its own lifecycle event below
 * (the host reports it on a handshake or on a compile attempt alike).
 * The readers do the parsing, the axis gate, and the channel judgment;
 * the machine does the state judgment.
 */
export type HandshakeSettlement =
    | { readonly kind: "spawned"; readonly process: HandshakeProcessOutcome }
    | { readonly kind: "launch-failed" };

/**
 * A tool-side event. `handshake` carries the candidate observation
 * actually handshook and its settlement (see `HandshakeSettlement`).
 * `candidate-invalidated` is a candidate LIFECYCLE event — the host's
 * provenance refutation fires here whether it was reported on a
 * handshake or a compile attempt, so the machine is total over every
 * source: the refuted observation stops being a valid candidate FACT,
 * any proof bound to it is void, and the tool returns to `unavailable`
 * until discovery produces a fresh observation.
 */
export type CompatibilityEvent =
    | { readonly kind: "discovery-failed" }
    | { readonly kind: "candidate-resolved"; readonly candidate: ToolCandidate }
    | { readonly kind: "candidate-lost" }
    | {
        readonly kind: "candidate-invalidated";
        readonly candidate: ToolCandidate;
        readonly observation: CandidateObservation;
        readonly observedIdentity: string | null;
      }
    | {
        readonly kind: "handshake";
        readonly candidate: ToolCandidate;
        readonly result: HandshakeSettlement;
      };

/** The stable judgment input the machine holds for the session: the
 *  requirement (from the descriptor, mapped by the editor). The
 *  contract-axis judgment arrived earlier with the reading itself — the
 *  reader gated the axis against the client's declaration before the
 *  machine ever saw it — so the machine's own job is identity and
 *  version, plus mapping the axis judgment it was handed. */
export interface CompatibilityJudgment {
    readonly requirement: ToolRequirement;
}

function factsFromHandshake(document: {
    readonly toolIdentity: string;
    readonly toolVersion: string;
    readonly processContractVersion: number;
    readonly producerKind: string;
    readonly producerIdentity: string;
    readonly supportedTargets: readonly string[];
}): ToolFacts {
    return {
        toolIdentity: document.toolIdentity,
        toolVersion: document.toolVersion,
        processContractVersion: document.processContractVersion,
        producerKind: document.producerKind,
        producerIdentity: document.producerIdentity,
        supportedTargets: [...document.supportedTargets],
    };
}

/**
 * Applies one tool-side event to a state. Total and pure: an event the
 * state cannot act on (a handshake while unavailable) leaves the state
 * unchanged — the refusal is expressed by the admission gates below, and
 * the state stays honest.
 */
export function applyCompatibilityEvent(
    state: ToolCompatibilityState,
    event: CompatibilityEvent,
    judgment: CompatibilityJudgment,
): ToolCompatibilityState {
    if (event.kind === "discovery-failed" || event.kind === "candidate-lost") {
        return { status: "unavailable" };
    }
    // The host refuted the resolved observation at spawn time (changed /
    // missing / unreadable — on a handshake or a compile attempt, both).
    // `discovered` is a FACT; a refuted observation is no longer a fact,
    // so the tool returns to `unavailable` — no currently valid resolved
    // candidate — where its proof is void and there is nothing to
    // handshake. Only a fresh discovery + handshake re-enters.
    // A candidate-scoped event applies ONLY to the candidate the state
    // currently carries: a settlement that lands after discovery has
    // moved on is stale and is ignored — the same class of race the
    // build line already closes for slow old attempts.
    if (
        event.kind === "candidate-invalidated" &&
        (state.status === "unavailable" || !candidatesEqual(state.candidate, event.candidate))
    ) {
        return state;
    }
    if (event.kind === "candidate-invalidated") {
        // The host refuted the resolved observation at spawn time
        // (changed / missing / unreadable — on a handshake or a compile
        // attempt, both). `discovered` is a FACT; a refuted observation
        // is no longer a fact, so the tool returns to `unavailable` —
        // no currently valid resolved candidate — where its proof is
        // void and there is nothing to handshake. Only a fresh discovery
        // + handshake re-enters.
        return { status: "unavailable" };
    }
    if (event.kind === "candidate-resolved") {
        // A newly resolved candidate is a FACT — proof is established by
        // the handshake, so even a previously compatible tool returns to
        // `discovered` and re-enters through (re-)handshake. A changed
        // observation (same path, new binary) is a different candidate:
        // the old proof stops applying with it. This is the ONE event
        // that may supersede the current candidate: a new observation is
        // a new fact.
        return { status: "discovered", candidate: event.candidate };
    }

    // handshake: legal for any resolved state carrying THIS candidate;
    // over a different candidate (a stale async settlement) or over
    // `unavailable`, a no-op — exactly as a slow old attempt never
    // becomes current in the build line.
    if (state.status === "unavailable" || !candidatesEqual(state.candidate, event.candidate)) {
        return state;
    }
    const candidate = event.candidate;

    // A settled handshake closes every path: the pre-spawn refusals and
    // the launch failure are HOST facts; the spawned settlement is read
    // at the process level (terminal states, channel discipline, the
    // axis, the document) before the state judgment.
    const result = event.result;
    if (result.kind === "launch-failed") {
        // Bounded execution itself could not launch the candidate: a
        // structured fact, not a crash.
        return { status: "unproven", candidate, reasons: [{ reason: "launch-failed" }] };
    }

    const process = result.process;
    if (process.kind === "canceled") {
        // A cancel is an operator action, not tool evidence: no fact was
        // reported, so the state stays exactly as it was.
        return state;
    }
    if (process.kind === "timed-out") {
        return { status: "unproven", candidate, reasons: [{ reason: "handshake-timed-out" }] };
    }
    if (process.kind === "channel-violated") {
        return {
            status: "unproven",
            candidate,
            reasons: [{ reason: "channel-violated", violation: process.violation }],
        };
    }
    if (process.kind === "rejected") {
        return {
            status: "unproven",
            candidate,
            reasons: [{ reason: "handshake-unreadable", rejection: process.rejection }],
        };
    }
    if (process.kind === "unsupported-contract") {
        const contract = process.contract;
        if (contract.supported !== false) {
            // unreachable: this outcome exists exactly for the refusal
            throw new Error("an unsupported-contract reading carrying a supported verdict is impossible");
        }
        if (contract.reason === "no-supported-contract-declared") {
            // The client declares no supported contract at all: the
            // honest state is unproven, not a contradiction the tool
            // could fix.
            return {
                status: "unproven",
                candidate,
                reasons: [{ reason: "contract-not-supported", contract }],
            };
        }
        // The client supports a declared range and the tool reports an
        // axis outside it: the tool's own facts contradict the required
        // ones — incompatible.
        return {
            status: "incompatible",
            candidate,
            mismatches: [{ kind: "contract-axis", contract }],
        };
    }

    const document = process.document;
    if (document.success !== true) {
        return {
            status: "unproven",
            candidate,
            reasons: [
                {
                    reason: "handshake-facts-absent",
                    detail: `the handshake reported ${document.status} (exit ${document.exitCode})`,
                    diagnostics: [...document.diagnostics],
                },
            ],
        };
    }

    const facts = factsFromHandshake(document);
    const identity = judgeToolIdentity(judgment.requirement, facts);
    const version = judgeToolVersion(judgment.requirement, facts);
    const mismatches: CompatibilityMismatch[] = [];
    if (identity.status !== "match") {
        mismatches.push({ kind: "identity", identity });
    }
    if (version.status !== "meets-minimum") {
        mismatches.push({ kind: "version", version });
    }
    if (mismatches.length > 0) {
        return { status: "incompatible", candidate, mismatches };
    }
    return {
        status: "compatible",
        candidate,
        provenFacts: facts,
        proof: { processContractVersion: document.processContractVersion },
    };
}

/** The structured refusal the client returns instead of an operation —
 *  named in the design's NotReady reason vocabulary so the editor's
 *  composition can surface each one verbatim. */
export type AdmissionReason =
    | { readonly reason: "tool-unavailable" }
    | { readonly reason: "tool-discovered"; readonly detail: string }
    | { readonly reason: "tool-unproven"; readonly reasons: readonly UnprovenReason[] }
    | { readonly reason: "tool-incompatible"; readonly mismatches: readonly CompatibilityMismatch[] }
    | { readonly reason: "proof-not-for-this-candidate"; readonly detail: string };

export type OperationAdmission =
    | { readonly admitted: true }
    | { readonly admitted: false; readonly reasons: readonly AdmissionReason[] };

/**
 * The handshake is legal for every RESOLVED candidate — it is the
 * operation that establishes or refreshes proof, the way out of
 * unproven and incompatible, and the re-entry after a same-path update.
 */
export function admitHandshake(state: ToolCompatibilityState): OperationAdmission {
    if (state.status === "unavailable") {
        return { admitted: false, reasons: [{ reason: "tool-unavailable" }] };
    }
    return { admitted: true };
}

/**
 * A COMPILE request is never formed from an unavailable, discovered,
 * unproven, or incompatible tool: each refusal is structured and carries
 * the state's own reasons. Only a compatible, proven tool admits one —
 * and only for the EXACT candidate observation its proof was taken
 * under: a changed observation (same path, a replaced binary) means the
 * proof does not apply to this candidate, and the refusal says so.
 */
export function admitCompile(
    state: ToolCompatibilityState,
    candidate: ToolCandidate,
): OperationAdmission {
    if (state.status === "compatible") {
        if (candidatesEqual(state.candidate, candidate)) {
            return { admitted: true };
        }
        // The compatible state's proof inherently applies to ITS
        // candidate: a different candidate (path or provenance changed)
        // is a different observation the proof was not taken under.
        return {
            admitted: false,
            reasons: [
                {
                    reason: "proof-not-for-this-candidate",
                    detail:
                        "the proof was taken under a different candidate observation (path or provenance changed); " +
                        "re-resolve and re-handshake this candidate",
                },
            ],
        };
    }
    if (state.status === "unavailable") {
        return { admitted: false, reasons: [{ reason: "tool-unavailable" }] };
    }
    if (state.status === "discovered") {
        return {
            admitted: false,
            reasons: [
                {
                    reason: "tool-discovered",
                    detail: "a candidate resolved, but no handshake has proven it; the handshake is legal now and is the path to proof",
                },
            ],
        };
    }
    if (state.status === "unproven") {
        return { admitted: false, reasons: [{ reason: "tool-unproven", reasons: state.reasons }] };
    }
    return { admitted: false, reasons: [{ reason: "tool-incompatible", mismatches: state.mismatches }] };
}
