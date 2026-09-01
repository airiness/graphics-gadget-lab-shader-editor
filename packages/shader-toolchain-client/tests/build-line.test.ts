import { describe, expect, it } from "vitest";
import type { ToolFacts } from "../src/contract-facts.js";
import {
    attemptOutcomeOfCompileResult,
    attemptStateOf,
    currentAttemptOf,
    emptyLine,
    lastGoodAttemptOf,
    recordToLine,
    reportBuildLine,
    type AttemptOutcome,
    type AttemptRecord,
    type AttemptTermination,
    type BuildLine,
} from "../src/build-line.js";
import type { ToolCandidate } from "../src/host-boundary.js";
import { buildIntentOf, type BuildIntent, type NativeCompileRequest } from "../src/native-compile-request.js";
import { readCompileDocument } from "../src/result-envelope.js";
import { COMPILE_FAILURE_EXAMPLE, COMPILE_SUCCESS } from "./fixtures/envelope-goldens.js";
import { utf8Encode } from "../src/utf8.js";

function facts(producerIdentity: string = "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)"): ToolFacts {
    return {
        toolIdentity: "gglab-shaderc",
        toolVersion: "1.1.0",
        processContractVersion: 2,
        compilePolicyRevision: 1,
        producerKind: "dxc",
        producerIdentity,
        supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
    };
}

function request(target: string = "gglab-dx12"): NativeCompileRequest {
    return {
        source: utf8Encode("void GenerateSurface() { }"),
        sourceIdentity: "ab".repeat(32),
        target,
        stage: "pixel",
        entry: "GenerateSurface",
        defines: [],
        includes: [],
    };
}

function successEnvelope() {
    const outcome = readCompileDocument(COMPILE_SUCCESS);
    if (outcome.status !== "read") {
        throw new Error("test setup: the success golden must read");
    }
    const document = outcome.document;
    if (document.success !== true) {
        throw new Error("test setup: the success golden must be the success document");
    }
    return document;
}

function failureEnvelope() {
    const outcome = readCompileDocument(COMPILE_FAILURE_EXAMPLE);
    if (outcome.status !== "read") {
        throw new Error("test setup: the failure golden must read");
    }
    const document = outcome.document;
    if (document.success !== false) {
        throw new Error("test setup: the failure golden must be the failure document");
    }
    return document;
}

function succeeded(sequence: number, intent: BuildIntent): AttemptRecord {
    return { buildId: { sequence }, intent, outcome: { kind: "succeeded", envelope: successEnvelope() } };
}

function failed(sequence: number, intent: BuildIntent): AttemptRecord {
    return { buildId: { sequence }, intent, outcome: { kind: "failed", envelope: failureEnvelope() } };
}

function failedWith(sequence: number, intent: BuildIntent, termination: AttemptTermination): AttemptRecord {
    return { buildId: { sequence }, intent, outcome: { kind: "failed", termination } };
}

function canceled(sequence: number, intent: BuildIntent): AttemptRecord {
    return { buildId: { sequence }, intent, outcome: { kind: "canceled" } };
}

const INTENT_DX12 = buildIntentOf(request("gglab-dx12"), facts());
const INTENT_VULKAN = buildIntentOf(request("gglab-vulkan13"), facts());

