import { describe, expect, it } from "vitest";
import { DiagnosticCode, parseShaderGraphDocument, resolveGraphTopology } from "../src/index.js";
import type { GraphTopology } from "../src/index.js";

function baseSurfaceDocument(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        graphId: "graph.topology",
        profile: "gglab.surface",
        profileVersion: 1,
        parameters: [],
        nodes: [
            { id: "node.baseColor", type: "Float3", version: 1, properties: { value: [0.5, 0.5, 0.5] } },
            { id: "node.emissive", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
            { id: "node.metallic", type: "Float", version: 1, properties: { value: 0 } },
            { id: "node.roughness", type: "Float", version: 1, properties: { value: 0.4 } },
            { id: "node.opacity", type: "Float", version: 1, properties: { value: 1 } },
            { id: "node.output", type: "SurfaceOutput", version: 1, properties: {} },
        ],
        connections: [
            { id: "conn.base", from: { nodeId: "node.baseColor", portId: "value" }, to: { nodeId: "node.output", portId: "BaseColor" } },
            { id: "conn.emissive", from: { nodeId: "node.emissive", portId: "value" }, to: { nodeId: "node.output", portId: "Emissive" } },
            { id: "conn.metallic", from: { nodeId: "node.metallic", portId: "value" }, to: { nodeId: "node.output", portId: "Metallic" } },
            { id: "conn.roughness", from: { nodeId: "node.roughness", portId: "value" }, to: { nodeId: "node.output", portId: "Roughness" } },
            { id: "conn.opacity", from: { nodeId: "node.opacity", portId: "value" }, to: { nodeId: "node.output", portId: "Opacity" } },
        ],
        editorMetadata: { nodes: {} },
    };
}

function topology(raw: string): GraphTopology {
    const parsed = parseShaderGraphDocument(raw);
    if (!parsed.ok || parsed.value === null) {
        throw new Error(`expected a parseable document: ${JSON.stringify(parsed.diagnostics)}`);
    }
    return resolveGraphTopology(parsed.value);
}

function baseTopology(): GraphTopology {
    return topology(JSON.stringify(baseSurfaceDocument()));
}

