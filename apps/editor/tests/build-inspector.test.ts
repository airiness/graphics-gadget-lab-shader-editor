/**
 * The Build Inspector projection of the NEWEST ISSUED attempt's outcome
 * (design section 13) — the failed case is the one that must be
 * explainable: the tool's own structured diagnostics are surfaced
 * verbatim (message + location fact when the tool reports one), and a
 * termination that carries structure (the reader's rejection, the
 * channel violation, the host's refutation) surfaces that structure.
 * The session line's record is the single source of truth; the
 * projection computes nothing.
 */
import { describe, expect, it } from "vitest";
import type { AttemptOutcome } from "@gglab/shader-toolchain-client";
import { projectBuildFacts } from "../src/build-inspector.js";
import type { NativeBuildFlow } from "../src/native-build-flow.js";

function flowWithAnchor(): NativeBuildFlow {
    return {
        buildSession: {
            lastIssued: {
                buildId: { sequence: 2 },
                intent: {
                    sourceIdentity: "ab".repeat(32),
                    target: "gglab-dx12",
                    stage: "pixel",
                    entry: "GenerateSurface",
                    defines: [],
                    includes: [],
                    tool: {
                        identity: "gglab-shaderc",
                        version: "1.2.0",
                        processContractVersion: 2,
                        compilePolicyRevision: 1,
                        producerIdentity: "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
                    },
                },
            },
        },
    } as unknown as NativeBuildFlow;
}

function values(rows: readonly { readonly field: string; readonly value: string }[]): Map<string, string> {
    return new Map(rows.map((r) => [r.field, r.value]));
}

describe("the inspector's projection of the newest issued outcome", () => {
    it("a tool failure surfaces EVERY structured diagnostic verbatim, one row each", () => {
        const failed: AttemptOutcome = {
            kind: "failed",
            envelope: {
                command: "compile",
                success: false,
                status: "compile-failed",
                exitCode: 4,
                diagnostics: [
                    { message: "HLSL compilation failed: expected expression", sourceIdentity: "Shaders/Surface/emitted/surface.hlsl" },
                    { message: "one more diagnostic, no location reported" },
                ],
            },
        };
        const rows = projectBuildFacts(flowWithAnchor(), null, null, failed);
        const table = values(rows);
        expect(table.get("newest issued attempt — outcome")).toBe(
            `failed (tool status "compile-failed", 2 diagnostics — the diagnostics follow as their own rows)`,
        );
        expect(table.get("newest issued attempt — diagnostic 1/2")).toBe("HLSL compilation failed: expected expression  [Shaders/Surface/emitted/surface.hlsl]");
        expect(table.get("newest issued attempt — diagnostic 2/2")).toBe("one more diagnostic, no location reported");
    });

    it("a failure with no structured diagnostic says exactly that — never an invented detail", () => {
        const bare: AttemptOutcome = {
            kind: "failed",
            envelope: { command: "compile", success: false, status: "artifact-io-failure", exitCode: 5, diagnostics: [] },
        };
        const table = values(projectBuildFacts(flowWithAnchor(), null, null, bare));
        expect(table.get("newest issued attempt — diagnostic")).toBe("(the tool reported the failure with no structured diagnostic)");
    });

    it("a rejected machine document carries the strict reader's structured refusal", () => {
        const rejected: AttemptOutcome = {
            kind: "failed",
            termination: {
                kind: "machine-document-rejected",
                rejection: { reason: "missing-field", detail: "the document is missing the required field \"binaryHash\"" },
            },
        };
        const table = values(projectBuildFacts(flowWithAnchor(), null, null, rejected));
        expect(table.get("newest issued attempt — outcome")).toBe("failed (termination: machine-document-rejected)");
        expect(table.get("newest issued attempt — rejection")).toBe(`the machine document was rejected (missing-field: the document is missing the required field "binaryHash")`);
    });

    it("a candidate refutation carries the host's own observation facts", () => {
        const invalidated: AttemptOutcome = {
            kind: "failed",
            termination: {
                kind: "candidate-invalidated",
                observation: "changed",
                observedIdentity: "file-identity:sha256:abab",
            },
        };
        const table = values(projectBuildFacts(flowWithAnchor(), null, null, invalidated));
        expect(table.get("newest issued attempt — outcome")).toBe("failed (termination: candidate-invalidated: changed)");
        expect(table.get("newest issued attempt — invalidation")).toBe("the host refuted the candidate's observation at spawn time: changed");
        expect(table.get("newest issued attempt — observed identity")).toBe("file-identity:sha256:abab");
    });

    it("a channel violation names the broken rule with the observed values", () => {
        const violated: AttemptOutcome = {
            kind: "failed",
            termination: {
                kind: "channel-violated",
                violation: { reason: "exit-code-mismatch", documentExitCode: 0, processExitCode: 139 },
            },
        };
        const table = values(projectBuildFacts(flowWithAnchor(), null, null, violated));
        expect(table.get("newest issued attempt — channel")).toBe("channel rule violated: exit-code mismatch (document says 0, process exited 139)");
    });

    it("succeeded and canceled attempts stay complete on the one-line summary — no detail rows", () => {
        const succeeded: AttemptOutcome = {
            kind: "succeeded",
            envelope: {
                command: "compile",
                success: true,
                status: "ok",
                exitCode: 0,
                recipeId: "3f".repeat(32),
                buildKey: "5e".repeat(32),
                binaryHash: "9c".repeat(32),
                binaryFormat: "dxil",
                target: "gglab-dx12",
                binaryPath: "C:/gglab/build/cache/x.dxil",
                cacheRecordPath: "C:/gglab/build/cache/x.dxil.json",
                fromCache: false,
                diagnostics: [],
            },
        };
        function detailFields(rows: readonly { readonly field: string }[]): string[] {
            const markers = [" — diagnostic", " — rejection", " — channel", " — invalidation", " — observed identity"];
            return rows.filter((r) => markers.some((m) => r.field.includes(m))).map((r) => r.field);
        }
        const succeededRows = projectBuildFacts(flowWithAnchor(), null, null, succeeded);
        expect(detailFields(succeededRows)).toEqual([]);
        const canceled: AttemptOutcome = { kind: "canceled" };
        const canceledRows = projectBuildFacts(flowWithAnchor(), null, null, canceled);
        const table = values(canceledRows);
        expect(table.get("newest issued attempt — outcome")).toBe("canceled (explicit, never lost)");
        expect(detailFields(canceledRows)).toEqual([]);
    });
});
