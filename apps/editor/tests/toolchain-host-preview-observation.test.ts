import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCandidate } from "@gglab/shader-toolchain-client";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
    invoke,
    Channel: class {},
}));

import { createTauriPreviewObservationBoundary } from "../src/toolchain-host.js";

const CANDIDATE: ToolCandidate = {
    rule: "explicit-config",
    toolPath: "C:/gglab/gglab-shaderc.exe",
    observationIdentity: "a".repeat(64),
    resolvedAt: 1,
};

describe("Tauri Preview observation boundary", () => {
    beforeEach(() => invoke.mockReset());

    it("sends identities only and materializes the host byte array", async () => {
        invoke.mockResolvedValue({ kind: "read", bytes: [0, 1, 255] });
        const boundary = await createTauriPreviewObservationBoundary();
        const result = await boundary.readPreviewObservation(CANDIDATE, "12".repeat(16));

        expect(invoke).toHaveBeenCalledOnce();
        expect(invoke).toHaveBeenCalledWith("shader-preview-read-observation", {
            candidate: CANDIDATE,
            sessionId: "12".repeat(16),
        });
        expect(result).toEqual({ kind: "read", bytes: new Uint8Array([0, 1, 255]) });
        if (result.kind === "read") {
            expect(result.bytes).toBeInstanceOf(Uint8Array);
        }
    });

    it("preserves a structured candidate invalidation without interpreting it", async () => {
        invoke.mockResolvedValue({
            kind: "candidate-invalidated",
            candidate: CANDIDATE,
            observation: "missing",
            observedIdentity: null,
        });
        const boundary = await createTauriPreviewObservationBoundary();
        await expect(boundary.readPreviewObservation(CANDIDATE, "34".repeat(16))).resolves.toEqual({
            kind: "candidate-invalidated",
            candidate: CANDIDATE,
            observation: "missing",
            observedIdentity: null,
        });
    });
});