describe("resolveGraphTopology", () => {
    it("orders a valid document deterministically: sources first, roots last", () => {
        const result = baseTopology();
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        expect(result.outputRootIds).toEqual(["node.output"]);
        expect(result.deadNodeIds).toEqual([]);
        // Ties broken by stable node id, never by document position.
        expect(result.executionOrder).toEqual([
            "node.baseColor",
            "node.emissive",
            "node.metallic",
            "node.opacity",
            "node.roughness",
            "node.output",
        ]);
    });

    it("keeps every source before its targets in the order", () => {
        const result = baseTopology();
        const document = baseSurfaceDocument();
        const position = new Map(result.executionOrder.map((id, index) => [id, index]));
        for (const connection of document["connections"] as Record<string, unknown>[]) {
            const from = (connection["from"] as Record<string, unknown>)["nodeId"] as string;
            const to = (connection["to"] as Record<string, unknown>)["nodeId"] as string;
            const fromPosition = position.get(from);
            const toPosition = position.get(to);
            if (fromPosition === undefined || toPosition === undefined) {
                throw new Error("expected both endpoints to be ordered");
            }
            expect(fromPosition).toBeLessThan(toPosition);
        }
    });

    it("eliminates an isolated dead node and reports it as data", () => {
        const document = baseSurfaceDocument();
        (document["nodes"] as Record<string, unknown>[]).push({ id: "node.orphan", type: "Float", version: 1, properties: { value: 1 } });
        const result = topology(JSON.stringify(document));
        expect(result.ok).toBe(true);
        expect(result.deadNodeIds).toEqual(["node.orphan"]);
        expect(result.executionOrder).toEqual(baseTopology().executionOrder);
    });

    it("eliminates a dead chain that never reaches an output root", () => {
        const document = baseSurfaceDocument();
        (document["nodes"] as Record<string, unknown>[]).push(
            { id: "node.o1", type: "Float", version: 1, properties: { value: 1 } },
            { id: "node.o2", type: "Float", version: 1, properties: { value: 2 } },
        );
        (document["connections"] as Record<string, unknown>[]).push({
            id: "conn.dead",
            from: { nodeId: "node.o1", portId: "value" },
            to: { nodeId: "node.o2", portId: "value" },
        });
        const result = topology(JSON.stringify(document));
        expect(result.ok).toBe(true);
        expect(result.deadNodeIds).toEqual(["node.o1", "node.o2"]);
        expect(result.executionOrder).toEqual(baseTopology().executionOrder);
    });

    it("orders a multiply chain by dependencies, with id-based tie breaking", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.multiply",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: [
                { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
                { id: "n.m", type: "Multiply", version: 1, properties: {} },
                { id: "n.a", type: "Float3", version: 1, properties: { value: [1, 1, 1] } },
                { id: "n.b", type: "Float3", version: 1, properties: { value: [2, 2, 2] } },
                { id: "n.e", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
                { id: "n.metal", type: "Float", version: 1, properties: { value: 0 } },
                { id: "n.opac", type: "Float", version: 1, properties: { value: 1 } },
                { id: "n.rough", type: "Float", version: 1, properties: { value: 0.5 } },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.a", portId: "value" }, to: { nodeId: "n.m", portId: "a" } },
                { id: "c2", from: { nodeId: "n.b", portId: "value" }, to: { nodeId: "n.m", portId: "b" } },
                { id: "c3", from: { nodeId: "n.m", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } },
                { id: "c4", from: { nodeId: "n.e", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
                { id: "c5", from: { nodeId: "n.metal", portId: "value" }, to: { nodeId: "n.out", portId: "Metallic" } },
                { id: "c6", from: { nodeId: "n.opac", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
                { id: "c7", from: { nodeId: "n.rough", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
            ],
            editorMetadata: { nodes: {} },
        };
        // After n.a and n.b, the multiply node unlocks; its shorter id
        // "n.m" sorts before "n.metal".
        const expected = ["n.a", "n.b", "n.e", "n.m", "n.metal", "n.opac", "n.rough", "n.out"];
        expect(topology(JSON.stringify(document)).executionOrder).toEqual(expected);

        // Incidental array order must not perturb the result: reversed nodes,
        // reversed connections, or both yield the identical topology.
        const variant = (nodeOrder: "keep" | "reverse", connectionOrder: "keep" | "reverse"): GraphTopology => {
            const raw = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
            if (nodeOrder === "reverse") {
                raw["nodes"] = [...(raw["nodes"] as unknown[])].reverse();
            }
            if (connectionOrder === "reverse") {
                raw["connections"] = [...(raw["connections"] as unknown[])].reverse();
            }
            return topology(JSON.stringify(raw));
        };
        const reference = topology(JSON.stringify(document));
        expect(variant("reverse", "keep")).toEqual(reference);
        expect(variant("keep", "reverse")).toEqual(reference);
        expect(variant("reverse", "reverse")).toEqual(reference);
        for (const check of [variant("reverse", "keep"), variant("keep", "reverse"), variant("reverse", "reverse")]) {
            expect(check.executionOrder).toEqual(expected);
        }
    });

    it("refuses a topological order when the live subgraph has a cycle", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.live-cycle",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: [
                { id: "n.a", type: "Saturate", version: 1, properties: {} },
                { id: "n.b", type: "Saturate", version: 1, properties: {} },
                { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.b", portId: "value" }, to: { nodeId: "n.a", portId: "value" } },
                { id: "c2", from: { nodeId: "n.a", portId: "value" }, to: { nodeId: "n.b", portId: "value" } },
                { id: "c3", from: { nodeId: "n.a", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const result = topology(JSON.stringify(document));
        expect(result.ok).toBe(false);
        expect(result.executionOrder).toEqual([]);
        expect(result.deadNodeIds).toEqual([]);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.CycleDetected, severity: "error", dataPath: "$" }),
        ]);
    });

    it("lets a cycle confined to dead nodes pass the live order", () => {
        const document = baseSurfaceDocument();
        (document["nodes"] as Record<string, unknown>[]).push(
            { id: "n.o1", type: "Saturate", version: 1, properties: {} },
            { id: "n.o2", type: "Saturate", version: 1, properties: {} },
        );
        (document["connections"] as Record<string, unknown>[]).push(
            { id: "c1", from: { nodeId: "n.o1", portId: "value" }, to: { nodeId: "n.o2", portId: "value" } },
            { id: "c2", from: { nodeId: "n.o2", portId: "value" }, to: { nodeId: "n.o1", portId: "value" } },
        );
        const result = topology(JSON.stringify(document));
        expect(result.ok).toBe(true);
        expect(result.deadNodeIds).toEqual(["n.o1", "n.o2"]);
        expect(result.executionOrder).toEqual(baseTopology().executionOrder);
    });

    it("reports the degenerate no-roots result without pretending", () => {
        // No output node, and the connections that referenced it removed so
        // the document still parses.
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.roots",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: (baseSurfaceDocument()["nodes"] as Record<string, unknown>[]).filter((node) => node["id"] !== "node.output"),
            connections: [],
            editorMetadata: { nodes: {} },
        };
        const result = topology(JSON.stringify(document));
        expect(result.ok).toBe(true);
        expect(result.outputRootIds).toEqual([]);
        expect(result.executionOrder).toEqual([]);
        expect(result.deadNodeIds).toEqual(["node.baseColor", "node.emissive", "node.metallic", "node.opacity", "node.roughness"]);
    });
});
