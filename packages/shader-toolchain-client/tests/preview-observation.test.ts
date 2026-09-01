import { describe, expect, it } from "vitest";
import {
    acceptPreviewObservation,
    emptyPreviewBuildLine,
    issuePreviewAttempt,
    projectPreviewRuntime,
    readPreviewObservation,
    settlePreviewAttempt,
    type PreviewBuildIntent,
    type PreviewBuildLine,
    type PreviewObservation,
    type PreviewObservationRejectionCode,
    type ToolCandidate,
} from "../src/index.js";

const P1 = "11".repeat(32);
const P2 = "22".repeat(32);
const ZERO = "00".repeat(32);

const CANDIDATE: ToolCandidate = {
    rule: "bundled",
    toolPath: "C:/tools/gglab-shaderc.exe",
    observationIdentity: "candidate-a",
    resolvedAt: 1,
};

const INTENT: PreviewBuildIntent = {
    targetProfile: "gglab-dx12",
    profileId: "gglab.surface",
    profileVersion: 1,
    previewInputContractId: "gglab.preview-input.surface.numeric",
    previewProgramDescriptorIdentity: "aa".repeat(32),
    generatedSourceIdentity: "bb".repeat(32),
    toolIdentity: "gglab-shaderc",
    toolVersion: "1.3.0",
    processContractVersion: 2,
    previewBuildContractVersion: 1,
    compilePolicyRevision: 1,
    producerKind: "dxc",
    producerIdentity: "dxc-test",
};

const REJECTION_VALUES: Readonly<Record<PreviewObservationRejectionCode, number>> = {
    "publication-unavailable": 1,
    "publication-invalid": 2,
    "shader-artifact-unavailable": 3,
    "shader-artifact-invalid": 4,
    "registry-unavailable": 5,
    "registry-invalid": 6,
    "activation-failed": 7,
    "io-failure": 8,
};

function digestBytes(digest: string): number[] {
    return Array.from({ length: 32 }, (_unused, index) => Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16));
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function writeU64LE(bytes: Uint8Array, offset: number, value: bigint): void {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(offset, value, true);
}

function observationBytes(
    attempt: bigint,
    observed: string,
    loaded: string,
    status: "loaded" | "rejected",
    rejection: "none" | PreviewObservationRejectionCode,
): Uint8Array {
    const bytes = new Uint8Array(90);
    bytes.set([0x47, 0x47, 0x53, 0x48, 0x4f, 0x42, 0x53, 0x56], 0);
    writeU32LE(bytes, 8, 1);
    writeU32LE(bytes, 12, 1);
    writeU64LE(bytes, 16, attempt);
    bytes.set(digestBytes(observed), 24);
    bytes.set(digestBytes(loaded), 56);
    bytes[88] = status === "loaded" ? 1 : 2;
    bytes[89] = rejection === "none" ? 0 : REJECTION_VALUES[rejection];
    return bytes;
}

function loaded(attempt: number, publication: string): PreviewObservation {
    return {
        status: "loaded",
        observedAttemptSequence: attempt,
        observedPublicationRef: publication,
        loadedPublicationRef: publication,
        rejectionCode: "none",
    };
}

function rejected(attempt: number, observed: string, lastGood: string): PreviewObservation {
    return {
        status: "rejected",
        observedAttemptSequence: attempt,
        observedPublicationRef: observed,
        loadedPublicationRef: lastGood,
        rejectionCode: "activation-failed",
    };
}

function issue(line: PreviewBuildLine, sequence: number, intent: PreviewBuildIntent = INTENT): PreviewBuildLine {
    return issuePreviewAttempt(line, {
        attemptSequence: sequence,
        buildId: { sequence: sequence + 20 },
        candidate: CANDIDATE,
        intent,
    });
}

function publish(line: PreviewBuildLine, sequence: number, publicationId: string): PreviewBuildLine {
    return settlePreviewAttempt(line, sequence, {
        kind: "published",
        envelope: {
            command: "build-preview",
            success: true,
            status: "ok",
            exitCode: 0,
            attemptSequence: sequence,
            publicationId,
            shaderArtifactId: "33".repeat(32),
            baseRegistryId: "44".repeat(32),
            previewRegistryId: "55".repeat(32),
            diagnostics: [],
        },
    });
}

describe("the Preview Runtime observation reader", () => {
    it("reads the exact main-owned Loaded and Rejected record shapes", () => {
        expect(readPreviewObservation(observationBytes(7n, P1, P1, "loaded", "none"))).toEqual({
            status: "read",
            observation: loaded(7, P1),
        });
        expect(
            readPreviewObservation(observationBytes(8n, P2, P1, "rejected", "activation-failed")),
        ).toEqual({
            status: "read",
            observation: rejected(8, P2, P1),
        });
        expect(
            readPreviewObservation(observationBytes(1n, P1, ZERO, "rejected", "publication-unavailable")),
        ).toMatchObject({
            status: "read",
            observation: { status: "rejected", loadedPublicationRef: ZERO },
        });
    });

    it.each([
        ["wrong-length", (bytes: Uint8Array) => bytes.slice(0, 89)],
        ["wrong-magic", (bytes: Uint8Array) => { bytes[0] = 0; return bytes; }],
        ["unsupported-file-version", (bytes: Uint8Array) => { writeU32LE(bytes, 8, 2); return bytes; }],
        ["unsupported-schema-version", (bytes: Uint8Array) => { writeU32LE(bytes, 12, 2); return bytes; }],
        ["unknown-status", (bytes: Uint8Array) => { bytes[88] = 3; return bytes; }],
        ["unknown-rejection-code", (bytes: Uint8Array) => { bytes[89] = 9; return bytes; }],
        ["contradictory-record", (bytes: Uint8Array) => { bytes[89] = 7; return bytes; }],
    ])("rejects %s", (reason, mutate) => {
        expect(readPreviewObservation(mutate(observationBytes(7n, P1, P1, "loaded", "none")))).toMatchObject({
            status: "rejected",
            rejection: { reason },
        });
    });

    it("rejects an attempt sequence that JavaScript cannot represent exactly", () => {
        expect(
            readPreviewObservation(
                observationBytes(BigInt(Number.MAX_SAFE_INTEGER) + 1n, P1, P1, "loaded", "none"),
            ),
        ).toMatchObject({
            status: "rejected",
            rejection: { reason: "attempt-sequence-outside-client-range" },
        });
    });
});

