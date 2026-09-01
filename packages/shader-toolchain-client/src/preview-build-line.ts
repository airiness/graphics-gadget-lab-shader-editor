/**
 * Pure Preview build-line rules. The editor owns the session storage and
 * launch order; this module owns the host-independent meanings of one
 * Preview settlement and the ordered attempt projection.
 *
 * Publication is deliberately not called Current or LastGood here. A
 * successful build proves that the immutable publication was produced and
 * selected by the session pointer. Only the later Runtime observation can
 * prove that a publication loaded and can therefore be Current/LastGood.
 */
import type { PreviewHandshakeSuccessDocument } from "./preview-handshake-document.js";
import type { BoundaryResult, CandidateObservation, ToolCandidate } from "./host-boundary.js";
import type { BuildId } from "./native-compile-request.js";
import type { NativePreviewBuildRequest } from "./native-preview-build-request.js";
import { readPreviewBuildOutput, type ChannelViolation } from "./process-output.js";
import type {
    PreviewBuildFailureStatus,
    PreviewBuildRejection,
    PreviewBuildSuccessDocument,
    PreviewBuildUsageFailureDocument,
    PreviewBuildExecutionFailureDocument,
} from "./preview-result-envelope.js";

/** The semantic identity of one Preview build, excluding the session-local
 *  SessionId/AttemptSequence and the source bytes represented by their
 *  generated-source digest. */
export interface PreviewBuildIntent {
    readonly targetProfile: string;
    readonly profileId: string;
    readonly profileVersion: number;
    readonly previewInputContractId: string;
    readonly previewProgramDescriptorIdentity: string;
    readonly generatedSourceIdentity: string;
    readonly toolIdentity: string;
    readonly toolVersion: string;
    readonly processContractVersion: number;
    readonly previewBuildContractVersion: number;
    readonly compilePolicyRevision: number;
    readonly producerKind: string;
    readonly producerIdentity: string;
}

export function previewBuildIntentOf(
    request: NativePreviewBuildRequest,
    proof: PreviewHandshakeSuccessDocument,
): PreviewBuildIntent {
    return {
        targetProfile: request.targetProfile,
        profileId: request.profileId,
        profileVersion: request.profileVersion,
        previewInputContractId: request.previewInputContractId,
        previewProgramDescriptorIdentity: request.previewProgramDescriptorIdentity,
        generatedSourceIdentity: request.generatedSourceIdentity,
        toolIdentity: proof.toolIdentity,
        toolVersion: proof.toolVersion,
        processContractVersion: proof.processContractVersion,
        previewBuildContractVersion: proof.previewBuildContractVersion,
        compilePolicyRevision: proof.compilePolicyRevision,
        producerKind: proof.producerKind,
        producerIdentity: proof.producerIdentity,
    };
}

export function previewBuildIntentsEqual(left: PreviewBuildIntent, right: PreviewBuildIntent): boolean {
    for (const field of Object.keys(left) as ReadonlyArray<keyof PreviewBuildIntent>) {
        if (left[field] !== right[field]) {
            return false;
        }
    }
    return true;
}

export type PreviewAttemptTermination =
    | { readonly kind: "timed-out" }
    | { readonly kind: "channel-violated"; readonly violation: ChannelViolation }
    | { readonly kind: "machine-document-rejected"; readonly rejection: PreviewBuildRejection }
    | {
          readonly kind: "candidate-invalidated";
          readonly observation: CandidateObservation;
          readonly observedIdentity: string | null;
      }
    | { readonly kind: "launch-failed" }
    | {
          readonly kind: "attempt-sequence-mismatch";
          readonly expected: number;
          readonly observed: number;
      };

export type PreviewBuildFailureDocument =
    | PreviewBuildUsageFailureDocument
    | PreviewBuildExecutionFailureDocument;

export type PreviewAttemptOutcome =
    | { readonly kind: "published"; readonly envelope: PreviewBuildSuccessDocument }
    | { readonly kind: "failed"; readonly envelope: PreviewBuildFailureDocument }
    | { readonly kind: "failed"; readonly termination: PreviewAttemptTermination }
    | { readonly kind: "canceled" };

/** The one mapping from the boundary settlement into the Preview attempt
 *  vocabulary. A readable document with another attempt sequence is not
 *  allowed to publish or fail this attempt: it is an explicit protocol
 *  binding failure. */
