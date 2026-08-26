import { describe, expect, it } from "vitest";
import type { BoundaryOutput } from "../src/host-boundary.js";
import { readCompileOutput, readHandshakeOutput } from "../src/process-output.js";
import { utf8Decode, utf8Encode } from "../src/utf8.js";
import { COMPILE_SUCCESS, DESCRIBE_SUCCESS, DESCRIBE_USAGE_ERROR } from "./fixtures/envelope-goldens.js";

function output(change: Partial<BoundaryOutput> = {}): BoundaryOutput {
    return {
        stdout: utf8Encode(DESCRIBE_SUCCESS),
        stderr: new Uint8Array(0),
        exitCode: 0,
        timedOut: false,
        canceled: false,
        ...change,
    };
}

function mutatedDescribe(change: (base: Record<string, unknown>) => Record<string, unknown>): string {
    return JSON.stringify(change(JSON.parse(DESCRIBE_SUCCESS) as Record<string, unknown>));
}

describe("the process-level channel readers", () => {
    it("canceled is a terminal state: nothing is interpreted — not even a channel fact", () => {
        // A polluted stderr and garbage stdout must not even be LOOKED
        // at once the attempt is canceled.
        const outcome = readHandshakeOutput(
            output({
                canceled: true,
                stderr: utf8Encode("whatever was on the side channel"),
                stdout: new Uint8Array([0xff, 0x00, 0x01]),
            }),
        );
        expect(outcome).toEqual({ kind: "canceled" });
    });

    it("timed-out is a terminal state: the document surface is untrusted", () => {
        const outcome = readHandshakeOutput(output({ timedOut: true, exitCode: -1 }));
        expect(outcome).toEqual({ kind: "timed-out" });
    });

    it("a non-empty stderr is a channel violation, with the observed length structured", () => {
        const pollution = "dxc: something on the side channel";
        const outcome = readHandshakeOutput(
            output({ stderr: utf8Encode(pollution), exitCode: 42 }),
        );
        expect(outcome).toEqual({
            kind: "channel-violated",
            violation: { reason: "stderr-non-empty", byteLength: utf8Encode(pollution).byteLength },
        });
    });

    it("a stdout that does not decode as UTF-8 is a channel violation", () => {
        // Cut the continuation byte of a multi-byte sequence: the output
        // now trails an unfinished lead byte. (The accent is a \u escape:
        // the fixtures stay ASCII source while exercising two-byte UTF-8.)
        const truncated = utf8Encode("h\u00e9").slice(0, utf8Encode("h\u00e9").byteLength - 1);
        const outcome = readHandshakeOutput(output({ stdout: truncated }));
        expect(outcome.kind).toBe("channel-violated");
        if (outcome.kind === "channel-violated") {
            expect(outcome.violation).toMatchObject({ reason: "stdout-not-valid-utf8" });
        }
    });

    it("a clean channel with an intact document reaches the document reading", () => {
        const outcome = readHandshakeOutput(output());
        expect(outcome.kind).toBe("read");
        if (outcome.kind === "read") {
            expect(outcome.document.success).toBe(true);
            if (outcome.document.success === true) {
                expect(outcome.document.toolIdentity).toBe("gglab-shaderc");
            }
        }
    });

    it("judges the failure document on the same pipeline", () => {
        const outcome = readHandshakeOutput(output({ stdout: utf8Encode(DESCRIBE_USAGE_ERROR), exitCode: 2 }));
        expect(outcome.kind).toBe("read");
        if (outcome.kind === "read") {
            expect(outcome.document.success).toBe(false);
            if (outcome.document.success === false) {
                expect(outcome.document.status).toBe("usage-error");
            }
        }
    });

    it("an exit-code mismatch between the intact document and the observed process is a channel violation", () => {
        const outcome = readHandshakeOutput(output({ exitCode: 7 }));
        expect(outcome).toEqual({
            kind: "channel-violated",
            violation: { reason: "exit-code-mismatch", documentExitCode: 0, processExitCode: 7 },
        });
    });

    it("a malformed document is a document-level rejection, not a channel fact", () => {
        const outcome = readHandshakeOutput(output({ stdout: utf8Encode("{ not json") }));
        expect(outcome.kind).toBe("rejected");
        if (outcome.kind === "rejected") {
            expect(outcome.rejection.reason).toBe("not-json");
        }
    });

    it("an unsupported axis is still an axis observation, reached over a clean channel", () => {
        const future = mutatedDescribe((base) => ({ ...base, processContractVersion: 2 }));
        const outcome = readHandshakeOutput(output({ stdout: utf8Encode(future) }));
        expect(outcome.kind).toBe("unsupported-contract");
        if (outcome.kind === "unsupported-contract") {
            expect(outcome.contract).toMatchObject({
                supported: false,
                reason: "observed-version-outside-range",
                observedVersion: 2,
            });
        }
    });

    it("checks the terminal states before the channel, and the channel before the document", () => {
        const both = output({ canceled: true, timedOut: true, stderr: utf8Encode("x"), stdout: utf8Encode("{ nope") });
        expect(readHandshakeOutput(both)).toEqual({ kind: "canceled" });
        expect(readHandshakeOutput(output({ stderr: utf8Encode("x"), stdout: utf8Encode("{ nope") }))).toMatchObject({
            kind: "channel-violated",
        });
    });

    it("runs the same pipeline over the compile result envelope", () => {
        expect(readCompileOutput(output({ stdout: utf8Encode(COMPILE_SUCCESS) })).kind).toBe("read");
        expect(readCompileOutput(output({ stdout: utf8Encode(COMPILE_SUCCESS), exitCode: 9 }))).toEqual({
            kind: "channel-violated",
            violation: { reason: "exit-code-mismatch", documentExitCode: 0, processExitCode: 9 },
        });
        expect(readCompileOutput(output({ timedOut: true })).kind).toBe("timed-out");
        expect(readCompileOutput(output({ canceled: true })).kind).toBe("canceled");
        const compileFailure =
            '{"command":"compile","success":false,"status":"compile-failed","exitCode":4,"diagnostics":[{"message":"an error"}]}';
        const failureOutcome = readCompileOutput(output({ stdout: utf8Encode(compileFailure), exitCode: 4 }));
        expect(failureOutcome.kind).toBe("read");
        if (failureOutcome.kind === "read") {
            expect(failureOutcome.document.success).toBe(false);
        }
    });
});

