/**
 * Pure eligibility judgment for the dedicated Preview operation. Ordinary
 * tool proof stays authoritative for the executable; the Preview handshake
 * must be from that exact candidate and must report continuous tool/producer
 * facts before its Preview-specific capabilities can admit a build.
 */
import type { ToolDiagnostic, ToolFacts } from "./contract-facts.js";
import type { ContractSupportVerdict } from "./contract-range.js";
import { judgeContractSupport } from "./contract-range.js";
import { candidatesEqual, type ToolCandidate } from "./host-boundary.js";
import type { PreviewHandshakeSuccessDocument } from "./preview-handshake-document.js";
import {
    clientSupportedPreviewActivePublicationSchemaRange,
    clientSupportedPreviewObservationSchemaRange,
    clientSupportedPreviewProgramDescriptorRange,
    clientSupportedPreviewPublicationSchemaRange,
} from "./preview-contract-range-declaration.js";
import type { ChannelViolation, PreviewHandshakeProcessOutcome } from "./process-output.js";
import type { ToolCompatibilityState } from "./tool-compatibility.js";

export interface PreviewInputContractRequirement {
    readonly id: string;
    readonly profileId: string;
    readonly profileVersion: number;
}

export interface PreviewEligibilityRequirement {
    readonly targetProfile: string;
    readonly previewProgramDescriptorIdentity: string;
    readonly inputContract: PreviewInputContractRequirement;
}

/** One Preview handshake result together with the exact candidate whose
 *  executable produced it. Keep this pair intact from host invocation through
 *  eligibility judgment: Preview proof may never travel to another candidate
 *  observation, even when that candidate reports identical protocol facts. */
export interface CandidateBoundPreviewHandshake {
    readonly candidate: ToolCandidate;
    readonly process: PreviewHandshakeProcessOutcome;
}

export type PreviewContinuityField =
    | "toolIdentity"
    | "toolVersion"
    | "processContractVersion"
    | "compilePolicyRevision"
    | "producerKind"
    | "producerIdentity";

export type PreviewCompatibilityMismatch =
    | {
          readonly kind: "ordinary-fact-discontinuity";
          readonly field: PreviewContinuityField;
          readonly ordinary: string | number;
          readonly preview: string | number;
      }
    | { readonly kind: "target-unsupported"; readonly targetProfile: string }
    | { readonly kind: "descriptor-schema-unsupported"; readonly contract: ContractSupportVerdict }
    | {
          readonly kind: "descriptor-identity-mismatch";
          readonly requiredIdentity: string;
          readonly observedIdentity: string;
      }
    | { readonly kind: "input-contract-unsupported"; readonly required: PreviewInputContractRequirement }
    | {
          readonly kind: "publication-schema-unsupported";
          readonly surface: "publication" | "active-publication" | "observation";
          readonly contract: ContractSupportVerdict;
      }
    | {
          readonly kind: "process-contract-unsupported" | "preview-contract-unsupported";
          readonly contract: ContractSupportVerdict;
      };

export type PreviewUnprovenReason =
    | { readonly reason: "ordinary-tool-not-proven"; readonly toolStatus: ToolCompatibilityState["status"] }
    | { readonly reason: "proof-not-for-this-candidate" }
    | { readonly reason: "preview-handshake-canceled" }
    | { readonly reason: "preview-handshake-timed-out" }
    | { readonly reason: "preview-channel-violated"; readonly violation: ChannelViolation }
    | { readonly reason: "preview-handshake-unreadable"; readonly detail: string }
    | {
          readonly reason: "preview-handshake-facts-absent";
          readonly status: string;
          readonly diagnostics: readonly ToolDiagnostic[];
      }
    | {
          readonly reason: "no-supported-contract-declared";
          readonly axis: "process" | "preview";
          readonly contract: ContractSupportVerdict;
      };

export type PreviewEligibility =
    | {
          readonly status: "eligible";
          readonly candidate: ToolCandidate;
          readonly facts: PreviewHandshakeSuccessDocument;
      }
    | {
          readonly status: "unproven";
          readonly candidate: ToolCandidate;
          readonly reasons: readonly PreviewUnprovenReason[];
      }
    | {
          readonly status: "incompatible";
          readonly candidate: ToolCandidate;
          readonly mismatches: readonly PreviewCompatibilityMismatch[];
      };

function continuityMismatches(
    ordinary: ToolFacts,
    preview: PreviewHandshakeSuccessDocument,
): PreviewCompatibilityMismatch[] {
    const mismatches: PreviewCompatibilityMismatch[] = [];
    for (const field of [
        "toolIdentity",
        "toolVersion",
        "processContractVersion",
        "compilePolicyRevision",
        "producerKind",
        "producerIdentity",
    ] as const) {
        if (ordinary[field] !== preview[field]) {
            mismatches.push({
                kind: "ordinary-fact-discontinuity",
                field,
                ordinary: ordinary[field],
                preview: preview[field],
            });
        }
    }
    return mismatches;
}

