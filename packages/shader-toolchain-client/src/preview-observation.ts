/**
 * Strict reader and pure state rules for the main-owned 90-byte Runtime
 * Preview observation record (file format v1, observation schema v1).
 */
import {
    previewBuildIntentsEqual,
    reportPreviewBuildLine,
    type PreviewAttemptRecord,
    type PreviewAttemptState,
    type PreviewBuildIntent,
    type PreviewBuildLine,
    type SettledPreviewAttempt,
} from "./preview-build-line.js";

export const serializedPreviewObservationSize = 90;
export const previewObservationFileFormatVersion = 1;
export const previewObservationSchemaVersion = 1;
export const zeroPreviewPublicationRef = "00".repeat(32);

const MAGIC = new Uint8Array([0x47, 0x47, 0x53, 0x48, 0x4f, 0x42, 0x53, 0x56]);
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type PreviewObservationRejectionCode =
    | "publication-unavailable"
    | "publication-invalid"
    | "shader-artifact-unavailable"
    | "shader-artifact-invalid"
    | "registry-unavailable"
    | "registry-invalid"
    | "activation-failed"
    | "io-failure";

export type PreviewObservation =
    | {
          readonly status: "loaded";
          readonly observedAttemptSequence: number;
          readonly observedPublicationRef: string;
          readonly loadedPublicationRef: string;
          readonly rejectionCode: "none";
      }
    | {
          readonly status: "rejected";
          readonly observedAttemptSequence: number;
          readonly observedPublicationRef: string;
          readonly loadedPublicationRef: string;
          readonly rejectionCode: PreviewObservationRejectionCode;
      };

export type PreviewObservationReadReason =
    | "wrong-length"
    | "wrong-magic"
    | "unsupported-file-version"
    | "unsupported-schema-version"
    | "attempt-sequence-outside-client-range"
    | "invalid-observed-publication-ref"
    | "unknown-status"
    | "unknown-rejection-code"
    | "contradictory-record";

export interface PreviewObservationReadRejection {
    readonly reason: PreviewObservationReadReason;
    readonly detail: string;
}

export type PreviewObservationReadOutcome =
    | { readonly status: "read"; readonly observation: PreviewObservation }
    | { readonly status: "rejected"; readonly rejection: PreviewObservationReadRejection };

function rejected(reason: PreviewObservationReadReason, detail: string): PreviewObservationReadOutcome {
    return { status: "rejected", rejection: { reason, detail } };
}

function readU32LE(bytes: Uint8Array, offset: number): number {
    return (
        bytes[offset]! |
        (bytes[offset + 1]! << 8) |
        (bytes[offset + 2]! << 16) |
        (bytes[offset + 3]! << 24)
    ) >>> 0;
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
    let value = 0n;
    for (let index = 7; index >= 0; index -= 1) {
        value = (value << 8n) | BigInt(bytes[offset + index]!);
    }
    return value;
}

function digestHex(bytes: Uint8Array, offset: number): string {
    let result = "";
    for (let index = 0; index < 32; index += 1) {
        result += bytes[offset + index]!.toString(16).padStart(2, "0");
    }
    return result;
}

function rejectionCodeOf(value: number): "none" | PreviewObservationRejectionCode | null {
    switch (value) {
        case 0:
            return "none";
        case 1:
            return "publication-unavailable";
        case 2:
            return "publication-invalid";
        case 3:
            return "shader-artifact-unavailable";
        case 4:
            return "shader-artifact-invalid";
        case 5:
            return "registry-unavailable";
        case 6:
            return "registry-invalid";
        case 7:
            return "activation-failed";
        case 8:
            return "io-failure";
        default:
            return null;
    }
}