describe("the strict UTF-8 codec", () => {
    it("round-trips ASCII and multi-byte text exactly", () => {
        const ascii = utf8Decode(utf8Encode("shader surface lighting"));
        if (ascii.ok !== true) {
            throw new Error("test setup: the ASCII round-trip must decode");
        }
        expect(ascii.text).toBe("shader surface lighting");
        const accented = "h\u00e9llo, w\u00f6rld";
        const decoded = utf8Decode(utf8Encode(accented));
        expect(decoded.ok).toBe(true);
        if (decoded.ok !== true) {
            throw new Error("test setup: the encode round-trip must decode");
        }
        expect(decoded.text).toBe(accented);
    });

    it("refuses invalid, overlong, and out-of-range sequences structurally", () => {
        const invalidLead = utf8Decode(new Uint8Array([0xff, 0x61]));
        expect(invalidLead.ok).toBe(false);
        const overlong2 = utf8Decode(new Uint8Array([0xc0, 0xaf]));
        expect(overlong2.ok).toBe(false);
        // The four-byte overlong of U+0000: standard-forbidden even though
        // it decodes to a small code point.
        const overlong4 = utf8Decode(new Uint8Array([0xf0, 0x80, 0x80, 0x80]));
        expect(overlong4.ok).toBe(false);
        const surrogate = utf8Decode(new Uint8Array([0xed, 0xa0, 0x80]));
        expect(surrogate.ok).toBe(false);
        const truncated = utf8Decode(new Uint8Array([0xe2, 0x82]));
        expect(truncated.ok).toBe(false);
        const strayContinuation = utf8Decode(new Uint8Array([0x61, 0x80]));
        expect(strayContinuation.ok).toBe(false);
    });

    it("accepts valid four-byte sequences", () => {
        const decoded = utf8Decode(new Uint8Array([0xf0, 0x9f, 0x98, 0x80]));
        expect(decoded.ok).toBe(true);
        if (decoded.ok !== true) {
            throw new Error("test setup: the valid four-byte sequence must decode");
        }
        expect(decoded.text.codePointAt(0)).toBe(0x1f600);
    });
});