describe("the revisioned build-line rules", () => {
    it("is empty: nothing is current, nothing is last-good, nothing in flight", () => {
        const line = emptyLine();
        const report = reportBuildLine(line, INTENT_DX12);
        expect(report.current).toBeUndefined();
        expect(report.lastGood).toBeUndefined();
        expect(report.states).toEqual([]);
        expect(report.inFlight).toEqual([]);
    });

    it("a first success is current and last-good for its intent", () => {
        const line = recordToLine(emptyLine(), succeeded(1, INTENT_DX12));
        expect(currentAttemptOf(line, INTENT_DX12)?.buildId.sequence).toBe(1);
        expect(lastGoodAttemptOf(line)?.buildId.sequence).toBe(1);
        expect(attemptStateOf(line, succeeded(1, INTENT_DX12), INTENT_DX12)).toBe("current");
    });

    it("advancing the build intent demotes the previous current to stale, retained as evidence", () => {
        let line = recordToLine(emptyLine(), succeeded(1, INTENT_DX12));
        line = recordToLine(line, succeeded(2, INTENT_VULKAN));
        expect(currentAttemptOf(line, INTENT_VULKAN)?.buildId.sequence).toBe(2);
        expect(currentAttemptOf(line, INTENT_DX12)?.buildId.sequence).toBe(1);
        const first = line.attempts.find((record) => record.buildId.sequence === 1);
        const second = line.attempts.find((record) => record.buildId.sequence === 2);
        if (first === undefined || second === undefined) {
            throw new Error("test setup: both attempts must be on the line");
        }
        expect(attemptStateOf(line, first, INTENT_VULKAN)).toBe("stale");
        expect(attemptStateOf(line, second, INTENT_VULKAN)).toBe("current");
    });

    it("keeps last-good across any number of newer failures — a failed build never erases it", () => {
        let line = recordToLine(emptyLine(), succeeded(1, INTENT_DX12));
        line = recordToLine(line, failed(2, INTENT_DX12));
        line = recordToLine(line, failed(3, INTENT_DX12));
        expect(currentAttemptOf(line, INTENT_DX12)?.buildId.sequence).toBe(1);
        expect(lastGoodAttemptOf(line)?.buildId.sequence).toBe(1);
        const success = line.attempts.find((record) => record.buildId.sequence === 1);
        const failure = line.attempts.find((record) => record.buildId.sequence === 2);
        if (success === undefined || failure === undefined) {
            throw new Error("test setup: the attempts must be on the line");
        }
        expect(attemptStateOf(line, success, INTENT_DX12)).toBe("current");
        expect(attemptStateOf(line, failure, INTENT_DX12)).toBe("failed");
    });

    it("keeps last-good under an OLD intent when the current intent has only failed", () => {
        let line = recordToLine(emptyLine(), succeeded(1, INTENT_DX12));
        line = recordToLine(line, failed(2, INTENT_VULKAN));
        line = recordToLine(line, failed(3, INTENT_VULKAN));
        expect(currentAttemptOf(line, INTENT_VULKAN)).toBeUndefined();
        const lastGood = lastGoodAttemptOf(line);
        expect(lastGood?.buildId.sequence).toBe(1);
        const success = line.attempts.find((record) => record.buildId.sequence === 1);
        if (success === undefined) {
            throw new Error("test setup: the success must be on the line");
        }
        expect(attemptStateOf(line, success, INTENT_VULKAN)).toBe("last-good");
    });

    it("a slow old success that lands late cannot become current — it arrives as stale evidence", () => {
        // Attempt 1 was issued for the old intent, attempt 2 for the new;
        // attempt 2 settles first, then the slow attempt 1 lands.
        let line: BuildLine = emptyLine();
        line = recordToLine(line, succeeded(2, INTENT_VULKAN));
        line = recordToLine(line, succeeded(1, INTENT_DX12));
        expect(currentAttemptOf(line, INTENT_VULKAN)?.buildId.sequence).toBe(2);
        const late = line.attempts.find((record) => record.buildId.sequence === 1);
        if (late === undefined) {
            throw new Error("test setup: the late attempt must be on the line");
        }
        expect(attemptStateOf(line, late, INTENT_VULKAN)).toBe("stale");
        expect(attemptStateOf(line, late, INTENT_VULKAN)).not.toBe("current");
    });

    it("a late success of the CURRENT intent after a newer failure is still current (newest SUCCESS within the intent)", () => {
        let line: BuildLine = emptyLine();
        line = recordToLine(line, succeeded(1, INTENT_DX12));
        line = recordToLine(line, failedWith(2, INTENT_DX12, { kind: "timed-out" }));
        expect(currentAttemptOf(line, INTENT_DX12)?.buildId.sequence).toBe(1);
        const success = line.attempts.find((record) => record.buildId.sequence === 1);
        if (success === undefined) {
            throw new Error("test setup: the success must be on the line");
        }
        expect(attemptStateOf(line, success, INTENT_DX12)).toBe("current");
    });

    it("records a changed producer identity as a DIFFERENT intent; its slow result stays stale", () => {
        // A different DXC under the same tool version: different intent.
        const producerA = buildIntentOf(request(), facts("dxc 1.7.1"));
        const producerB = buildIntentOf(request(), facts("dxc 1.7.9"));
        expect(producerA.sourceIdentity === producerB.sourceIdentity).toBe(true);

        let line: BuildLine = emptyLine();
        line = recordToLine(line, succeeded(2, producerB));
        line = recordToLine(line, succeeded(1, producerA));
        expect(currentAttemptOf(line, producerB)?.buildId.sequence).toBe(2);
        const late = line.attempts.find((record) => record.buildId.sequence === 1);
        if (late === undefined) {
            throw new Error("test setup: the late attempt must be on the line");
        }
        expect(attemptStateOf(line, late, producerB)).toBe("stale");
    });

    it("is cancellation an explicit terminal state, the prior states untouched", () => {
        let line = recordToLine(emptyLine(), succeeded(1, INTENT_DX12));
        line = recordToLine(line, canceled(2, INTENT_DX12));
        const cancellation = line.attempts.find((record) => record.buildId.sequence === 2);
        const previous = line.attempts.find((record) => record.buildId.sequence === 1);
        if (cancellation === undefined || previous === undefined) {
            throw new Error("test setup: both attempts must be on the line");
        }
        expect(attemptStateOf(line, cancellation, INTENT_DX12)).toBe("canceled");
        expect(attemptStateOf(line, previous, INTENT_DX12)).toBe("current");
        expect(lastGoodAttemptOf(line)?.buildId.sequence).toBe(1);
    });

    it("orders attempts within one intent by BuildId, never by arrival position", () => {
        // seq 2 arrives first (settled early), seq 3 later: the newest
        // SUCCESS is still by sequence.
        let line: BuildLine = emptyLine();
        line = recordToLine(line, succeeded(2, INTENT_DX12));
        line = recordToLine(line, succeeded(3, INTENT_DX12));
        expect(currentAttemptOf(line, INTENT_DX12)?.buildId.sequence).toBe(3);
        const older = line.attempts.find((record) => record.buildId.sequence === 2);
        if (older === undefined) {
            throw new Error("test setup: the older attempt must be on the line");
        }
        expect(attemptStateOf(line, older, INTENT_DX12)).toBe("stale");
    });

    it("refuses a duplicate BuildId — one BuildId is one attempt", () => {
        const line = recordToLine(emptyLine(), succeeded(1, INTENT_DX12));
        expect(() => recordToLine(line, succeeded(1, INTENT_DX12))).toThrow(/already names an attempt/u);
    });

    it("reports in-flight attempts as 'in flight', not current, for the inspector", () => {
        const line = recordToLine(emptyLine(), succeeded(1, INTENT_DX12));
        const report = reportBuildLine(line, INTENT_DX12, [{ sequence: 3 }, { sequence: 2 }]);
        expect(report.current?.buildId.sequence).toBe(1);
        expect(report.inFlight).toEqual([{ sequence: 2 }, { sequence: 3 }]);
        expect(report.states).toHaveLength(1);
        const state = report.states[0];
        if (state === undefined) {
            throw new Error("test setup: the settled attempt must be reported");
        }
        expect(state).toEqual({
            buildId: { sequence: 1 },
            state: "current",
            intent: expect.objectContaining({ target: "gglab-dx12" }),
        });
    });

    it("lists settled attempts newest-first, each with its intent and state visible", () => {
        let line: BuildLine = emptyLine();
        line = recordToLine(line, succeeded(1, INTENT_DX12));
        line = recordToLine(line, failed(2, INTENT_VULKAN));
        line = recordToLine(line, canceled(3, INTENT_VULKAN));
        const report = reportBuildLine(line, INTENT_VULKAN);
        expect(report.states.map((entry) => entry.buildId.sequence)).toEqual([3, 2, 1]);
        expect(report.states.map((entry) => entry.state)).toEqual(["canceled", "failed", "last-good"]);
    });
});

