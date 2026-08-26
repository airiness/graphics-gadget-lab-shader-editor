import { describe, expect, it } from "vitest";
import type { HostToolBoundary, ToolCandidate } from "../src/host-boundary.js";
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
        const output = await fake.handshake(CANDIDATE);
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
        const output = await fake.handshake(CANDIDATE);
        expect(output.stderr).toEqual(utf8Encode(pollution));
        expect(output.stdout).toEqual(utf8Encode(DESCRIBE_SUCCESS));
    });

    it("settles a canceled attempt with both streams empty and the canceled fact", async () => {
        const fake = new FakeHostBoundary(spec({ keepCompilePending: true }));
        const inFlight = await fake.compile(CANDIDATE, REQUEST);
        await fake.cancel(inFlight.buildId);
        const settled = await inFlight.result;
        expect(settled.canceled).toBe(true);
        expect(settled.stdout).toEqual(new Uint8Array(0));
        expect(settled.stderr).toEqual(new Uint8Array(0));
    });

    it("issues separate BuildIds and settles each attempt with its own script", async () => {
        const ok = `{"command":"compile","success":true,"status":"ok","exitCode":0,"recipeId":"${"3f".repeat(32)}","buildKey":"${"5e".repeat(32)}","binaryHash":"${"9c".repeat(32)}","binaryFormat":"dxil","target":"gglab-dx12","binaryPath":"C:/gglab/build/cache/${"9c".repeat(32)}.dxil","cacheRecordPath":"C:/gglab/build/cache/${"9c".repeat(32)}.dxil.json","fromCache":false,"diagnostics":[]}`;
        const fake = new FakeHostBoundary(
            spec({
                compile: [
                    aSuccessCall(ok, 0),
                    { stdout: "", exitCode: 4, timedOut: false },
                ],
            }),
        );
        const first = await fake.compile(CANDIDATE, REQUEST);
        const second = await fake.compile(CANDIDATE, REQUEST);
        expect(first.buildId).not.toEqual(second.buildId);
        const firstResult = await first.result;
        const secondResult = await second.result;
        expect(firstResult.stdout).toEqual(utf8Encode(ok));
        expect(secondResult.exitCode).toBe(4);
        expect(fake.compileCalls).toBe(2);
    });

    it("keeps attempts in flight under the script's control, with no time elapsing", async () => {
        const ok = `{"command":"compile","success":true,"status":"ok","exitCode":0,"recipeId":"${"3f".repeat(32)}","buildKey":"${"5e".repeat(32)}","binaryHash":"${"9c".repeat(32)}","binaryFormat":"dxil","target":"gglab-dx12","binaryPath":"C:/gglab/build/cache/${"9c".repeat(32)}.dxil","cacheRecordPath":"C:/gglab/build/cache/${"9c".repeat(32)}.dxil.json","fromCache":false,"diagnostics":[]}`;
        const fake = new FakeHostBoundary(
            spec({ keepCompilePending: true, compile: [aSuccessCall(ok, 0), { stdout: "", exitCode: 7 }] }),
        );
        // Before any compile: nothing is in flight — an explicit fact.
        expect(fake.releasePending()).toBe(false);
        const pending = await fake.compile(CANDIDATE, REQUEST);
        expect(fake.releasePending(pending.buildId)).toBe(true);
        const settled = await pending.result;
        expect(settled.stdout).toEqual(utf8Encode(ok));
        // A second in-flight attempt coexists until its own settlement.
        const second = await fake.compile(CANDIDATE, REQUEST);
        expect(second.buildId.sequence).toBe(2);
        expect(fake.releasePending(pending.buildId)).toBe(false);
        expect(fake.releasePending(second.buildId)).toBe(true);
        expect((await second.result).exitCode).toBe(7);
    });

    it("cancels an in-flight attempt as an explicit terminal state, and reports an already-settled fact", async () => {
        const fake = new FakeHostBoundary(spec({ keepCompilePending: true }));
        const inFlight = await fake.compile(CANDIDATE, REQUEST);
        const cancelled = await fake.cancel(inFlight.buildId);
        expect(cancelled).toEqual({
            buildId: inFlight.buildId,
            canceled: true,
            alreadySettled: false,
        });
        const settled = await inFlight.result;
        expect(settled.canceled).toBe(true);
        expect(settled.stdout).toEqual(new Uint8Array(0));
        const again = await fake.cancel(inFlight.buildId);
        expect(again.alreadySettled).toBe(true);
    });

    it("keeps the timeout state in the output surface, not a hang", async () => {
        const fake = new FakeHostBoundary(
            spec({ compile: [{ stdout: "", exitCode: -1, timedOut: true }] }),
        );
        const attempt = await fake.compile(CANDIDATE, REQUEST);
        const output = await attempt.result;
        expect(output.timedOut).toBe(true);
        expect(output.exitCode).toBe(-1);
        expect(output.stdout).toEqual(new Uint8Array(0));
    });
});
