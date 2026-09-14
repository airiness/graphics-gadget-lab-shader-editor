import { describe, expect, it } from "vitest";
import type { PreviewAttemptOutcome } from "@gglab/shader-toolchain-client";
import { describePreviewAttemptOutcome } from "../src/preview-attempt-summary.js";

describe("Preview attempt summaries", () => {
    it("shows the tool failure status and exit code — and does NOT flatten the diagnostics into the headline", () => {
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

        // THE NO-FLATTENING PIN: the headline carries the status and
        // exit code only. The structured diagnostics render as their own
        // rows in the display surface (each a fact with its location
        // identity), never joined into this string.
        expect(describePreviewAttemptOutcome(4, outcome)).toBe("Preview attempt #4 failed — compile-failed (exit 1).");
        expect(describePreviewAttemptOutcome(4, outcome)).not.toContain("DXC");
        expect(describePreviewAttemptOutcome(4, outcome)).not.toContain("unknown identifier");
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
