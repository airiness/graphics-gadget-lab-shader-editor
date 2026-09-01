import { describe, expect, it } from "vitest";
import type { BoundaryResult, HostToolBoundary, ToolCandidate } from "../src/host-boundary.js";
import type { NativeCompileRequest } from "../src/native-compile-request.js";
import type { NativePreviewBuildRequest } from "../src/native-preview-build-request.js";
import { utf8Encode } from "../src/utf8.js";
import {
    FakeHostBoundary,
    type FakeBoundaryCall,
    type FakeToolchainSpec,
} from "../src/testing/fake-host-boundary.js";
import { DESCRIBE_SUCCESS } from "./fixtures/envelope-goldens.js";
import {
    BUILD_PREVIEW_SUCCESS,
    DESCRIBE_PREVIEW_SUCCESS,
    PREVIEW_DESCRIPTOR_IDENTITY,
} from "./fixtures/preview-envelope-goldens.js";

const CANDIDATE: ToolCandidate = {
    rule: "sibling-build",
    toolPath: "C:/gglab/build/output/x64/Debug/gglab-shaderc.exe",
    observationIdentity: "file-identity:sha256:9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c",
    resolvedAt: 1_700_000_000_000,
};

const REQUEST: NativeCompileRequest = {
    source: utf8Encode("void GenerateSurface() { }"),
    sourceIdentity: "ab".repeat(32),
    target: "gglab-dx12",
    stage: "pixel",
    entry: "GenerateSurface",
    defines: [],
    includes: [],
};

const PREVIEW_REQUEST: NativePreviewBuildRequest = {
    sessionId: "12".repeat(16),
    targetProfile: "gglab-dx12",
    profileId: "gglab.surface",
    profileVersion: 2,
    previewInputContractId: "gglab.preview-input.surface.texture2d",
    previewProgramDescriptorIdentity: PREVIEW_DESCRIPTOR_IDENTITY,
    generatedSourceIdentity: "cd".repeat(32),
    generatedSourceBytes: utf8Encode("void EvaluateSurface() { }"),
    attemptSequence: 1,
};

const COMPILE_OK = `{"command":"compile","success":true,"status":"ok","exitCode":0,"recipeId":"${"3f".repeat(32)}","buildKey":"${"5e".repeat(32)}","binaryHash":"${"9c".repeat(32)}","binaryFormat":"dxil","target":"gglab-dx12","binaryPath":"C:/gglab/build/cache/${"9c".repeat(32)}.dxil","cacheRecordPath":"C:/gglab/build/cache/${"9c".repeat(32)}.dxil.json","fromCache":false,"diagnostics":[]}`;

function spec(change: Partial<FakeToolchainSpec> = {}): FakeToolchainSpec {
    return {
        discovery: { kind: "resolved", candidate: CANDIDATE },
        handshake: { stdout: DESCRIBE_SUCCESS, exitCode: 0 },
        previewHandshake: { stdout: DESCRIBE_PREVIEW_SUCCESS, exitCode: 0 },
        compile: [{ stdout: COMPILE_OK, exitCode: 0 }],
        previewBuild: [{ stdout: BUILD_PREVIEW_SUCCESS, exitCode: 0 }],
        ...change,
    };
}

function aSuccessCall(stdout: string, exitCode: number): FakeBoundaryCall {
    return { stdout, exitCode };
}

/** Unwraps a settlement onto its execution output — a structured refusal
 *  is an explicit test failure. */
function outputOf(result: BoundaryResult, what: string) {
    if (result.kind !== "spawned") {
        throw new Error(`test setup: ${what} must settle as spawned`);
    }
    return result.output;
}

