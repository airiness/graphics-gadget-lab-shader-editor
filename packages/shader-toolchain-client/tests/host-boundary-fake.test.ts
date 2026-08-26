import { describe, expect, it } from "vitest";
import type { BoundaryResult, HostToolBoundary, ToolCandidate } from "../src/host-boundary.js";
import type { NativeCompileRequest } from "../src/native-compile-request.js";
import {
    FakeHostBoundary,
    utf8Encode,
    type FakeBoundaryCall,
    type FakeToolchainSpec,
} from "../src/testing/fake-host-boundary.js";
import { DESCRIBE_SUCCESS } from "./fixtures/envelope-goldens.js";

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

const COMPILE_OK = `{"command":"compile","success":true,"status":"ok","exitCode":0,"recipeId":"${"3f".repeat(32)}","buildKey":"${"5e".repeat(32)}","binaryHash":"${"9c".repeat(32)}","binaryFormat":"dxil","target":"gglab-dx12","binaryPath":"C:/gglab/build/cache/${"9c".repeat(32)}.dxil","cacheRecordPath":"C:/gglab/build/cache/${"9c".repeat(32)}.dxil.json","fromCache":false,"diagnostics":[]}`;

function spec(change: Partial<FakeToolchainSpec> = {}): FakeToolchainSpec {
    return {
        discovery: { kind: "resolved", candidate: CANDIDATE },
        handshake: { stdout: DESCRIBE_SUCCESS, exitCode: 0 },
        compile: [{ stdout: COMPILE_OK, exitCode: 0 }],
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
        // The four declared capabilities, plus the fake's own test-side
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
                "discover",
                "handshake",
                "handshakeCalls",
                "releasePending",
                "toOutput",
            ].sort(),
        );
        void fake;
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

    it("refuses the spawn BEFORE it happens when the candidate's observation changed — a structured result, never a launch of an unverified executable", async () => {
        const observedNow = "file-identity:sha256:bb";
        const check = { kind: "changed" as const, observedIdentity: observedNow };
        const handshake = new FakeHostBoundary(spec({ candidateCheck: check }));
        const handshakeResult = await handshake.handshake(CANDIDATE);
        expect(handshakeResult).toEqual({
            kind: "candidate-changed",
            candidate: CANDIDATE,
            observedIdentity: observedNow,
        });

        const compile = new FakeHostBoundary(spec({ candidateCheck: check, keepCompilePending: true }));
        const handle = await compile.compile(CANDIDATE, REQUEST);
        const settlement = await handle.result;
        expect(settlement).toEqual({
            kind: "candidate-changed",
            candidate: CANDIDATE,
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
