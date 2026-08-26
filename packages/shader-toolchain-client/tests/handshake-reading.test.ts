import { describe, expect, it } from "vitest";
import {
    readHandshakeDocument,
    type HandshakeReadOutcome,
} from "../src/handshake-document.js";
import {
    COMPILE_SUCCESS,
    DESCRIBE_SUCCESS,
    DESCRIBE_USAGE_ERROR,
    DESCRIBE_COMPILER_UNAVAILABLE,
    DESCRIBE_INTERNAL_ERROR,
} from "./fixtures/envelope-goldens.js";

function mutateGolden(golden: string, change: (base: Record<string, unknown>) => Record<string, unknown>): string {
    const base = JSON.parse(golden) as Record<string, unknown>;
    return JSON.stringify(change(base));
}

function withoutField(golden: string, field: string): string {
    return mutateGolden(golden, (base) => {
        const copy = { ...base };
        delete copy[field];
        return copy;
    });
}

function withField(golden: string, field: string, value: unknown): string {
    return mutateGolden(golden, (base) => ({ ...base, [field]: value }));
}

function expectRejected(outcome: HandshakeReadOutcome, reason: string, document: string): void {
    expect(outcome.status, document).toBe("rejected");
    if (outcome.status !== "rejected") {
        return;
    }
    expect(outcome.rejection.reason, document).toBe(reason);
    expect(outcome.rejection.detail, document).not.toBe("");
}