function addAxisMismatch(
    mismatches: PreviewCompatibilityMismatch[],
    observed: number,
    surface: "descriptor" | "publication" | "active-publication" | "observation",
): void {
    const range =
        surface === "descriptor"
            ? clientSupportedPreviewProgramDescriptorRange
            : surface === "publication"
              ? clientSupportedPreviewPublicationSchemaRange
              : surface === "active-publication"
                ? clientSupportedPreviewActivePublicationSchemaRange
                : clientSupportedPreviewObservationSchemaRange;
    const contract = judgeContractSupport(observed, range);
    if (contract.supported) {
        return;
    }
    if (surface === "descriptor") {
        mismatches.push({ kind: "descriptor-schema-unsupported", contract });
        return;
    }
    mismatches.push({ kind: "publication-schema-unsupported", surface, contract });
}

/** Judges one already-read Preview handshake against ordinary proof and the
 *  concrete Preview intent the editor wants to form. */
export function judgePreviewEligibility(
    tool: ToolCompatibilityState,
    handshake: CandidateBoundPreviewHandshake,
    requirement: PreviewEligibilityRequirement,
): PreviewEligibility {
    const { candidate, process } = handshake;
    if (tool.status !== "compatible") {
        return {
            status: "unproven",
            candidate,
            reasons: [{ reason: "ordinary-tool-not-proven", toolStatus: tool.status }],
        };
    }
    if (!candidatesEqual(tool.candidate, candidate)) {
        return {
            status: "unproven",
            candidate,
            reasons: [{ reason: "proof-not-for-this-candidate" }],
        };
    }
    if (process.kind === "canceled") {
        return {
            status: "unproven",
            candidate,
            reasons: [{ reason: "preview-handshake-canceled" }],
        };
    }
    if (process.kind === "timed-out") {
        return {
            status: "unproven",
            candidate,
            reasons: [{ reason: "preview-handshake-timed-out" }],
        };
    }
    if (process.kind === "channel-violated") {
        return {
            status: "unproven",
            candidate,
            reasons: [{ reason: "preview-channel-violated", violation: process.violation }],
        };
    }
    if (process.kind === "rejected") {
        return {
            status: "unproven",
            candidate,
            reasons: [{ reason: "preview-handshake-unreadable", detail: process.rejection.detail }],
        };
    }
    if (process.kind === "unsupported-process-contract" || process.kind === "unsupported-preview-contract") {
        const axis = process.kind === "unsupported-process-contract" ? "process" : "preview";
        if (
            process.contract.supported === false &&
            process.contract.reason === "no-supported-contract-declared"
        ) {
            return {
                status: "unproven",
                candidate,
                reasons: [{ reason: "no-supported-contract-declared", axis, contract: process.contract }],
            };
        }
        return {
            status: "incompatible",
            candidate,
            mismatches: [
                {
                    kind: axis === "process" ? "process-contract-unsupported" : "preview-contract-unsupported",
                    contract: process.contract,
                },
            ],
        };
    }

    if (process.document.success !== true) {
        return {
            status: "unproven",
            candidate,
            reasons: [
                {
                    reason: "preview-handshake-facts-absent",
                    status: process.document.status,
                    diagnostics: [...process.document.diagnostics],
                },
            ],
        };
    }

    const preview = process.document;
    const mismatches = continuityMismatches(tool.provenFacts, preview);
    if (!preview.supportedTargets.includes(requirement.targetProfile)) {
        mismatches.push({ kind: "target-unsupported", targetProfile: requirement.targetProfile });
    }
    addAxisMismatch(mismatches, preview.previewProgramDescriptorVersion, "descriptor");
    if (preview.previewProgramDescriptorIdentity !== requirement.previewProgramDescriptorIdentity) {
        mismatches.push({
            kind: "descriptor-identity-mismatch",
            requiredIdentity: requirement.previewProgramDescriptorIdentity,
            observedIdentity: preview.previewProgramDescriptorIdentity,
        });
    }
    const inputSupported = preview.supportedPreviewInputContracts.some(
        (input) =>
            input.id === requirement.inputContract.id &&
            input.profileId === requirement.inputContract.profileId &&
            input.profileVersion === requirement.inputContract.profileVersion,
    );
    if (!inputSupported) {
        mismatches.push({ kind: "input-contract-unsupported", required: requirement.inputContract });
    }
    addAxisMismatch(mismatches, preview.previewPublicationSchemaVersion, "publication");
    addAxisMismatch(mismatches, preview.previewActivePublicationSchemaVersion, "active-publication");
    addAxisMismatch(mismatches, preview.previewObservationSchemaVersion, "observation");
    return mismatches.length === 0
        ? { status: "eligible", candidate, facts: preview }
        : { status: "incompatible", candidate, mismatches };
}

/** Admits a Preview build only for the candidate whose dedicated handshake
 *  established the eligible proof. The candidate stays outside the request
 *  value (which carries Preview intent only), but it is part of admission. */
export function admitPreviewBuild(
    eligibility: PreviewEligibility,
    candidate: ToolCandidate,
): boolean {
    return eligibility.status === "eligible" && candidatesEqual(eligibility.candidate, candidate);
}
