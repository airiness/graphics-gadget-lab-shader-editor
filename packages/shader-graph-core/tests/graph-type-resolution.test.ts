import { describe, expect, it } from "vitest";
import { DiagnosticCode } from "../src/index.js";
import type { ResolvedGraphTypes } from "../src/index.js";
import { parseShaderGraphDocument, resolveGraphTypes } from "../src/index.js";

function resolvedDocument(document: Record<string, unknown>): ResolvedGraphTypes {
    const parsed = parseShaderGraphDocument(JSON.stringify(document));
    if (!parsed.ok || parsed.value === null) {
        throw new Error(`test document did not parse: ${JSON.stringify(parsed.diagnostics)}`);
    }
    return resolveGraphTypes(parsed.value);
}

describe("resolveGraphTypes", () => {
    it("resolves source chains: authored parameters, constants, and widening", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.chain",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [
                { id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float3" },
                { id: "p.metal", name: "M", class: "ScalarParameter", valueType: "float" },
            ],
            nodes: [
                { id: "n.t", type: "VectorParameter", version: 1, properties: { parameterId: "p.tint" } },
                { id: "n.sf", type: "ScalarParameter", version: 1, properties: { parameterId: "p.metal" } },
                { id: "n.f", type: "Float", version: 1, properties: { value: 0.5 } },
                { id: "n.m", type: "Multiply", version: 1, properties: {} },
                { id: "n.s", type: "Saturate", version: 1, properties: {} },
                { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.m", portId: "a" } },
                { id: "c2", from: { nodeId: "n.f", portId: "value" }, to: { nodeId: "n.m", portId: "b" } },
                { id: "c3", from: { nodeId: "n.m", portId: "value" }, to: { nodeId: "n.s", portId: "value" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const resolved = resolvedDocument(document);
        expect(resolved.ok).toBe(true);
        expect(resolved.diagnostics).toEqual([]);
        expect(resolved.typeAt("n.t", "value")).toBe("float3"); // authored
        expect(resolved.typeAt("n.sf", "value")).toBe("float");
        expect(resolved.typeAt("n.f", "value")).toBe("float");
        expect(resolved.typeAt("n.m", "value")).toBe("float3"); // float3 * float -> float3
        expect(resolved.typeAt("n.s", "value")).toBe("float3"); // value-preserving unary
        expect(resolved.typeAt("n.out", "BaseColor")).toBeUndefined(); // output nodes have no outputs
    });

    it("resolves SampleTexture2D's six channel ports even though v1 defers its emission", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.texture",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [{ id: "p.tex", name: "Texture", class: "Texture2DParameter", valueType: "Texture2D" }],
            nodes: [
                { id: "n.tp", type: "Texture2DParameter", version: 1, properties: { parameterId: "p.tex" } },
                { id: "n.uv", type: "UV0", version: 1, properties: {} },
                { id: "n.smp", type: "SampleTexture2D", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.tp", portId: "value" }, to: { nodeId: "n.smp", portId: "texture" } },
                { id: "c2", from: { nodeId: "n.uv", portId: "value" }, to: { nodeId: "n.smp", portId: "uv" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const resolved = resolvedDocument(document);
        expect(resolved.ok).toBe(true);
        expect(resolved.diagnostics).toEqual([]);
        expect(resolved.typeAt("n.tp", "value")).toBe("Texture2D");
        expect(resolved.typeAt("n.uv", "value")).toBe("float2");
        expect(resolved.typeAt("n.smp", "RGBA")).toBe("float4");
        expect(resolved.typeAt("n.smp", "RGB")).toBe("float3");
        expect(resolved.typeAt("n.smp", "R")).toBe("float");
        expect(resolved.typeAt("n.smp", "G")).toBe("float");
        expect(resolved.typeAt("n.smp", "B")).toBe("float");
        expect(resolved.typeAt("n.smp", "A")).toBe("float");
        // Both channels of one sample can feed different-typed consumers:
        // RGB (float3) and R (float) resolve independently per port.
    });

    it("reports an operation whose operands cannot share one vector size", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.mixed",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: [
                { id: "n.f2", type: "Float2", version: 1, properties: { value: [1, 1] } },
                { id: "n.f3", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
                { id: "n.m", type: "Multiply", version: 1, properties: {} },
                { id: "n.s", type: "Saturate", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.f2", portId: "value" }, to: { nodeId: "n.m", portId: "a" } },
                { id: "c2", from: { nodeId: "n.f3", portId: "value" }, to: { nodeId: "n.m", portId: "b" } },
                { id: "c3", from: { nodeId: "n.m", portId: "value" }, to: { nodeId: "n.s", portId: "value" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const resolved = resolvedDocument(document);
        expect(resolved.ok).toBe(false);
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.TypeMismatch, severity: "error", dataPath: "$.nodes[2]" }),
        ]);
        expect(resolved.typeAt("n.m", "value")).toBeUndefined();
        // Consumers of an untypeable node are unresolved themselves, without
        // re-diagnosing (one failure, one location).
        expect(resolved.typeAt("n.s", "value")).toBeUndefined();
    });

    it("applies the Lerp, Dot, and Normalize result rules", () => {
        const lerp = resolvedDocument({
            schemaVersion: 1,
            graphId: "graph.lerp",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: [
                { id: "n.a", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
                { id: "n.b", type: "Float3", version: 1, properties: { value: [1, 1, 1] } },
                { id: "n.t", type: "Float3", version: 1, properties: { value: [0.5, 0.5, 0.5] } },
                { id: "n.l", type: "Lerp", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.a", portId: "value" }, to: { nodeId: "n.l", portId: "a" } },
                { id: "c2", from: { nodeId: "n.b", portId: "value" }, to: { nodeId: "n.l", portId: "b" } },
                { id: "c3", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.l", portId: "t" } },
            ],
            editorMetadata: { nodes: {} },
        });
        expect(lerp.ok).toBe(false);
        expect(lerp.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.TypeMismatch, severity: "error", dataPath: "$.nodes[3]" }),
        ]);

        const dot = resolvedDocument({
            schemaVersion: 1,
            graphId: "graph.dot",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: [
                { id: "n.a", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
                { id: "n.b", type: "Float3", version: 1, properties: { value: [1, 1, 1] } },
                { id: "n.d", type: "Dot", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.a", portId: "value" }, to: { nodeId: "n.d", portId: "a" } },
                { id: "c2", from: { nodeId: "n.b", portId: "value" }, to: { nodeId: "n.d", portId: "b" } },
            ],
            editorMetadata: { nodes: {} },
        });
        expect(dot.ok).toBe(true);
        expect(dot.typeAt("n.d", "value")).toBe("float");

        const normalize = resolvedDocument({
            schemaVersion: 1,
            graphId: "graph.normalize",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: [
                { id: "n.f", type: "Float", version: 1, properties: { value: 1 } },
                { id: "n.n", type: "Normalize", version: 1, properties: {} },
            ],
            connections: [{ id: "c1", from: { nodeId: "n.f", portId: "value" }, to: { nodeId: "n.n", portId: "value" } }],
            editorMetadata: { nodes: {} },
        });
        expect(normalize.ok).toBe(false);
        expect(normalize.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.TypeMismatch, severity: "error", dataPath: "$.nodes[1]" }),
        ]);
    });

    it("leaves unknown node kinds unresolved without re-diagnosing them", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.ghost",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: [
                { id: "n.ghost", type: "MysteryNode", version: 1, properties: {} },
                { id: "n.f", type: "Float", version: 1, properties: { value: 0.5 } },
                { id: "n.m", type: "Multiply", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.ghost", portId: "value" }, to: { nodeId: "n.m", portId: "a" } },
                { id: "c2", from: { nodeId: "n.f", portId: "value" }, to: { nodeId: "n.m", portId: "b" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const resolved = resolvedDocument(document);
        expect(resolved.typeAt("n.ghost", "value")).toBeUndefined();
        expect(resolved.typeAt("n.m", "value")).toBeUndefined();
        // The consumer is diagnosed once; the unknown kind is not
        // (validation owns that diagnostic).
        expect(resolved.ok).toBe(false);
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.TypeMismatch, severity: "error", dataPath: "$.nodes[2]" }),
        ]);
    });

    it("fails a cyclic document without a partial resolution", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.cycle",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: [
                { id: "n.a", type: "Add", version: 1, properties: {} },
                { id: "n.b", type: "Add", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.a", portId: "value" }, to: { nodeId: "n.b", portId: "a" } },
                { id: "c2", from: { nodeId: "n.b", portId: "value" }, to: { nodeId: "n.a", portId: "a" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const resolved = resolvedDocument(document);
        expect(resolved.ok).toBe(false);
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.CycleDetected, severity: "error", dataPath: "$" }),
        ]);
        expect(resolved.values).toEqual([]);
    });

    it("is deterministic under incidental node and connection order", () => {
        const base: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.perm",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [{ id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float3" }],
            nodes: [
                { id: "n.t", type: "VectorParameter", version: 1, properties: { parameterId: "p.tint" } },
                { id: "n.f", type: "Float", version: 1, properties: { value: 2 } },
                { id: "n.m", type: "Multiply", version: 1, properties: {} },
                { id: "n.s", type: "Saturate", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.m", portId: "a" } },
                { id: "c2", from: { nodeId: "n.f", portId: "value" }, to: { nodeId: "n.m", portId: "b" } },
                { id: "c3", from: { nodeId: "n.m", portId: "value" }, to: { nodeId: "n.s", portId: "value" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const reference = resolvedDocument(base);
        const permutations: Array<Record<string, unknown>> = [
            { ...base, nodes: [...(base["nodes"] as Record<string, unknown>[])].reverse() },
            { ...base, nodes: (base["nodes"] as Record<string, unknown>[]).slice().sort(() => -1), connections: [...(base["connections"] as Record<string, unknown>[])].reverse() },
        ];
        const keyOf = (value: ResolvedGraphTypes["values"][number]): string => `${value.nodeId}\u0000${value.portId}\u0000${value.type}`;
        const signature = (resolved: ResolvedGraphTypes): string => [...resolved.values].map(keyOf).sort().join("|");
        expect(reference.ok).toBe(true);
        for (const permutation of permutations) {
            const permuted = resolvedDocument(permutation);
            expect(permuted.ok).toBe(true);
            expect(permuted.diagnostics).toEqual([]);
            expect(permuted.typeAt("n.s", "value")).toBe("float3");
            expect(signature(permuted)).toBe(signature(reference));
        }
    });
});