export function previewAttemptOutcomeOfBuildResult(
    result: BoundaryResult,
    expectedAttemptSequence: number,
): PreviewAttemptOutcome {
    if (result.kind === "candidate-invalidated") {
        return {
            kind: "failed",
            termination: {
                kind: "candidate-invalidated",
                observation: result.observation,
                observedIdentity: result.observedIdentity,
            },
        };
    }
    if (result.kind === "launch-failed") {
        return { kind: "failed", termination: { kind: "launch-failed" } };
    }
    const process = readPreviewBuildOutput(result.output);
    if (process.kind === "canceled") {
        return { kind: "canceled" };
    }
    if (process.kind === "timed-out") {
        return { kind: "failed", termination: { kind: "timed-out" } };
    }
    if (process.kind === "channel-violated") {
        return { kind: "failed", termination: { kind: "channel-violated", violation: process.violation } };
    }
    if (process.kind === "rejected") {
        return {
            kind: "failed",
            termination: { kind: "machine-document-rejected", rejection: process.rejection },
        };
    }
    const document = process.document;
    if (document.attemptSequence !== undefined && document.attemptSequence !== expectedAttemptSequence) {
        return {
            kind: "failed",
            termination: {
                kind: "attempt-sequence-mismatch",
                expected: expectedAttemptSequence,
                observed: document.attemptSequence,
            },
        };
    }
    return document.success
        ? { kind: "published", envelope: document }
        : { kind: "failed", envelope: document };
}

interface PreviewAttemptBase {
    readonly attemptSequence: number;
    readonly buildId: BuildId;
    readonly candidate: ToolCandidate;
    readonly intent: PreviewBuildIntent;
}

export interface PendingPreviewAttempt extends PreviewAttemptBase {
    readonly state: "pending";
}

export interface SettledPreviewAttempt extends PreviewAttemptBase {
    readonly state: "settled";
    readonly outcome: PreviewAttemptOutcome;
}

export type PreviewAttemptRecord = PendingPreviewAttempt | SettledPreviewAttempt;

export interface PreviewBuildLine {
    readonly attempts: readonly PreviewAttemptRecord[];
}

export function emptyPreviewBuildLine(): PreviewBuildLine {
    return { attempts: [] };
}

export function issuePreviewAttempt(
    line: PreviewBuildLine,
    attempt: Omit<PendingPreviewAttempt, "state">,
): PreviewBuildLine {
    if (line.attempts.some((entry) => entry.attemptSequence === attempt.attemptSequence)) {
        throw new Error(`Preview attempt sequence ${attempt.attemptSequence} already names an attempt`);
    }
    if (line.attempts.some((entry) => entry.buildId.sequence === attempt.buildId.sequence)) {
        throw new Error(`build id ${attempt.buildId.sequence} already names a Preview attempt`);
    }
    return { attempts: [...line.attempts, { ...attempt, state: "pending" }] };
}

export function settlePreviewAttempt(
    line: PreviewBuildLine,
    attemptSequence: number,
    outcome: PreviewAttemptOutcome,
): PreviewBuildLine {
    let found = false;
    const attempts = line.attempts.map((attempt): PreviewAttemptRecord => {
        if (attempt.attemptSequence !== attemptSequence) {
            return attempt;
        }
        if (attempt.state !== "pending") {
            throw new Error(`Preview attempt sequence ${attemptSequence} already settled`);
        }
        found = true;
        return { ...attempt, state: "settled", outcome };
    });
    if (!found) {
        throw new Error(`Preview attempt sequence ${attemptSequence} was never issued`);
    }
    return { attempts };
}

export type PreviewAttemptState = "pending" | "published" | "failed" | "canceled";

export interface PreviewBuildLineReport {
    readonly latest?: PreviewAttemptRecord | undefined;
    /** The newest successful publication. Runtime observation is still
     *  required before this can be called Current or LastGood. */
    readonly latestPublished?: SettledPreviewAttempt | undefined;
    readonly states: ReadonlyArray<{
        readonly attemptSequence: number;
        readonly buildId: BuildId;
        readonly state: PreviewAttemptState;
        readonly intent: PreviewBuildIntent;
    }>;
}

function attemptState(attempt: PreviewAttemptRecord): PreviewAttemptState {
    if (attempt.state === "pending") {
        return "pending";
    }
    return attempt.outcome.kind;
}

export function reportPreviewBuildLine(line: PreviewBuildLine): PreviewBuildLineReport {
    const ordered = [...line.attempts].sort((left, right) => right.attemptSequence - left.attemptSequence);
    const latestPublished = ordered.find(
        (attempt): attempt is SettledPreviewAttempt =>
            attempt.state === "settled" && attempt.outcome.kind === "published",
    );
    return {
        latest: ordered[0],
        latestPublished,
        states: ordered.map((attempt) => ({
            attemptSequence: attempt.attemptSequence,
            buildId: attempt.buildId,
            state: attemptState(attempt),
            intent: attempt.intent,
        })),
    };
}

/** A narrow helper for diagnostics/UI code that needs the tool-reported
 *  failure status without inspecting the union itself. */
export function previewFailureStatusOf(outcome: PreviewAttemptOutcome): PreviewBuildFailureStatus | null {
    return outcome.kind === "failed" && "envelope" in outcome ? outcome.envelope.status : null;
}