export function readPreviewObservation(bytes: Uint8Array): PreviewObservationReadOutcome {
    if (bytes.byteLength !== serializedPreviewObservationSize) {
        return rejected(
            "wrong-length",
            `a Preview observation is exactly ${serializedPreviewObservationSize} bytes; observed ${bytes.byteLength}`,
        );
    }
    if (!MAGIC.every((byte, index) => bytes[index] === byte)) {
        return rejected("wrong-magic", "the record does not carry the GGSHOBSV magic");
    }
    const fileVersion = readU32LE(bytes, 8);
    if (fileVersion !== previewObservationFileFormatVersion) {
        return rejected(
            "unsupported-file-version",
            `the record carries file format ${fileVersion}; this client supports ${previewObservationFileFormatVersion}`,
        );
    }
    const schemaVersion = readU32LE(bytes, 12);
    if (schemaVersion !== previewObservationSchemaVersion) {
        return rejected(
            "unsupported-schema-version",
            `the record carries observation schema ${schemaVersion}; this client supports ${previewObservationSchemaVersion}`,
        );
    }
    const attempt = readU64LE(bytes, 16);
    if (attempt > MAX_SAFE_INTEGER_BIGINT) {
        return rejected(
            "attempt-sequence-outside-client-range",
            "the observation attempt sequence is outside TypeScript's exact safe-integer range",
        );
    }
    const observedPublicationRef = digestHex(bytes, 24);
    if (observedPublicationRef === zeroPreviewPublicationRef) {
        return rejected(
            "invalid-observed-publication-ref",
            "the observed publication reference must be a non-zero SHA-256 digest",
        );
    }
    const loadedPublicationRef = digestHex(bytes, 56);
    const status = bytes[88];
    const rejectionCode = rejectionCodeOf(bytes[89]!);
    if (status !== 1 && status !== 2) {
        return rejected("unknown-status", `the record carries unknown status value ${status}`);
    }
    if (rejectionCode === null) {
        return rejected(
            "unknown-rejection-code",
            `the record carries unknown rejection-code value ${bytes[89]}`,
        );
    }
    const observedAttemptSequence = Number(attempt);
    if (status === 1) {
        if (rejectionCode !== "none" || loadedPublicationRef !== observedPublicationRef) {
            return rejected(
                "contradictory-record",
                "Loaded requires rejectionCode=None and loaded publication equal to observed publication",
            );
        }
        return {
            status: "read",
            observation: {
                status: "loaded",
                observedAttemptSequence,
                observedPublicationRef,
                loadedPublicationRef,
                rejectionCode: "none",
            },
        };
    }
    if (rejectionCode === "none" || loadedPublicationRef === observedPublicationRef) {
        return rejected(
            "contradictory-record",
            "Rejected requires a non-None rejection code and must preserve a publication other than the rejected one",
        );
    }
    return {
        status: "read",
        observation: {
            status: "rejected",
            observedAttemptSequence,
            observedPublicationRef,
            loadedPublicationRef,
            rejectionCode,
        },
    };
}

function observationsEqual(left: PreviewObservation, right: PreviewObservation): boolean {
    return (
        left.status === right.status &&
        left.observedAttemptSequence === right.observedAttemptSequence &&
        left.observedPublicationRef === right.observedPublicationRef &&
        left.loadedPublicationRef === right.loadedPublicationRef &&
        left.rejectionCode === right.rejectionCode
    );
}

export type PreviewObservationOrderingRejection =
    | { readonly reason: "older-attempt" }
    | { readonly reason: "same-attempt-changed" }
    | { readonly reason: "last-good-changed-on-rejection" };

export type PreviewObservationUpdate =
    | { readonly accepted: true; readonly changed: boolean; readonly observation: PreviewObservation }
    | { readonly accepted: false; readonly rejection: PreviewObservationOrderingRejection };

/** Mirrors the Runtime writer's monotonic/transactional rule while treating a
 *  repeated read of the same atomic record as unchanged, not an error. */
export function acceptPreviewObservation(
    current: PreviewObservation | null,
    candidate: PreviewObservation,
): PreviewObservationUpdate {
    if (current === null) {
        return { accepted: true, changed: true, observation: candidate };
    }
    if (candidate.observedAttemptSequence < current.observedAttemptSequence) {
        return { accepted: false, rejection: { reason: "older-attempt" } };
    }
    if (candidate.observedAttemptSequence === current.observedAttemptSequence) {
        return observationsEqual(current, candidate)
            ? { accepted: true, changed: false, observation: current }
            : { accepted: false, rejection: { reason: "same-attempt-changed" } };
    }
    if (
        candidate.status === "rejected" &&
        candidate.loadedPublicationRef !== current.loadedPublicationRef
    ) {
        return { accepted: false, rejection: { reason: "last-good-changed-on-rejection" } };
    }
    return { accepted: true, changed: true, observation: candidate };
}

export type PreviewObservationBinding =
    | "none"
    | "bound"
    | "attempt-not-published"
    | "observed-publication-mismatch"
    | "loaded-publication-not-published"
    | "loaded-publication-not-prior";

export interface PreviewRuntimeProjection {
    readonly freshness: "idle" | "pending" | "current" | "stale" | "rejected";
    readonly latestBuildState: PreviewAttemptState | null;
    readonly currentPublicationId: string | null;
    readonly lastGoodPublicationId: string | null;
    readonly rejectionCode: PreviewObservationRejectionCode | null;
    readonly observationBinding: PreviewObservationBinding;
}

function publishedAttempt(
    line: PreviewBuildLine,
    attemptSequence: number,
): SettledPreviewAttempt | undefined {
    return line.attempts.find(
        (attempt): attempt is SettledPreviewAttempt =>
            attempt.attemptSequence === attemptSequence &&
            attempt.state === "settled" &&
            attempt.outcome.kind === "published",
    );
}

