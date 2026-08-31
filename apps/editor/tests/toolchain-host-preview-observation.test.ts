import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCandidate } from "@gglab/shader-toolchain-client";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
    invoke,
    Channel: class<T> {
        constructor(readonly onmessage: (message: T) => void) {}
    },
}));

import {
    createTauriPreviewObservationBoundary,
    createTauriPreviewRuntimeBoundary,
} from "../src/toolchain-host.js";

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

describe("Tauri attached Preview Runtime boundary", () => {
    beforeEach(() => invoke.mockReset());

    it("launches by candidate/session identity and binds the exit channel", async () => {
        invoke.mockResolvedValue({
            kind: "launched",
            runtimeId: { sequence: 4 },
            runtimeIdentity: "c".repeat(64),
        });
        const boundary = await createTauriPreviewRuntimeBoundary();
        const launch = await boundary.launchAttachedPreview(CANDIDATE, "56".repeat(16));
        expect(invoke).toHaveBeenCalledOnce();
        const call = invoke.mock.calls[0];
        expect(call?.[0]).toBe("shader-preview-launch-runtime");
        expect(call?.[1]).toMatchObject({ candidate: CANDIDATE, sessionId: "56".repeat(16) });
        if (launch.kind !== "launched") {
            throw new Error("the host script must launch");
        }
        const channel = (call?.[1] as { channel: { onmessage: (value: unknown) => void } }).channel;
        channel.onmessage({ runtimeId: { sequence: 4 }, kind: "exited", exitCode: 0 });
        await expect(launch.exited).resolves.toEqual({
            runtimeId: { sequence: 4 },
            kind: "exited",
            exitCode: 0,
        });
    });

    it("stops by host-issued RuntimeId only", async () => {
        invoke.mockResolvedValue({
            runtimeId: { sequence: 7 },
            stopRequested: true,
            alreadySettled: false,
        });
        const boundary = await createTauriPreviewRuntimeBoundary();
        await expect(boundary.stopAttachedPreview({ sequence: 7 })).resolves.toEqual({
            runtimeId: { sequence: 7 },
            stopRequested: true,
            alreadySettled: false,
        });
        expect(invoke).toHaveBeenCalledWith("shader-preview-stop-runtime", {
            runtimeId: { sequence: 7 },
        });
    });
});
