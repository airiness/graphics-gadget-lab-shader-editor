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

    it("a failed stop request rejects BOTH a concurrent stop and the strict teardown, with no hang", async () => {
        const boundary = runtime({
            launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }],
            holdStopUntilRelease: true,
            stopReleaseKind: "stopped",
            stopRequestFailure: true,
        });
        const manager = managerFor(boundary);
        const launched = await manager.launch(CANDIDATE_A);
        if (launched.launched !== true) {
            throw new Error("test launch must attach");
        }

        // Stop request pending and then REJECTED; a strict teardown
        // started concurrently must join that SAME request and reject too —
        // never hang on the stale exit settlement.
        const plain = manager.stop();
        const strict = manager.terminateAndJoin();
        await expect(plain).rejects.toThrow(/stop request/i);
        await expect(strict).rejects.toThrow(/stop request failed|could not be stopped/i);

        // State rolled back to `running`; ownership (and the settlement)
        // retained; a retry stop now settles and completes the teardown.
        expect(manager.state).toMatchObject({ kind: "running", runtimeId: { sequence: 1 } });
        expect(manager.ownedRuntime).toMatchObject({ deploymentToolPath: CANDIDATE_A.toolPath });

        await expect(manager.stop()).resolves.toMatchObject({ outcome: "stop-requested" });
        expect(boundary.releaseStop()).toBe(true);
        await expect(manager.terminateAndJoin()).resolves.toEqual({ outcome: "terminated" });
        expect(manager.state).toEqual({ kind: "idle" });
    });

    it("an exact rejected stop lane rejects the strict teardown even if a stop RETRY follows (never a hang)", async () => {
        const boundary = runtime(
            {
                launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }],
                holdStopUntilRelease: true,
                stopReleaseKind: "stopped",
                stopRequestFailure: true,
            },
        );
        const manager = managerFor(boundary);
        const launched = await manager.launch(CANDIDATE_A);
        if (launched.launched !== true) {
            throw new Error("test launch must attach");
        }

        // stop #1 (a plain Stop intent) fails; state rolls back to `running`.
        await expect(manager.stop()).rejects.toThrow(/stop request/i);
        expect(manager.state).toMatchObject({ kind: "running" });

        // stop #2 (the strict teardown's own lane) also fails, and a
        // concurrent RETRY joins that same lane. The strict teardown is
        // bound to the EXACT lane it awaits: when that lane rejects it
        // must REJECT — never adopt the retry, never hang on a settlement
        // no live stop request owns.
        boundary.armStopRequestFailure();
        const strict = manager.terminateAndJoin();
        const retry = manager.stop();
        await expect(strict).rejects.toThrow(/could not be stopped|new intent/i);
        await expect(retry).rejects.toThrow(/stop request/i);
        expect(manager.state).toMatchObject({ kind: "running" });
        expect(manager.ownedRuntime).toMatchObject({ deploymentToolPath: CANDIDATE_A.toolPath });

        // Recovery with a fresh intent:
        await expect(manager.stop()).resolves.toMatchObject({ outcome: "stop-requested" });
        expect(boundary.releaseStop()).toBe(true);
        await expect(manager.terminateAndJoin()).resolves.toEqual({ outcome: "terminated" });
        expect(manager.state).toEqual({ kind: "idle" });
    });

    it("terminates a launch that settles AFTER an unmount-style strict teardown was started", async () => {
        const boundary = runtime(
            {
                launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }],
                keepLaunchPending: true,
                holdStopUntilRelease: true,
                stopReleaseKind: "stopped",
            },
        );
        const manager = managerFor(boundary);
        const pendingLaunch = manager.launch(CANDIDATE_A);

        // unmount cleanup: strict teardown fired while the launch is still
        // in flight (a plain stop would be a no-op and orphan the Runtime)
        const teardown = manager.terminateAndJoin();
        expect(boundary.releaseLaunch()).toBe(true);
        const launched = await pendingLaunch;
        expect(launched.launched).toBe(true);

        // the SAME pending teardown then requests the stop for the
        // just-settled Runtime and completes when the exit is proven
        expect(boundary.releaseStop()).toBe(true);
        await expect(teardown).resolves.toEqual({ outcome: "terminated" });
        expect(boundary.resolvedExits).toBe(1);
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

    it("a NATURAL wait-failed exit (no stop request) is also unproven and retains the binding", async () => {
        const boundary = runtime({ launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }] });
        const manager = managerFor(boundary);
        const launched = await manager.launch(CANDIDATE_A);
        if (launched.launched !== true) {
            throw new Error("test launch must attach");
        }
        expect(manager.ownedRuntime).toMatchObject({ runtimeId: { sequence: 1 } });

        // The host "exited" but could not prove it (natural wait-failed).
        expect(boundary.exit({ sequence: 1 }, 0, "wait-failed")).toBe(true);
        await launched.exited;
        expect(manager.state).toMatchObject({ kind: "exit-unproven", runtimeId: { sequence: 1 } });
        // Ownership + deployment binding RETAINED — the process may still exist.
        expect(manager.ownedRuntime).toEqual({
            runtimeId: { sequence: 1 },
            runtimeIdentity: "runtime-a",
            deploymentToolPath: CANDIDATE_A.toolPath,
        });
        // And the launch lane is structurally closed:
        await expect(manager.launch(CANDIDATE_A)).resolves.toMatchObject({
            launched: false,
            reason: "exit-unproven",
        });
        expect(boundary.launchCalls).toBe(1);
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
        // `already-exited` is also valid from `launch-refused` (the manager
        // has PROVEN no owned Runtime) — never from a host registry miss.
        await expect(manager.terminateAndJoin()).resolves.toEqual({ outcome: "already-exited" });

        const second = await manager.launch(CANDIDATE_A);
        expect(second.launched).toBe(true);
        expect(manager.state).toMatchObject({ kind: "running" });
        if (second.launched === true) {
            expect(boundary.exit({ sequence: 1 }, 0)).toBe(true);
            await second.exited;
            expect(manager.state).toEqual({ kind: "idle" });
        }
    });

    it("threads a host session-already-running fact through an ownership-conflict state end-to-end", async () => {
        const boundary = runtime({ launches: [{ kind: "session-already-running", runtimeId: { sequence: 42 } }] });
        const manager = managerFor(boundary);

        const first = await manager.launch(CANDIDATE_A);
        expect(first).toEqual({
            launched: false,
            reason: "runtime-ownership-conflict",
            runtimeId: { sequence: 42 },
        });
        expect(manager.state).toEqual({ kind: "runtime-ownership-conflict", runtimeId: { sequence: 42 } });
        // `ownedRuntime === null` here must NEVER be read as "no Runtime":
        expect(manager.ownedRuntime).toBeNull();

        // No second Runtime launch — and no host call.
        const callsBefore = boundary.launchCalls;
        await expect(manager.launch(CANDIDATE_A)).resolves.toEqual({
            launched: false,
            reason: "runtime-ownership-conflict",
            runtimeId: { sequence: 42 },
        });
        expect(boundary.launchCalls).toBe(callsBefore);

        // Strict teardown may NOT return `already-exited` (that would
        // invert the host's ownership fact) — and the ownership transition
        // therefore cannot commit.
        await expect(manager.terminateAndJoin()).rejects.toThrow(/already running for this session/i);

        // A plain stop has no lease to act on (no host call either).
        await expect(manager.stop()).resolves.toEqual({ outcome: "not-attached" });
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
