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
 */
import type { HandshakeReadOutcome } from "./handshake-document.js";
import type { SupportedContractRange } from "./contract-range.js";
import { judgeContractSupport, type ContractSupportVerdict } from "./contract-range.js";
import type { ToolDiagnostic, ToolFacts, ToolRequirement } from "./contract-facts.js";
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
      };

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

/** The proof the client holds: the contract axis the facts were proven
 *  under (the facts themselves are kept beside it). */
export interface ToolProof {
    readonly processContractVersion: number;
}

/** The tool's state as the client judges it. `unavailable` is the initial
 *  state: no candidate resolved by the discovery rules. */
export type ToolCompatibilityState =
    | { readonly status: "unavailable" }
    | { readonly status: "discovered" }
    | {
        readonly status: "unproven";
        readonly reasons: readonly UnprovenReason[];
      }
    | {
        readonly status: "incompatible";
        readonly mismatches: readonly CompatibilityMismatch[];
      }
    | {
        readonly status: "compatible";
        readonly provenFacts: ToolFacts;
        readonly proof: ToolProof;
      };

/** The state before any discovery event: the tool is not resolvable. */
export const initialToolState: ToolCompatibilityState = { status: "unavailable" };

/** A tool-side event. `handshake` carries the CLIENT-SIDE reading of the
 *  published document (a well-read document or an explicit structured
 *  refusal) — the reader does the parsing, the machine does the judgment. */
export type CompatibilityEvent =
    | { readonly kind: "discovery-failed" }
    | { readonly kind: "candidate-resolved" }
    | { readonly kind: "candidate-lost" }
    | { readonly kind: "handshake"; readonly read: HandshakeReadOutcome };

/** The stable judgment inputs the machine holds for the session: the
 *  requirement (from the descriptor, mapped by the editor) and the
 *  client's declared supported range (null: declares no contract). */
export interface CompatibilityJudgment {
    readonly requirement: ToolRequirement;
    readonly supportedRange: SupportedContractRange | null;
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
    if (event.kind === "candidate-resolved") {
        // A newly resolved candidate is a FACT — proof is established by
        // the handshake, so even a previously compatible tool returns to
        // `discovered` and re-enters through (re-)handshake.
        return { status: "discovered" };
    }

    // handshake: legal for any resolved candidate; with none, a no-op.
    if (state.status === "unavailable") {
        return state;
    }

    if (event.read.status === "rejected") {
        return {
            status: "unproven",
            reasons: [
                {
                    reason: "handshake-facts-absent",
                    detail: `${event.read.rejection.reason}: ${event.read.rejection.detail}`,
                    diagnostics: [],
                },
            ],
        };
    }
    const document = event.read.document;
    if (document.success !== true) {
        return {
            status: "unproven",
            reasons: [
                {
                    reason: "handshake-facts-absent",
                    detail: `the handshake reported ${document.status} (exit ${document.exitCode})`,
                    diagnostics: [...document.diagnostics],
                },
            ],
        };
    }

    const contract = judgeContractSupport(
        document.processContractVersion,
        judgment.supportedRange,
    );
    if (contract.supported !== true) {
        if (contract.reason === "no-supported-contract-declared") {
            // The client declares no supported contract at all: the
            // honest state is unproven, not a contradiction the tool
            // could fix.
            return {
                status: "unproven",
                reasons: [{ reason: "contract-not-supported", contract }],
            };
        }
        // The client supports a declared range and the tool reports an
        // axis outside it: the tool's own facts contradict the required
        // ones — incompatible.
        return {
            status: "incompatible",
            mismatches: [{ kind: "contract-axis", contract }],
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
        return { status: "incompatible", mismatches };
    }
    return {
        status: "compatible",
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
    | { readonly reason: "tool-incompatible"; readonly mismatches: readonly CompatibilityMismatch[] };

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
 * the state's own reasons. Only a compatible, proven tool admits one.
 */
export function admitCompile(state: ToolCompatibilityState): OperationAdmission {
    if (state.status === "compatible") {
        return { admitted: true };
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
