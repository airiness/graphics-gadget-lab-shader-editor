import { describe, expect, it } from "vitest";
import {
    emptyPreviewBuildLine,
    issuePreviewAttempt,
    previewAttemptOutcomeOfBuildResult,
    previewBuildIntentOf,
    reportPreviewBuildLine,
    settlePreviewAttempt,
    type BoundaryOutput,
    type NativePreviewBuildRequest,
    type PreviewHandshakeSuccessDocument,
    type ToolCandidate,
    utf8Encode,
} from "../src/index.js";
import {
    BUILD_PREVIEW_SUCCESS,
    DESCRIBE_PREVIEW_SUCCESS,
    PREVIEW_DESCRIPTOR_IDENTITY,
    previewBuildFailureDocument,
} from "./fixtures/preview-envelope-goldens.js";
import { readPreviewHandshakeDocument } from "../src/preview-handshake-document.js";

const CANDIDATE: ToolCandidate = {
    rule: "bundled",
    toolPath: "C:/tools/gglab-shaderc.exe",
    observationIdentity: "candidate-a",
    resolvedAt: 1,
};

const REQUEST: NativePreviewBuildRequest = {
    sessionId: "12".repeat(16),
    targetProfile: "gglab-dx12",
    profileId: "gglab.surface",
    profileVersion: 2,
    previewInputContractId: "gglab.preview-input.surface.texture2d",
    previewProgramDescriptorIdentity: PREVIEW_DESCRIPTOR_IDENTITY,
    generatedSourceIdentity: "cd".repeat(32),
    generatedSourceBytes: utf8Encode("generated"),
    attemptSequence: 7,
};

function proof(): PreviewHandshakeSuccessDocument {
    const read = readPreviewHandshakeDocument(DESCRIBE_PREVIEW_SUCCESS);
    if (read.status !== "read" || !read.document.success) {
        throw new Error("test fixture must be a successful Preview handshake");
    }
    return read.document;
}

function output(stdout: string, change: Partial<BoundaryOutput> = {}): BoundaryOutput {
    return {
        stdout: utf8Encode(stdout),
        stderr: new Uint8Array(0),
        exitCode: 0,
        timedOut: false,
        canceled: false,
        ...change,
    };
}

describe("Preview attempt settlement", () => {
    it("binds a readable publication to the request's exact AttemptSequence", () => {
        expect(
            previewAttemptOutcomeOfBuildResult(
                { kind: "spawned", output: output(BUILD_PREVIEW_SUCCESS) },
                8,
            ),
        ).toEqual({
            kind: "failed",
            termination: { kind: "attempt-sequence-mismatch", expected: 8, observed: 7 },
        });
    });

    it("keeps cancel, timeout, and tool failure as distinct outcomes", () => {
        expect(
            previewAttemptOutcomeOfBuildResult(
                { kind: "spawned", output: output("", { canceled: true }) },
                7,
            ),
        ).toEqual({ kind: "canceled" });
        expect(
            previewAttemptOutcomeOfBuildResult(
                { kind: "spawned", output: output("", { timedOut: true }) },
                7,
            ),
        ).toEqual({ kind: "failed", termination: { kind: "timed-out" } });
        expect(
            previewAttemptOutcomeOfBuildResult(
                {
                    kind: "spawned",
                    output: output(previewBuildFailureDocument("compile-failed", 4), { exitCode: 4 }),
                },
                7,
            ),
        ).toMatchObject({ kind: "failed", envelope: { status: "compile-failed", attemptSequence: 7 } });
    });
});

describe("the Preview build line", () => {
    it("retains the newest successful publication across a newer failure without calling it Runtime Current", () => {
        const intent = previewBuildIntentOf(REQUEST, proof());
        let line = issuePreviewAttempt(emptyPreviewBuildLine(), {
            attemptSequence: 7,
            buildId: { sequence: 31 },
            candidate: CANDIDATE,
            intent,
        });
        line = settlePreviewAttempt(
            line,
            7,
            previewAttemptOutcomeOfBuildResult(
                { kind: "spawned", output: output(BUILD_PREVIEW_SUCCESS) },
                7,
            ),
        );
        line = issuePreviewAttempt(line, {
            attemptSequence: 8,
            buildId: { sequence: 32 },
            candidate: CANDIDATE,
            intent: { ...intent, generatedSourceIdentity: "ef".repeat(32) },
        });
        line = settlePreviewAttempt(
            line,
            8,
            previewAttemptOutcomeOfBuildResult(
                {
                    kind: "spawned",
                    output: output(previewBuildFailureDocument("compile-failed", 4, 8), { exitCode: 4 }),
                },
                8,
            ),
        );

        const report = reportPreviewBuildLine(line);
        expect(report.latest?.attemptSequence).toBe(8);
        expect(report.states.map((state) => state.state)).toEqual(["failed", "published"]);
        expect(report.latestPublished?.attemptSequence).toBe(7);
        expect("current" in report).toBe(false);
        expect("lastGood" in report).toBe(false);
    });

    it("rejects duplicate AttemptSequence and BuildId identities", () => {
        const intent = previewBuildIntentOf(REQUEST, proof());
        const line = issuePreviewAttempt(emptyPreviewBuildLine(), {
            attemptSequence: 7,
            buildId: { sequence: 31 },
            candidate: CANDIDATE,
            intent,
        });
        expect(() =>
            issuePreviewAttempt(line, {
                attemptSequence: 7,
                buildId: { sequence: 32 },
                candidate: CANDIDATE,
                intent,
            }),
        ).toThrow(/already names an attempt/u);
        expect(() =>
            issuePreviewAttempt(line, {
                attemptSequence: 8,
                buildId: { sequence: 31 },
                candidate: CANDIDATE,
                intent,
            }),
        ).toThrow(/already names a Preview attempt/u);
    });
});
