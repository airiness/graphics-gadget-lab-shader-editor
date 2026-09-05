import { describe, expect, it } from "vitest";
import {
    FakePreviewRuntimeBoundary,
    type FakePreviewRuntimeSpec,
    type PreviewRuntimeBoundary,
    type PreviewRuntimeId,
    type ToolCandidate,
} from "@gglab/shader-toolchain-client";
import { AttachedPreviewRuntimeManager } from "../src/preview-runtime-manager.js";

const SESSION_ID = "12".repeat(16);

const CANDIDATE_A: ToolCandidate = {
    rule: "bundled",
    toolPath: "C:/tools/gglab-shaderc.exe",
    observationIdentity: "candidate-a",
    resolvedAt: 1,
};

function runtime(spec: FakePreviewRuntimeSpec): FakePreviewRuntimeBoundary {
    return new FakePreviewRuntimeBoundary(spec);
}

function managerFor(boundary: PreviewRuntimeBoundary): AttachedPreviewRuntimeManager {
    return new AttachedPreviewRuntimeManager(boundary, SESSION_ID);
}

describe("attached Preview Runtime lifetime authority — state machine", () => {
    it("attaches one candidate/session launch (strict single-flight) and projects the owned binding", async () => {
        const boundary = runtime({ launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], keepLaunchPending: true });
        const manager = managerFor(boundary);

        const first = manager.launch(CANDIDATE_A);
        const second = manager.launch(CANDIDATE_A);
        expect(second).toBe(first);
        expect(manager.launchInFlight).toBe(true);
        expect(manager.ownedRuntime).toBeNull();
        expect(boundary.launchCalls).toBe(1);
        expect(boundary.lastLaunch).toEqual({ candidate: CANDIDATE_A, sessionId: SESSION_ID });

        expect(boundary.releaseLaunch()).toBe(true);
        const launched = await first;
        if (launched.launched !== true) {
            throw new Error("test launch must attach");
        }
        expect(manager.state).toEqual({ kind: "running", runtimeId: { sequence: 1 }, runtimeIdentity: "runtime-a" });
        expect(manager.ownedRuntime).toEqual({
            runtimeId: { sequence: 1 },
            runtimeIdentity: "runtime-a",
            deploymentToolPath: CANDIDATE_A.toolPath,
        });
    });

    it("releases ownership only on a PROVEN exit (natural or requested)", async () => {
        const boundary = runtime({ launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }] });
        const manager = managerFor(boundary);
        const launched = await manager.launch(CANDIDATE_A);
        if (launched.launched !== true) {
            throw new Error("test launch must attach");
        }
        expect(boundary.exit({ sequence: 1 }, 0)).toBe(true);
        await launched.exited;
        expect(manager.state).toEqual({ kind: "idle" });
        expect(manager.ownedRuntime).toBeNull();
        expect(manager.launchInFlight).toBe(false);
    });
});

describe("attached Preview Runtime lifetime authority — termination proof", () => {
    it("returns already-exited when no Runtime is attached (no host call)", async () => {
        const boundary = runtime({ launches: [{ kind: "launched" }] });
        const manager = managerFor(boundary);
        await expect(manager.terminateAndJoin()).resolves.toEqual({ outcome: "already-exited" });
        await expect(manager.stop()).resolves.toEqual({ outcome: "not-attached" });
        expect(boundary.launchCalls).toBe(0);
        expect(manager.state).toEqual({ kind: "idle" });
    });

    it("joins a repeated stop into the SAME teardown (no second host request)", async () => {
        const boundary = runtime(
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true },
        );
        const stopCalls: number[] = [];
        const spying: PreviewRuntimeBoundary = {
            launchAttachedPreview: (candidate: ToolCandidate, sessionId: string) =>
                boundary.launchAttachedPreview(candidate, sessionId),
            stopAttachedPreview: (id: PreviewRuntimeId) => {
                stopCalls.push(id.sequence);
                return boundary.stopAttachedPreview(id);
            },
        };
        const manager = managerFor(spying);
        const launched = await manager.launch(CANDIDATE_A);
        if (launched.launched !== true) {
            throw new Error("test launch must attach");
        }

        const first = await manager.stop();
        expect(first).toMatchObject({ outcome: "stop-requested" });
        expect(manager.state).toMatchObject({ kind: "terminating", runtimeId: { sequence: 1 } });
        // Ownership is RETAINED while terminating (the exact binding, not dropped).
        expect(manager.ownedRuntime).toMatchObject({ runtimeId: { sequence: 1 }, runtimeIdentity: "runtime-a" });

        const second = await manager.stop();
        expect(second).toMatchObject({ outcome: "join-in-progress" });
        expect(stopCalls).toEqual([1]);

        expect(boundary.releaseStop()).toBe(true);
        await expect(manager.terminateAndJoin()).resolves.toEqual({ outcome: "terminated" });
        expect(stopCalls).toEqual([1]);
        expect(manager.state).toEqual({ kind: "idle" });
        expect(manager.ownedRuntime).toBeNull();
    });
});

