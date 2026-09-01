import { describe, expect, it } from "vitest";
import type { BoundaryOutput } from "../src/host-boundary.js";
import {
    readPreviewBuildOutput,
    readPreviewHandshakeOutput,
} from "../src/process-output.js";
import { utf8Encode } from "../src/utf8.js";
import {
    BUILD_PREVIEW_SUCCESS,
    DESCRIBE_PREVIEW_SUCCESS,
} from "./fixtures/preview-envelope-goldens.js";

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

describe("the Preview process-level readers", () => {
    it("applies terminal and channel discipline to the dedicated handshake", () => {
        expect(readPreviewHandshakeOutput(output(DESCRIBE_PREVIEW_SUCCESS)).kind).toBe("read");
        expect(
            readPreviewHandshakeOutput(
                output(DESCRIBE_PREVIEW_SUCCESS, {
                    canceled: true,
                    stderr: utf8Encode("polluted"),
                }),
            ),
        ).toEqual({ kind: "canceled" });
        expect(
            readPreviewHandshakeOutput(output(DESCRIBE_PREVIEW_SUCCESS, { stderr: utf8Encode("polluted") })),
        ).toMatchObject({ kind: "channel-violated", violation: { reason: "stderr-non-empty" } });
        expect(readPreviewHandshakeOutput(output(DESCRIBE_PREVIEW_SUCCESS, { exitCode: 7 }))).toEqual({
            kind: "channel-violated",
            violation: { reason: "exit-code-mismatch", documentExitCode: 0, processExitCode: 7 },
        });
    });

    it("preserves the two independent unsupported-axis outcomes", () => {
        const processFuture = JSON.stringify({
            ...(JSON.parse(DESCRIBE_PREVIEW_SUCCESS) as Record<string, unknown>),
            processContractVersion: 3,
        });
        expect(readPreviewHandshakeOutput(output(processFuture)).kind).toBe("unsupported-process-contract");

        const previewFuture = JSON.stringify({
            ...(JSON.parse(DESCRIBE_PREVIEW_SUCCESS) as Record<string, unknown>),
            previewBuildContractVersion: 2,
        });
        expect(readPreviewHandshakeOutput(output(previewFuture)).kind).toBe("unsupported-preview-contract");
    });

    it("applies the same bounded channel discipline to Preview build results", () => {
        expect(readPreviewBuildOutput(output(BUILD_PREVIEW_SUCCESS)).kind).toBe("read");
        expect(readPreviewBuildOutput(output(BUILD_PREVIEW_SUCCESS, { timedOut: true }))).toEqual({
            kind: "timed-out",
        });
        expect(readPreviewBuildOutput(output(BUILD_PREVIEW_SUCCESS, { exitCode: 5 }))).toEqual({
            kind: "channel-violated",
            violation: { reason: "exit-code-mismatch", documentExitCode: 0, processExitCode: 5 },
        });
    });
});
