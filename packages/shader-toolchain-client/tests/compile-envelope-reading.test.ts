import { describe, expect, it } from "vitest";
import {
    readCompileDocument,
    type CompileReadOutcome,
} from "../src/result-envelope.js";
import {
    COMPILE_FAILURE_EXAMPLE,
    COMPILE_FAILURE_VOCABULARY,
    COMPILE_SUCCESS,
    COMPILE_SUCCESS_PUBLISHED,
    DESCRIBE_SUCCESS,
    compileFailureDocument,
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

function expectRejected(outcome: CompileReadOutcome, reason: string, document: string): void {
    expect(outcome.status, document).toBe("rejected");
    if (outcome.status !== "rejected") {
        return;
    }
    expect(outcome.rejection.reason, document).toBe(reason);
    expect(outcome.rejection.detail, document).not.toBe("");
}

describe("the strict compile result envelope reader", () => {
    it("reads the published success envelope with its build and artifact evidence", () => {
        const outcome = readCompileDocument(COMPILE_SUCCESS);
        expect(outcome.status).toBe("read");
        if (outcome.status !== "read") {
            return;
        }
        const document = outcome.document;
        expect(document.command).toBe("compile");
        expect(document.success).toBe(true);
        if (document.success !== true) {
            throw new Error("the success golden must read as the success document");
        }
        expect(document.status).toBe("ok");
        expect(document.exitCode).toBe(0);
        expect(document.recipeId).toMatch(/^[0-9a-f]{64}$/);
        expect(document.buildKey).toMatch(/^[0-9a-f]{64}$/);
        expect(document.binaryHash).toMatch(/^[0-9a-f]{64}$/);
        expect(document.binaryFormat).toBe("dxil");
        expect(document.target).toBe("gglab-dx12");
        expect(document.binaryPath).toBe(`C:/gglab/build/cache/${"9c".repeat(32)}.dxil`);
        expect(document.cacheRecordPath).toBe(`C:/gglab/build/cache/${"9c".repeat(32)}.dxil.json`);
        expect(document.fromCache).toBe(false);
        expect(document.diagnostics).toEqual([]);
        expect(document.publication).toBeUndefined();
    });

    it("reads the publication group exactly together, as one value", () => {
        const outcome = readCompileDocument(COMPILE_SUCCESS_PUBLISHED);
        expect(outcome.status).toBe("read");
        if (outcome.status !== "read") {
            return;
        }
        const document = outcome.document;
        if (document.success !== true) {
            throw new Error("the publication golden must read as the success document");
        }
        expect(document.fromCache).toBe(true);
        expect(document.binaryFormat).toBe("spirv");
        expect(document.target).toBe("gglab-vulkan13");
        const artifactId = "d1".repeat(32);
        expect(document.publication).toEqual({
            artifactId,
            runtimeArtifactBinaryPath: `C:/gglart/artifacts/${artifactId}.spv`,
            runtimeArtifactManifestPath: `C:/gglart/artifacts/${artifactId}.json`,
        });
    });

    it("reads every published failure status in the vocabulary", () => {
        for (const item of COMPILE_FAILURE_VOCABULARY) {
            const text = compileFailureDocument(item.status, item.exitCode, `the ${item.status} condition`);
            const outcome = readCompileDocument(text);
            expect(outcome.status, text).toBe("read");
            if (outcome.status !== "read") {
                continue;
            }
            expect(outcome.document.success).toBe(false);
            expect(outcome.document.status).toBe(item.status);
            expect(outcome.document.exitCode).toBe(item.exitCode);
            expect(outcome.document.diagnostics).toEqual([{ message: `the ${item.status} condition` }]);
        }
    });

    it("carries the tool's own source-identity fact on a diagnostic verbatim", () => {
        const outcome = readCompileDocument(COMPILE_FAILURE_EXAMPLE);
        expect(outcome.status).toBe("read");
        if (outcome.status !== "read") {
            return;
        }
        expect(outcome.document.diagnostics).toEqual([
            {
                message: "HLSL compilation failed",
                sourceIdentity: "Shaders/Surface/1/emitted/surface-pixel.hlsl",
            },
        ]);
    });

    it("rejects channel and shape violations before any field is trusted", () => {
        expectRejected(readCompileDocument(""), "not-json", "<empty>");
        expectRejected(readCompileDocument("{ no"), "not-json", "{ no");
        expectRejected(readCompileDocument("{}\n{}"), "not-a-single-line-json-document", "two lines");
        expectRejected(readCompileDocument("123"), "not-an-object", "123");
        expectRejected(readCompileDocument(DESCRIBE_SUCCESS), "command-not-compile", DESCRIBE_SUCCESS);
    });

    it("rejects a missing required field explicitly", () => {
        expectRejected(readCompileDocument(withoutField(COMPILE_SUCCESS, "binaryHash")), "missing-field", "success without binaryHash");
        expectRejected(readCompileDocument(withoutField(COMPILE_SUCCESS, "recipeId")), "missing-field", "success without recipeId");
        expectRejected(readCompileDocument(withoutField(compileFailureDocument("compile-failed", 4, "x"), "diagnostics")), "missing-field", "failure without diagnostics");
    });

    it("rejects an unknown field rather than silently ignoring it", () => {
        expectRejected(readCompileDocument(withField(COMPILE_SUCCESS, "experiment", 1)), "unexpected-field", "extra field on success");
    });

    it("rejects mistyped evidence fields", () => {
        expectRejected(readCompileDocument(withField(COMPILE_SUCCESS, "binaryFormat", "glsl")), "field-type-mismatch", "unknown binaryFormat");
        expectRejected(readCompileDocument(withField(COMPILE_SUCCESS, "recipeId", "zz")), "field-type-mismatch", "non-digest recipeId");
        expectRejected(readCompileDocument(withField(COMPILE_SUCCESS, "fromCache", "hit")), "field-type-mismatch", "string fromCache");
        expectRejected(readCompileDocument(withField(COMPILE_SUCCESS, "exitCode", "0")), "field-type-mismatch", "string exitCode");
        expectRejected(readCompileDocument(withField(COMPILE_SUCCESS, "status", "succeeded")), "status-outside-vocabulary", "success status \"succeeded\"");
        expectRejected(readCompileDocument(withField(COMPILE_SUCCESS, "status", "compile-failed")), "status-outside-vocabulary", "failure status on a success");
    });

    it("rejects an incomplete publication group — the group is atomic", () => {
        const partial = mutateGolden(COMPILE_SUCCESS, (base) => ({
            ...base,
            artifactId: "d1".repeat(32),
        }));
        expectRejected(readCompileDocument(partial), "publication-group-incomplete", partial);
    });

    it("rejects a publication group with a mistyped member", () => {
        const mistyped = mutateGolden(COMPILE_SUCCESS_PUBLISHED, (base) => ({
            ...base,
            artifactId: "not-a-digest",
        }));
        expectRejected(readCompileDocument(mistyped), "field-type-mismatch", mistyped);
    });

    it("rejects failure envelopes that carry result fields or without diagnostics", () => {
        const withEvidence = withField(compileFailureDocument("compile-failed", 4, "x"), "binaryHash", "9c".repeat(32));
        expectRejected(readCompileDocument(withEvidence), "unexpected-field", withEvidence);
        expectRejected(
            readCompileDocument(withField(compileFailureDocument("compile-failed", 4, "x"), "diagnostics", [])),
            "diagnostics-malformed",
            "empty failure diagnostics",
        );
        expectRejected(
            readCompileDocument(withField(compileFailureDocument("source-changed", 6, "x"), "status", "ok")),
            "status-outside-vocabulary",
            "status ok on a failure",
        );
    });
});
