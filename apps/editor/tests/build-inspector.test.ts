/**
 * The Build Inspector's build-side projection, narrowed to the
 * SELECTION-ORIENTED facts: the composed request identity the session
 * anchors its `current`-ness against (the anchor's BuildIntent, verbatim)
 * and the generated-source identity the emission committed. The attempt
 * CHRONOLOGY (the line's states, the outcomes, the diagnostics) is
 * projected by the bottom panel's Build view over the owner's session —
 * pinned here as an ABSENCE from the inspector's rows.
 */
import { describe, expect, it } from "vitest";
import { projectBuildFacts, type BuildInspectorRow } from "../src/build-inspector.js";
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

function flowWithoutAnchor(): NativeBuildFlow {
    return {
        buildSession: {
            lastIssued: null,
        },
    } as unknown as NativeBuildFlow;
}

function values(rows: readonly { readonly field: string; readonly value: string }[]): Map<string, string> {
    return new Map(rows.map((r) => [r.field, r.value]));
}

describe("the inspector's build side — the selection-oriented facts only", () => {
    it("renders the anchor's composed request verbatim, and the generated-source identity when the emission committed one", () => {
        const rows = projectBuildFacts(flowWithAnchor(), { sourceIdentity: "cd".repeat(32) });
        const table = values(rows);
        expect(table.get("build intent — source identity")).toBe("ab".repeat(32));
        expect(table.get("build intent — target / stage / entry")).toBe("gglab-dx12 / pixel / GenerateSurface");
        expect(table.get("build intent — tool identity / version")).toBe("gglab-shaderc / 1.2.0");
        expect(table.get("build intent — contract / policy axes")).toBe("2 / 1");
        expect(table.get("build intent — producer identity")).toBe("Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)");
        expect(table.get("generated-source identity")).toBe("cd".repeat(32));
        for (const entry of rows) {
            expect(entry.source).not.toBe("");
        }
    });

    it("says exactly that when no attempt was ever issued — never invents one", () => {
        const table = values(projectBuildFacts(flowWithoutAnchor(), null));
        expect(table.get("build intent")).toBe("(no issued attempt)");
        expect(table.has("generated-source identity")).toBe(false);
    });

    it("the inspector's build-side rows carry NO attempt chronology (states, outcomes, diagnostics live in the build view)", () => {
        const rows: readonly BuildInspectorRow[] = projectBuildFacts(flowWithAnchor(), { sourceIdentity: "cd".repeat(32) });
        for (const entry of rows) {
            expect(entry.field).not.toMatch(/attempt|outcome|diagnostic|state/i);
        }
    });
});