describe("Preview observation ordering", () => {
    it("accepts identical polling and a newer rejection that preserves last-good", () => {
        const first = loaded(7, P1);
        expect(acceptPreviewObservation(null, first)).toEqual({ accepted: true, changed: true, observation: first });
        expect(acceptPreviewObservation(first, { ...first })).toEqual({
            accepted: true,
            changed: false,
            observation: first,
        });
        expect(acceptPreviewObservation(first, rejected(8, P2, P1))).toMatchObject({ accepted: true, changed: true });
    });

    it("rejects rollback, same-sequence mutation, and last-good mutation on rejection", () => {
        const current = loaded(7, P1);
        expect(acceptPreviewObservation(current, loaded(6, P1))).toMatchObject({
            accepted: false,
            rejection: { reason: "older-attempt" },
        });
        expect(acceptPreviewObservation(current, rejected(7, P2, P1))).toMatchObject({
            accepted: false,
            rejection: { reason: "same-attempt-changed" },
        });
        expect(acceptPreviewObservation(current, rejected(8, P2, ZERO))).toMatchObject({
            accepted: false,
            rejection: { reason: "last-good-changed-on-rejection" },
        });
    });
});

describe("Preview Runtime projection", () => {
    it("requires latest publication + current intent + exact Loaded observation for Current", () => {
        let line = issue(emptyPreviewBuildLine(), 1);
        line = publish(line, 1, P1);
        expect(projectPreviewRuntime(line, INTENT, null)).toMatchObject({
            freshness: "pending",
            currentPublicationId: null,
        });
        expect(projectPreviewRuntime(line, INTENT, loaded(1, P1))).toEqual({
            freshness: "current",
            latestBuildState: "published",
            currentPublicationId: P1,
            lastGoodPublicationId: P1,
            rejectionCode: null,
            observationBinding: "bound",
        });
        expect(
            projectPreviewRuntime(line, { ...INTENT, generatedSourceIdentity: "cc".repeat(32) }, loaded(1, P1)),
        ).toMatchObject({ freshness: "stale", currentPublicationId: null, lastGoodPublicationId: P1 });
    });

    it("makes an older loaded publication LastGood/Stale after a newer failed or canceled attempt", () => {
        let line = publish(issue(emptyPreviewBuildLine(), 1), 1, P1);
        line = issue(line, 2, { ...INTENT, generatedSourceIdentity: "cc".repeat(32) });
        line = settlePreviewAttempt(line, 2, {
            kind: "failed",
            termination: { kind: "timed-out" },
        });
        expect(projectPreviewRuntime(line, line.attempts[1]!.intent, loaded(1, P1))).toMatchObject({
            freshness: "stale",
            latestBuildState: "failed",
            lastGoodPublicationId: P1,
        });
    });

    it("reports an exact rejection while preserving the previously loaded publication", () => {
        let line = publish(issue(emptyPreviewBuildLine(), 1), 1, P1);
        const secondIntent = { ...INTENT, generatedSourceIdentity: "cc".repeat(32) };
        line = publish(issue(line, 2, secondIntent), 2, P2);
        expect(projectPreviewRuntime(line, secondIntent, rejected(2, P2, P1))).toEqual({
            freshness: "rejected",
            latestBuildState: "published",
            currentPublicationId: null,
            lastGoodPublicationId: P1,
            rejectionCode: "activation-failed",
            observationBinding: "bound",
        });
    });

    it("never trusts an observation whose attempt/publication cross-link is absent from the build line", () => {
        const line = publish(issue(emptyPreviewBuildLine(), 1), 1, P1);
        expect(projectPreviewRuntime(line, INTENT, loaded(1, P2))).toMatchObject({
            freshness: "pending",
            currentPublicationId: null,
            lastGoodPublicationId: null,
            observationBinding: "observed-publication-mismatch",
        });
        expect(projectPreviewRuntime(line, INTENT, loaded(9, P1))).toMatchObject({
            freshness: "pending",
            observationBinding: "attempt-not-published",
        });

        const secondIntent = { ...INTENT, generatedSourceIdentity: "cc".repeat(32) };
        const futureLine = publish(issue(line, 2, secondIntent), 2, P2);
        expect(projectPreviewRuntime(futureLine, INTENT, rejected(1, P1, P2))).toMatchObject({
            currentPublicationId: null,
            lastGoodPublicationId: null,
            observationBinding: "loaded-publication-not-prior",
        });
    });
});