describe("the reference fake host boundary", () => {
    it("implements the declared boundary, with no argv surface at all", () => {
        const fake: HostToolBoundary = new FakeHostBoundary(spec());
        // The six declared capabilities, plus the fake's own test-side
        // controls (releasePending, settle bookkeeping) — and nothing
        // that takes an argument array.
        const surface = Object.getOwnPropertyNames(FakeHostBoundary.prototype).sort();
        expect(surface).toEqual(
            [
                "compile",
                "compileCalls",
                "compileScriptFor",
                "constructor",
                "cancel",
                "allocateBuildSequence",
                "buildPreview",
                "discover",
                "discoverCalls",
                "lastDiscoveryRequest",
                "lastPreviewBuild",
                "lastPreviewHandshakeCandidate",
                "handshake",
                "handshakeCalls",
                "preSpawnRefusal",
                "previewBuildCalls",
                "previewBuildScriptFor",
                "previewHandshake",
                "previewHandshakeCalls",
                "releaseDiscovery",
                "releaseHandshake",
                "releasePending",
                "releasePreviewHandshake",
                "toOutput",
            ].sort(),
        );
        void fake;
    });

    it("keeps a discovery in flight until released — with its own call count", async () => {
        const fake = new FakeHostBoundary(spec({ keepDiscoveryPending: true }));
        const pending = fake.discover({ bundled: false });
        expect(fake.discoverCalls, "the discovery call is counted").toBe(1);
        expect(fake.releaseDiscovery(), "one discovery is pending").toBe(true);
        await expect(pending).resolves.toEqual({ candidate: CANDIDATE, failures: [] });
        expect(fake.releaseDiscovery(), "nothing left pending").toBe(false);
    });

    it("keeps a handshake settlement in flight until released — refusals never queue", async () => {
        const fake = new FakeHostBoundary(spec({ keepHandshakePending: true }));
        const pending = fake.handshake(CANDIDATE);
        expect(fake.handshakeCalls, "the handshake call is counted").toBe(1);
        expect(fake.releaseHandshake(), "one handshake is pending").toBe(true);
        await expect(pending).resolves.toMatchObject({ kind: "spawned" });
        expect(fake.releaseHandshake(), "nothing left pending").toBe(false);
        // A scripted refusal still settles at the guard, not in flight:
        const refused = new FakeHostBoundary(spec({ keepHandshakePending: true, preSpawn: { refusal: "launch-failed" } }));
        await expect(refused.handshake(CANDIDATE)).resolves.toEqual({ kind: "launch-failed", candidate: CANDIDATE });
        expect(refused.releaseHandshake()).toBe(false);
    });

    it("keeps the Preview handshake candidate and settlement in one dedicated lane", async () => {
        const fake = new FakeHostBoundary(spec({ keepPreviewHandshakePending: true }));
        const pending = fake.previewHandshake(CANDIDATE);
        expect(fake.previewHandshakeCalls).toBe(1);
        expect(fake.lastPreviewHandshakeCandidate).toEqual(CANDIDATE);
        expect(fake.handshakeCalls, "the ordinary handshake remains independent").toBe(0);
        expect(fake.releasePreviewHandshake()).toBe(true);
        const output = outputOf(await pending, "the Preview handshake");
        expect(output.stdout).toEqual(utf8Encode(DESCRIBE_PREVIEW_SUCCESS));
        expect(fake.releasePreviewHandshake()).toBe(false);
    });

    it("returns the scripted discovery world, resolved or per-rule failed", async () => {
        const resolved = new FakeHostBoundary(spec());
        expect(await resolved.discover({ bundled: false })).toEqual({
            candidate: CANDIDATE,
            failures: [],
        });
        const unavailable = new FakeHostBoundary(
            spec({
                discovery: {
                    kind: "unavailable",
                    failures: [
                        { rule: "explicit-config", reason: "no explicit path configured" },
                        { rule: "sibling-build", reason: "no build output at the configured location" },
                        { rule: "bundled", reason: "no bundled deployment in development" },
                    ],
                },
            }),
        );
        expect(await unavailable.discover({ bundled: false })).toEqual({
            candidate: undefined,
            failures: [
                { rule: "explicit-config", reason: "no explicit path configured" },
                { rule: "sibling-build", reason: "no build output at the configured location" },
                { rule: "bundled", reason: "no bundled deployment in development" },
            ],
        });
    });

    it("settles a handshake with the exact scripted output surface — stderr in the contract's own empty shape by default", async () => {
        const fake = new FakeHostBoundary(spec());
        const output = outputOf(await fake.handshake(CANDIDATE), "the handshake");
        expect(output.stdout).toEqual(utf8Encode(DESCRIBE_SUCCESS));
        expect(output.stderr).toEqual(new Uint8Array(0));
        expect(output.exitCode).toBe(0);
        expect(output.timedOut).toBe(false);
        expect(output.canceled).toBe(false);
        expect(fake.handshakeCalls).toBe(1);
    });

    it("carries a polluted stderr as raw bytes for the client to judge — the fake interprets nothing", async () => {
        const pollution = "dxc: warning: something to the side channel";
        const fake = new FakeHostBoundary(
            spec({ handshake: { stdout: DESCRIBE_SUCCESS, exitCode: 0, stderr: pollution } }),
        );
        const output = outputOf(await fake.handshake(CANDIDATE), "the handshake");
        expect(output.stderr).toEqual(utf8Encode(pollution));
        expect(output.stdout).toEqual(utf8Encode(DESCRIBE_SUCCESS));
    });

    it("refuses the spawn BEFORE it happens when the candidate's observation is invalidated — a structured result, never a launch of an unverified executable", async () => {
        const observedNow = "file-identity:sha256:bb";
        const handshake = new FakeHostBoundary(
            spec({ preSpawn: { refusal: "candidate-invalidated", observation: "changed", observedIdentity: observedNow } }),
        );
        expect(await handshake.handshake(CANDIDATE)).toEqual({
            kind: "candidate-invalidated",
            candidate: CANDIDATE,
            observation: "changed",
            observedIdentity: observedNow,
        });

        const missing = new FakeHostBoundary(
            spec({ preSpawn: { refusal: "candidate-invalidated", observation: "missing" } }),
        );
        expect(await missing.handshake(CANDIDATE)).toEqual({
            kind: "candidate-invalidated",
            candidate: CANDIDATE,
            observation: "missing",
            observedIdentity: null,
        });

        const compile = new FakeHostBoundary(
            spec({
                preSpawn: { refusal: "candidate-invalidated", observation: "changed", observedIdentity: observedNow },
                keepCompilePending: true,
            }),
        );
        const handle = await compile.compile(CANDIDATE, REQUEST);
        expect(await handle.result).toEqual({
            kind: "candidate-invalidated",
            candidate: CANDIDATE,
            observation: "changed",
            observedIdentity: observedNow,
        });
        // A refused spawn is not an in-flight attempt: cancel reports it
        // as already settled.
        expect(await compile.cancel(handle.buildId)).toEqual({
            buildId: handle.buildId,
            canceled: false,
            alreadySettled: true,
        });
    });

    it("reports bounded execution failing to launch as a structured fact — launch-failed, not a crash", async () => {
        const handshake = new FakeHostBoundary(spec({ preSpawn: { refusal: "launch-failed" } }));
        expect(await handshake.handshake(CANDIDATE)).toEqual({ kind: "launch-failed", candidate: CANDIDATE });
        const compile = new FakeHostBoundary(spec({ preSpawn: { refusal: "launch-failed" } }));
        const handle = await compile.compile(CANDIDATE, REQUEST);
        expect(await handle.result).toEqual({ kind: "launch-failed", candidate: CANDIDATE });
        const previewHandshake = new FakeHostBoundary(spec({ preSpawn: { refusal: "launch-failed" } }));
        await expect(previewHandshake.previewHandshake(CANDIDATE)).resolves.toEqual({
            kind: "launch-failed",
            candidate: CANDIDATE,
        });
        const previewBuild = new FakeHostBoundary(spec({ preSpawn: { refusal: "launch-failed" } }));
        const previewHandle = await previewBuild.buildPreview(CANDIDATE, PREVIEW_REQUEST);
        expect(await previewHandle.result).toEqual({ kind: "launch-failed", candidate: CANDIDATE });
    });

    it("keeps Preview build candidate/request values intact and shares the ordered build-id lane", async () => {
        const fake = new FakeHostBoundary(spec());
        const ordinary = await fake.compile(CANDIDATE, REQUEST);
        const preview = await fake.buildPreview(CANDIDATE, PREVIEW_REQUEST);
        expect(ordinary.buildId.sequence).toBe(1);
        expect(preview.buildId.sequence).toBe(2);
        expect(fake.previewBuildCalls).toBe(1);
        expect(fake.lastPreviewBuild).toEqual({ candidate: CANDIDATE, request: PREVIEW_REQUEST });
        const output = outputOf(await preview.result, "the Preview build");
        expect(output.stdout).toEqual(utf8Encode(BUILD_PREVIEW_SUCCESS));
    });

    it("issues separate BuildIds and settles each spawn with its own script", async () => {
        const fake = new FakeHostBoundary(
            spec({
                compile: [
                    aSuccessCall(COMPILE_OK, 0),
                    { stdout: "", exitCode: 4, timedOut: false },
                ],
            }),
        );
        const first = await fake.compile(CANDIDATE, REQUEST);
        const second = await fake.compile(CANDIDATE, REQUEST);
        expect(first.buildId).not.toEqual(second.buildId);
        const firstResult = outputOf(await first.result, "the first compile");
        const secondResult = outputOf(await second.result, "the second compile");
        expect(firstResult.stdout).toEqual(utf8Encode(COMPILE_OK));
        expect(secondResult.exitCode).toBe(4);
        expect(fake.compileCalls).toBe(2);
    });

    it("keeps spawns in flight under the script's control, with no time elapsing", async () => {
        const fake = new FakeHostBoundary(
            spec({ keepCompilePending: true, compile: [aSuccessCall(COMPILE_OK, 0), { stdout: "", exitCode: 7 }] }),
        );
        // Before any compile: nothing is in flight — an explicit fact.
        expect(fake.releasePending()).toBe(false);
        const pending = await fake.compile(CANDIDATE, REQUEST);
        expect(fake.releasePending(pending.buildId)).toBe(true);
        const settled = outputOf(await pending.result, "the pending compile");
        expect(settled.stdout).toEqual(utf8Encode(COMPILE_OK));
        // A second in-flight spawn coexists until its own settlement.
        const second = await fake.compile(CANDIDATE, REQUEST);
        expect(second.buildId.sequence).toBe(2);
        expect(fake.releasePending(pending.buildId)).toBe(false);
        expect(fake.releasePending(second.buildId)).toBe(true);
        const secondSettled = outputOf(await second.result, "the second compile");
        expect(secondSettled.exitCode).toBe(7);
    });

    it("settles an in-flight spawn with an explicit structured settlement when the world reports one — the script is only the default", async () => {
        const fake = new FakeHostBoundary(spec({ keepCompilePending: true }));
        const inFlight = await fake.compile(CANDIDATE, REQUEST);
        const settlement: BoundaryResult = {
            kind: "candidate-invalidated",
            candidate: CANDIDATE,
            observation: "missing",
            observedIdentity: null,
        };
        expect(fake.releasePending(inFlight.buildId, settlement)).toBe(true);
        await expect(inFlight.result).resolves.toEqual(settlement);
        // The scripted settlement is unchanged for the others: a fresh
        // spawn still settles with its own script.
        const next = await fake.compile(CANDIDATE, REQUEST);
        expect(fake.releasePending(next.buildId)).toBe(true);
        const scripted = outputOf(await next.result, "the scripted settlement");
        expect(scripted.stdout).toEqual(utf8Encode(COMPILE_OK));
    });

    it("cancels an in-flight spawn as an explicit terminal state, and reports an already-settled fact", async () => {
        const fake = new FakeHostBoundary(spec({ keepCompilePending: true }));
        const inFlight = await fake.compile(CANDIDATE, REQUEST);
        const cancelled = await fake.cancel(inFlight.buildId);
        expect(cancelled).toEqual({
            buildId: inFlight.buildId,
            canceled: true,
            alreadySettled: false,
        });
        const settled = outputOf(await inFlight.result, "the canceled compile");
        expect(settled.canceled).toBe(true);
        expect(settled.stdout).toEqual(new Uint8Array(0));
        expect(settled.stderr).toEqual(new Uint8Array(0));
        const again = await fake.cancel(inFlight.buildId);
        expect(again.alreadySettled).toBe(true);
    });

    it("keeps the timeout state in the output surface, not a hang", async () => {
        const fake = new FakeHostBoundary(
            spec({ compile: [{ stdout: "", exitCode: -1, timedOut: true }] }),
        );
        const attempt = await fake.compile(CANDIDATE, REQUEST);
        const output = outputOf(await attempt.result, "the timed-out compile");
        expect(output.timedOut).toBe(true);
        expect(output.exitCode).toBe(-1);
        expect(output.stdout).toEqual(new Uint8Array(0));
    });
});