describe("the compile settlement → attempt outcome mapping (client-owned)", () => {
    const CANDIDATE: ToolCandidate = {
        rule: "sibling-build",
        toolPath: "C:/gglab/build/output/x64/Debug/gglab-shaderc.exe",
        observationIdentity: "file-identity:sha256:9c",
        resolvedAt: 1_700_000_000_000,
    };

    it("is total over every settlement the boundary can report", () => {
        // A refuted candidate keeps the host's own observation facts —
        // the Inspector never falls back to a bare word.
        expect(
            attemptOutcomeOfCompileResult({ kind: "candidate-invalidated", candidate: CANDIDATE, observation: "changed", observedIdentity: "file-identity:bb" }),
        ).toEqual({
            kind: "failed",
            termination: { kind: "candidate-invalidated", observation: "changed", observedIdentity: "file-identity:bb" },
        });
        expect(
            attemptOutcomeOfCompileResult({ kind: "candidate-invalidated", candidate: CANDIDATE, observation: "missing", observedIdentity: null }),
        ).toEqual({
            kind: "failed",
            termination: { kind: "candidate-invalidated", observation: "missing", observedIdentity: null },
        });
        expect(attemptOutcomeOfCompileResult({ kind: "launch-failed", candidate: CANDIDATE })).toEqual({
            kind: "failed",
            termination: { kind: "launch-failed" },
        });
    });

    it("walks the spawned settlements through the process-level reading", () => {
        const result = attemptOutcomeOfCompileResult({
            kind: "spawned",
            output: {
                stdout: utf8Encode(COMPILE_SUCCESS),
                stderr: new Uint8Array(0),
                exitCode: 0,
                timedOut: false,
                canceled: false,
            },
        });
        if (result.kind !== "succeeded") {
            throw new Error("test setup: the success golden must map to a successful attempt");
        }
        expect(result.envelope.success).toBe(true);

        expect(
            attemptOutcomeOfCompileResult({
                kind: "spawned",
                output: { stdout: new Uint8Array(0), stderr: new Uint8Array(0), exitCode: -1, timedOut: false, canceled: true },
            }),
        ).toEqual({ kind: "canceled" });

        expect(
            attemptOutcomeOfCompileResult({
                kind: "spawned",
                output: { stdout: new Uint8Array(0), stderr: new Uint8Array(0), exitCode: -1, timedOut: true, canceled: false },
            }),
        ).toEqual({ kind: "failed", termination: { kind: "timed-out" } });

        const polluted = "dxc: something on the side channel";
        expect(
            attemptOutcomeOfCompileResult({
                kind: "spawned",
                output: { stdout: utf8Encode(COMPILE_SUCCESS), stderr: utf8Encode(polluted), exitCode: 0, timedOut: false, canceled: false },
            }),
        ).toEqual({
            kind: "failed",
            termination: {
                kind: "channel-violated",
                violation: { reason: "stderr-non-empty", byteLength: utf8Encode(polluted).byteLength },
            },
        });

        const garbage: AttemptOutcome = attemptOutcomeOfCompileResult({
            kind: "spawned",
            output: { stdout: utf8Encode("{ nope"), stderr: new Uint8Array(0), exitCode: 0, timedOut: false, canceled: false },
        });
        if (garbage.kind !== "failed" || "envelope" in garbage) {
            throw new Error("test setup: the garbage must map to a termination, not an envelope");
        }
        if (garbage.termination.kind !== "machine-document-rejected") {
            throw new Error("test setup: the garbage must map to machine-document-rejected");
        }
        expect(garbage.termination.rejection.reason).toBe("not-json");
    });

    it("names a readable-but-malformed response correctly — the reader rejected it, no document-ABSENCE is claimed", () => {
        // Valid JSON that misses the required fields: machine-looking,
        // yet rejected. That is a MACHINE-DOCUMENT-REJECTED, not a
        // no-machine-document, and the rejection is carried verbatim.
        const missingFields: AttemptOutcome = attemptOutcomeOfCompileResult({
            kind: "spawned",
            output: {
                stdout: utf8Encode('{"command":"compile","success":true}'),
                stderr: new Uint8Array(0),
                exitCode: 0,
                timedOut: false,
                canceled: false,
            },
        });
        if (missingFields.kind !== "failed" || "envelope" in missingFields) {
            throw new Error("test setup: the malformed response must map to a termination");
        }
        if (missingFields.termination.kind !== "machine-document-rejected") {
            throw new Error("test setup: the malformed response must map to machine-document-rejected");
        }
        expect(missingFields.termination.rejection.reason).not.toBe("not-json");
    });

    it("keeps the tool's own envelopes when a document was read", () => {
        const failureOutcome = readCompileDocument(COMPILE_FAILURE_EXAMPLE);
        if (failureOutcome.status !== "read" || failureOutcome.document.success !== false) {
            throw new Error("test setup: the failure golden must read as a failure document");
        }
        const failureDoc = failureOutcome.document;
        const failure = attemptOutcomeOfCompileResult({
            kind: "spawned",
            output: {
                stdout: utf8Encode(COMPILE_FAILURE_EXAMPLE),
                stderr: new Uint8Array(0),
                exitCode: failureDoc.exitCode,
                timedOut: false,
                canceled: false,
            },
        });
        expect(failure).toEqual({ kind: "failed", envelope: failureDoc });

        const successOutcome = readCompileDocument(COMPILE_SUCCESS);
        if (successOutcome.status !== "read" || successOutcome.document.success !== true) {
            throw new Error("test setup: the success golden must read as a success document");
        }
        const successDoc = successOutcome.document;
        const success = attemptOutcomeOfCompileResult({
            kind: "spawned",
            output: {
                stdout: utf8Encode(COMPILE_SUCCESS),
                stderr: new Uint8Array(0),
                exitCode: successDoc.exitCode,
                timedOut: false,
                canceled: false,
            },
        });
        expect(success).toEqual({ kind: "succeeded", envelope: successDoc });
    });
});