describe("attached Preview Runtime lifetime authority — the unproven exit", () => {
    it("IN-05 (closed): a wait-failed exit is sticky, refuses a second launch, re-reports, and retains the binding", async () => {
        const boundary = runtime({
            launches: [
                { kind: "launched", runtimeIdentity: "runtime-a" },
                { kind: "launched", runtimeIdentity: "runtime-b" },
            ],
            holdStopUntilRelease: true,
            stopReleaseKind: "wait-failed",
        });
        const manager = managerFor(boundary);
        const launched = await manager.launch(CANDIDATE_A);
        if (launched.launched !== true) {
            throw new Error("test launch must attach");
        }

        // Strict teardown requested; the host holds the settlement and then
        // settles it as wait-failed (best-effort kill, no proof of exit).
        const teardown = manager.terminateAndJoin();
        expect(boundary.releaseStop()).toBe(true);
        await expect(teardown).resolves.toEqual({ outcome: "exit-unproven", runtimeId: { sequence: 1 } });

        expect(manager.state).toMatchObject({ kind: "exit-unproven", runtimeId: { sequence: 1 } });
        // The ownership binding is RETAINED: the process may still exist.
        expect(manager.ownedRuntime).toEqual({
            runtimeId: { sequence: 1 },
            runtimeIdentity: "runtime-a",
            deploymentToolPath: CANDIDATE_A.toolPath,
        });

        // The red baseline (recorded FAIL on the previous architecture) is
        // now closed: no second launch may be admitted — structurally.
        const launchCallsBefore = boundary.launchCalls;
        await expect(manager.launch(CANDIDATE_A)).resolves.toEqual({
            launched: false,
            reason: "exit-unproven",
            runtimeId: { sequence: 1 },
        });
        expect(boundary.launchCalls).toBe(launchCallsBefore);

        // Sticky, honestly re-reported, with NO host call:
        await expect(manager.stop()).resolves.toEqual({
            outcome: "unproven-rejoin",
            runtimeId: { sequence: 1 },
        });
        await expect(manager.terminateAndJoin()).resolves.toEqual({
            outcome: "exit-unproven",
            runtimeId: { sequence: 1 },
        });
        expect(manager.state).toMatchObject({ kind: "exit-unproven" });
        expect(manager.ownedRuntime).not.toBeNull();
    });

    it("refuses a launch while terminating; the next launch attaches only after the PROVEN exit", async () => {
        const boundary = runtime(
            {
                launches: [
                    { kind: "launched", runtimeIdentity: "runtime-a" },
                    { kind: "launched", runtimeIdentity: "runtime-b" },
                ],
                holdStopUntilRelease: true,
                stopReleaseKind: "stopped",
            },
        );
        const manager = managerFor(boundary);
        const old = await manager.launch(CANDIDATE_A);
        if (old.launched !== true) {
            throw new Error("test launch must attach");
        }
        expect(await manager.stop()).toMatchObject({ outcome: "stop-requested" });
        expect(manager.state).toMatchObject({ kind: "terminating" });

        // No queued relaunch: an attached (terminating) Runtime refuses a
        // second one until the teardown is PROVEN.
        await expect(manager.launch(CANDIDATE_A)).resolves.toMatchObject({
            launched: false,
            reason: "runtime-attached",
        });
        expect(boundary.launchCalls).toBe(1);

        expect(boundary.releaseStop()).toBe(true);
        await expect(manager.terminateAndJoin()).resolves.toEqual({ outcome: "terminated" });
        expect(manager.state).toEqual({ kind: "idle" });

        const next = await manager.launch(CANDIDATE_A);
        if (next.launched !== true) {
            throw new Error("the next launch must attach after the proven exit");
        }
        expect(next.runtimeId).toEqual({ sequence: 2 });
        expect(boundary.launchCalls).toBe(2);
    });
});

describe("attached Preview Runtime lifetime authority — launch refusal", () => {
    it("reports host refusals as launch-refused and admits a retry from that state", async () => {
        const boundary = runtime({
            launches: [
                { kind: "runtime-unavailable", observation: "missing" },
                { kind: "launched", runtimeIdentity: "runtime-a" },
            ],
        });
        const manager = managerFor(boundary);
        const first = await manager.launch(CANDIDATE_A);
        expect(first).toMatchObject({ launched: false, reason: "host-refused" });
        expect(manager.state).toMatchObject({ kind: "launch-refused" });
        expect(manager.ownedRuntime).toBeNull();
        expect(manager.launchInFlight).toBe(false);

        const second = await manager.launch(CANDIDATE_A);
        expect(second.launched).toBe(true);
        expect(manager.state).toMatchObject({ kind: "running" });
        if (second.launched === true) {
            expect(boundary.exit({ sequence: 1 }, 0)).toBe(true);
            await second.exited;
            expect(manager.state).toEqual({ kind: "idle" });
        }
    });

    it("throws on an attached Runtime missing its exit settlement (invariant, never a no-op)", async () => {
        const boundary = runtime({ launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }] });
        const manager = managerFor(boundary);
        const launched = await manager.launch(CANDIDATE_A);
        if (launched.launched !== true) {
            throw new Error("test launch must attach");
        }
        (manager as unknown as { exitSettlement: unknown }).exitSettlement = null;
        await expect(manager.terminateAndJoin()).rejects.toThrow(/no exit settlement/);
    });
});