function attemptState(attempt: PreviewAttemptRecord): PreviewAttemptState {
    return attempt.state === "pending" ? "pending" : attempt.outcome.kind;
}

function bindingOf(
    line: PreviewBuildLine,
    observation: PreviewObservation | null,
): { readonly binding: PreviewObservationBinding; readonly lastGoodPublicationId: string | null } {
    if (observation === null) {
        return { binding: "none", lastGoodPublicationId: null };
    }
    const observedAttempt = publishedAttempt(line, observation.observedAttemptSequence);
    if (observedAttempt === undefined) {
        return { binding: "attempt-not-published", lastGoodPublicationId: null };
    }
    if (observedAttempt.outcome.kind !== "published") {
        return { binding: "attempt-not-published", lastGoodPublicationId: null };
    }
    if (observedAttempt.outcome.envelope.publicationId !== observation.observedPublicationRef) {
        return { binding: "observed-publication-mismatch", lastGoodPublicationId: null };
    }
    if (observation.status === "loaded") {
        return { binding: "bound", lastGoodPublicationId: observation.loadedPublicationRef };
    }
    if (observation.loadedPublicationRef === zeroPreviewPublicationRef) {
        return { binding: "bound", lastGoodPublicationId: null };
    }
    const loadedAttempt = line.attempts.find(
        (attempt) =>
            attempt.state === "settled" &&
            attempt.outcome.kind === "published" &&
            attempt.outcome.envelope.publicationId === observation.loadedPublicationRef,
    );
    if (loadedAttempt === undefined) {
        return { binding: "loaded-publication-not-published", lastGoodPublicationId: null };
    }
    if (loadedAttempt.attemptSequence >= observation.observedAttemptSequence) {
        return { binding: "loaded-publication-not-prior", lastGoodPublicationId: null };
    }
    return { binding: "bound", lastGoodPublicationId: observation.loadedPublicationRef };
}

/** Combines build publication evidence with an accepted Runtime observation.
 *  `currentIntent` is the composition's present intent; null is an explicit
 *  non-previewable/currently-unproven graph and can never yield Current. */
export function projectPreviewRuntime(
    line: PreviewBuildLine,
    currentIntent: PreviewBuildIntent | null,
    observation: PreviewObservation | null,
): PreviewRuntimeProjection {
    const build = reportPreviewBuildLine(line);
    const latest = build.latest;
    if (latest === undefined) {
        return {
            freshness: "idle",
            latestBuildState: null,
            currentPublicationId: null,
            lastGoodPublicationId: null,
            rejectionCode: null,
            observationBinding: observation === null ? "none" : "attempt-not-published",
        };
    }
    const latestBuildState = attemptState(latest);
    const binding = bindingOf(line, observation);
    const intentCurrent = currentIntent !== null && previewBuildIntentsEqual(latest.intent, currentIntent);
    if (latestBuildState === "pending") {
        return {
            freshness: "pending",
            latestBuildState,
            currentPublicationId: null,
            lastGoodPublicationId: binding.lastGoodPublicationId,
            rejectionCode: null,
            observationBinding: binding.binding,
        };
    }
    if (latestBuildState === "failed" || latestBuildState === "canceled") {
        return {
            freshness: "stale",
            latestBuildState,
            currentPublicationId: null,
            lastGoodPublicationId: binding.lastGoodPublicationId,
            rejectionCode: null,
            observationBinding: binding.binding,
        };
    }
    if (latest.state !== "settled" || latest.outcome.kind !== "published") {
        throw new Error("a published Preview state must carry its publication envelope");
    }
    const publicationId = latest.outcome.envelope.publicationId;
    const observesLatest =
        binding.binding === "bound" &&
        observation !== null &&
        observation.observedAttemptSequence === latest.attemptSequence &&
        observation.observedPublicationRef === publicationId;
    if (!observesLatest) {
        return {
            freshness: intentCurrent ? "pending" : "stale",
            latestBuildState,
            currentPublicationId: null,
            lastGoodPublicationId: binding.lastGoodPublicationId,
            rejectionCode: null,
            observationBinding: binding.binding,
        };
    }
    if (observation.status === "rejected") {
        return {
            freshness: "rejected",
            latestBuildState,
            currentPublicationId: null,
            lastGoodPublicationId: binding.lastGoodPublicationId,
            rejectionCode: observation.rejectionCode,
            observationBinding: "bound",
        };
    }
    return intentCurrent
        ? {
              freshness: "current",
              latestBuildState,
              currentPublicationId: publicationId,
              lastGoodPublicationId: publicationId,
              rejectionCode: null,
              observationBinding: "bound",
          }
        : {
              freshness: "stale",
              latestBuildState,
              currentPublicationId: null,
              lastGoodPublicationId: publicationId,
              rejectionCode: null,
              observationBinding: "bound",
          };
}