describe("the strict handshake reader", () => {
    it("reads the published success document and its five verdict facts", () => {
        const outcome = readHandshakeDocument(DESCRIBE_SUCCESS);
        expect(outcome.status).toBe("read");
        if (outcome.status !== "read") {
            return;
        }
        const document = outcome.document;
        expect(document.command).toBe("describe");
        expect(document.success).toBe(true);
        if (document.success !== true) {
            throw new Error("the success golden must read as the success document");
        }
        expect(document.status).toBe("ok");
        expect(document.exitCode).toBe(0);
        expect(document.processContractVersion).toBe(1);
        expect(document.toolIdentity).toBe("gglab-shaderc");
        expect(document.toolVersion).toBe("1.1.0");
        expect(document.producerKind).toBe("dxc");
        expect(document.producerIdentity).toBe("Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)");
        expect(document.diagnostics).toEqual([]);
    });

    it("holds the adjudicated target wire names exactly", () => {
        const outcome = readHandshakeDocument(DESCRIBE_SUCCESS);
        if (outcome.status !== "read") {
            throw new Error("the success golden must read");
        }
        const document = outcome.document;
        if (document.success !== true) {
            throw new Error("the success golden must read as the success document");
        }
        expect(document.supportedTargets).toEqual(["gglab-dx12", "gglab-vulkan13"]);
    });

    it("reads every published failure state as a structured payload only", () => {
        const cases: ReadonlyArray<{ text: string; status: string; exitCode: number; message: string }> = [
            { text: DESCRIBE_USAGE_ERROR, status: "usage-error", exitCode: 2, message: "describe accepts no arguments" },
            { text: DESCRIBE_COMPILER_UNAVAILABLE, status: "compiler-unavailable", exitCode: 4, message: "DXC producer runtime could not be resolved" },
            { text: DESCRIBE_INTERNAL_ERROR, status: "internal-error", exitCode: 7, message: "describe internal failure" },
        ];
        for (const item of cases) {
            const outcome = readHandshakeDocument(item.text);
            expect(outcome.status, item.text).toBe("read");
            if (outcome.status !== "read") {
                continue;
            }
            expect(outcome.document.success).toBe(false);
            expect(outcome.document.status).toBe(item.status);
            expect(outcome.document.exitCode).toBe(item.exitCode);
            expect(outcome.document.processContractVersion).toBe(1);
            // The failure payload carries no business facts — the shape
            // itself excludes them.
            expect(outcome.document).not.toHaveProperty("toolIdentity");
            expect(outcome.document).not.toHaveProperty("supportedTargets");
            expect(outcome.document.diagnostics).toEqual([{ message: item.message }]);
        }
    });

    it("rejects out-of-channel documents before any field is trusted", () => {
        expectRejected(readHandshakeDocument(""), "not-json", "<empty>");
        expectRejected(readHandshakeDocument("{ not json"), "not-json", "{ not json");
        expectRejected(readHandshakeDocument("[]"), "not-an-object", "[]");
        expectRejected(
            readHandshakeDocument('{"a":1}\n{"b":2}'),
            "not-a-single-line-json-document",
            'two lines',
        );
        expectRejected(readHandshakeDocument(COMPILE_SUCCESS), "command-not-describe", COMPILE_SUCCESS);
    });

    it("rejects a missing required field explicitly, on either document kind", () => {
        expectRejected(readHandshakeDocument(withoutField(DESCRIBE_SUCCESS, "toolVersion")), "missing-field", "success without toolVersion");
        expectRejected(readHandshakeDocument(withoutField(DESCRIBE_SUCCESS, "processContractVersion")), "missing-field", "success without the contract axis");
        expectRejected(readHandshakeDocument(withoutField(DESCRIBE_USAGE_ERROR, "processContractVersion")), "missing-field", "failure without the contract axis");
        expectRejected(readHandshakeDocument(withoutField(DESCRIBE_USAGE_ERROR, "diagnostics")), "missing-field", "failure without diagnostics");
    });

    it("rejects an unknown field rather than silently ignoring it", () => {
        expectRejected(readHandshakeDocument(withField(DESCRIBE_SUCCESS, "experimental", true)), "unexpected-field", "extra field");
        expectRejected(readHandshakeDocument(withField(DESCRIBE_USAGE_ERROR, "extra", 1)), "unexpected-field", "extra field on failure");
    });

    it("rejects a status outside the published vocabulary", () => {
        expectRejected(readHandshakeDocument(withField(DESCRIBE_SUCCESS, "status", "succeeded")), "status-outside-vocabulary", "success status \"succeeded\"");
        expectRejected(readHandshakeDocument(withField(DESCRIBE_USAGE_ERROR, "status", "mystery")), "status-outside-vocabulary", "failure status \"mystery\"");
        expectRejected(readHandshakeDocument(withField(DESCRIBE_USAGE_ERROR, "status", "compile-failed")), "status-outside-vocabulary", "compile status on a handshake");
    });

    it("rejects business fields on a failure payload — absent, not ignored", () => {
        expectRejected(readHandshakeDocument(withField(DESCRIBE_USAGE_ERROR, "toolIdentity", "gglab-shaderc")), "unexpected-field", "failure carrying toolIdentity");
        expectRejected(readHandshakeDocument(withField(DESCRIBE_USAGE_ERROR, "supportedTargets", ["gglab-dx12"])), "unexpected-field", "failure carrying supportedTargets");
    });

    it("rejects mistyped fields", () => {
        expectRejected(readHandshakeDocument(withField(DESCRIBE_SUCCESS, "supportedTargets", ["gglab-dx12", 13])), "field-type-mismatch", "non-string target");
        expectRejected(readHandshakeDocument(withField(DESCRIBE_SUCCESS, "exitCode", "zero")), "field-type-mismatch", "string exitCode");
        expectRejected(readHandshakeDocument(withField(DESCRIBE_SUCCESS, "success", "yes")), "field-type-mismatch", "string success");
        expectRejected(readHandshakeDocument(withField(DESCRIBE_SUCCESS, "processContractVersion", "1")), "field-type-mismatch", "string contract axis");
    });

    it("rejects malformed diagnostics", () => {
        expectRejected(readHandshakeDocument(withField(DESCRIBE_USAGE_ERROR, "diagnostics", [])), "diagnostics-malformed", "empty failure diagnostics");
        expectRejected(
            readHandshakeDocument(withField(DESCRIBE_USAGE_ERROR, "diagnostics", [{}])),
            "diagnostics-malformed",
            "diagnostic without a message",
        );
        expectRejected(
            readHandshakeDocument(withField(DESCRIBE_USAGE_ERROR, "diagnostics", [{ message: "x", note: "prose" }])),
            "diagnostics-malformed",
            "diagnostic with an unknown field",
        );
        expectRejected(
            readHandshakeDocument(withField(DESCRIBE_USAGE_ERROR, "diagnostics", [{ message: "x", sourceIdentity: 7 }])),
            "diagnostics-malformed",
            "non-string sourceIdentity",
        );
        expectRejected(readHandshakeDocument(withField(DESCRIBE_SUCCESS, "diagnostics", "a message")), "diagnostics-malformed", "diagnostics as a string");
    });

    it("keeps the diagnostic source-identity fact when the tool reports one", () => {
        const text = withField(DESCRIBE_USAGE_ERROR, "diagnostics", [
            { message: "described the wrong source", sourceIdentity: "Shaders/Surface/1/emitted/surface.hlsl" },
        ]);
        const outcome = readHandshakeDocument(text);
        expect(outcome.status, text).toBe("read");
        if (outcome.status === "read") {
            expect(outcome.document.diagnostics).toEqual([
                {
                    message: "described the wrong source",
                    sourceIdentity: "Shaders/Surface/1/emitted/surface.hlsl",
                },
            ]);
        }
    });
});
