import { describe, expect, it } from "vitest";
import type { PreviewAttemptOutcome } from "@gglab/shader-toolchain-client";
import { describePreviewAttemptOutcome } from "../src/preview-attempt-summary.js";

describe("Preview attempt summaries", () => {
    it("shows the tool failure status, exit code, and every diagnostic", () => {
        const outcome: PreviewAttemptOutcome = {
            kind: "failed",
            envelope: {
                command: "build-preview",
                success: false,
                status: "compile-failed",
                exitCode: 1,
                attemptSequence: 4,
                diagnostics: [
                    { message: "DXC rejected the generated program." },
                    { message: "unknown identifier", sourceIdentity: "ab".repeat(32) },
                ],
            },
        };

        expect(describePreviewAttemptOutcome(4, outcome)).toBe(
            `Preview attempt #4 failed — compile-failed (exit 1): DXC rejected the generated program. | [source ${"ab".repeat(32)}] unknown identifier`,
        );
    });

    it("shows a rejected machine-document reason and detail", () => {
        const outcome: PreviewAttemptOutcome = {
            kind: "failed",
            termination: {
                kind: "machine-document-rejected",
                rejection: {
                    reason: "missing-field",
                    detail: 'the document is missing the required field "status"',
                },
            },
        };

        expect(describePreviewAttemptOutcome(2, outcome)).toBe(
            'Preview attempt #2 failed — machine-document-rejected (missing-field: the document is missing the required field "status").',
        );
    });

    it("shows channel failures and cancellation without collapsing them to failed", () => {
        const channelFailure: PreviewAttemptOutcome = {
            kind: "failed",
            termination: {
                kind: "channel-violated",
                violation: {
                    reason: "exit-code-mismatch",
                    documentExitCode: 1,
                    processExitCode: 2,
                },
            },
        };

        expect(describePreviewAttemptOutcome(3, channelFailure)).toBe(
            "Preview attempt #3 failed — channel-violated (exit-code-mismatch, document 1, process 2).",
        );
        expect(describePreviewAttemptOutcome(5, { kind: "canceled" })).toBe(
            "Preview attempt #5 was canceled.",
        );
    });
});
