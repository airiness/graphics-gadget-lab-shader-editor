import { describe, expect, it } from "vitest";
import { DiagnosticCode, parseShaderGraphDocument, validateShaderGraph } from "../src/index.js";
import type { ValidationReport } from "../src/index.js";

function baseSurfaceDocument(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        graphId: "graph.valid-surface",
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

const baseJson = JSON.stringify(baseSurfaceDocument());

function validateRaw(raw: string): ValidationReport {
    const parsed = parseShaderGraphDocument(raw);
    if (!parsed.ok || parsed.value === null) {
        throw new Error(`expected a parseable document: ${JSON.stringify(parsed.diagnostics)}`);
    }
    return validateShaderGraph(parsed.value);
}

function validateVariant(mutate: (document: Record<string, unknown>) => void): ValidationReport {
    const document: Record<string, unknown> = JSON.parse(baseJson);
    mutate(document);
    return validateRaw(JSON.stringify(document));
}

function expectElement<T>(elements: readonly T[], index: number): T {
    const element = elements[index];
    if (element === undefined) {
        throw new Error(`expected array element ${index}`);
    }
    return element;
}

describe("validateShaderGraph", () => {
    it("accepts a fully connected valid surface document with no diagnostics", () => {
        const report = validateRaw(baseJson);
        expect(report.ok).toBe(true);
        expect(report.diagnostics).toEqual([]);
    });

    it("reports an unknown target port and the input it leaves unconnected", () => {
        const report = validateVariant((document) => {
            const connections = document["connections"] as Record<string, unknown>[];
            (connections[0] as Record<string, unknown>)["to"] = { nodeId: "node.output", portId: "BaseCOlor" };
        });
        expect(report.ok).toBe(false);
        expect(report.diagnostics).toHaveLength(2);
        expect(report.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnknownPort, severity: "error", dataPath: "$.connections[0].to" }),
        );
        expect(report.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.MissingRequiredInput, severity: "error", dataPath: "$.nodes[5]" }),
        );
    });

    it("rejects a connection that starts at an input port", () => {
        const report = validateVariant((document) => {
            const connections = document["connections"] as Record<string, unknown>[];
            (connections[0] as Record<string, unknown>)["from"] = { nodeId: "node.output", portId: "BaseColor" };
        });
        expect(report.ok).toBe(false);
        // The rewired connection also points node.output at itself, so the
        // self-loop is reported alongside the wrong-side start.
        expect(report.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.InvalidConnection, severity: "error", dataPath: "$.connections[0].from" }),
            expect.objectContaining({ code: DiagnosticCode.CycleDetected, severity: "error", dataPath: "$.nodes[5]" }),
        ]);
    });

    it("rejects a connection that ends at an output port", () => {
        const report = validateVariant((document) => {
            const connections = document["connections"] as Record<string, unknown>[];
            (connections[0] as Record<string, unknown>)["to"] = { nodeId: "node.emissive", portId: "value" };
        });
        expect(report.ok).toBe(false);
        const wrongSide = report.diagnostics.find((diagnostic) => diagnostic.code === DiagnosticCode.InvalidConnection);
        expect(wrongSide?.dataPath).toBe("$.connections[0].to");
    });

    it("reports a missing required input when its connection is dropped", () => {
        const report = validateVariant((document) => {
            document["connections"] = (document["connections"] as Record<string, unknown>[]).filter(
                (connection) => connection["id"] !== "conn.metallic",
            );
        });
        expect(report.ok).toBe(false);
        expect(report.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.MissingRequiredInput, severity: "error", dataPath: "$.nodes[5]" }),
        ]);
    });

    it("rejects a connection whose endpoint types share no compatible type", () => {
        const report = validateVariant((document) => {
            const nodes = document["nodes"] as Record<string, unknown>[];
            expectElement(nodes, 0)["type"] = "Float4";
        });
        expect(report.ok).toBe(false);
        expect(report.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.TypeMismatch, severity: "error", dataPath: "$.connections[0]" }),
        ]);
    });

    it("rejects a second incoming connection on the same input port", () => {
        const report = validateVariant((document) => {
            const connections = document["connections"] as Record<string, unknown>[];
            connections.push({
                id: "conn.dupe",
                from: { nodeId: "node.emissive", portId: "value" },
                to: { nodeId: "node.output", portId: "BaseColor" },
            });
        });
        expect(report.ok).toBe(false);
        expect(report.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.DuplicateConnection, severity: "error", dataPath: "$.connections[5]" }),
        ]);
    });

    it("allows one output to feed multiple input ports (fan-out)", () => {
        const report = validateVariant((document) => {
            const connections = document["connections"] as Record<string, unknown>[];
            // Re-wire the emissive connection so the baseColor output feeds
            // both BaseColor and Emissive.
            const emissive = connections.find((connection) => connection["id"] === "conn.emissive");
            if (emissive === undefined) {
                throw new Error("expected the emissive connection");
            }
            emissive["from"] = { nodeId: "node.baseColor", portId: "value" };
        });
        expect(report.ok).toBe(true);
        expect(report.diagnostics).toEqual([]);
    });

    it("detects a node-level cycle", () => {
        const document = {
            schemaVersion: 1,
            graphId: "graph.cycle",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: [
                { id: "node.a", type: "Saturate", version: 1, properties: {} },
                { id: "node.b", type: "Saturate", version: 1, properties: {} },
            ],
            connections: [
                { id: "conn.ba", from: { nodeId: "node.b", portId: "value" }, to: { nodeId: "node.a", portId: "value" } },
                { id: "conn.ab", from: { nodeId: "node.a", portId: "value" }, to: { nodeId: "node.b", portId: "value" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const report = validateRaw(JSON.stringify(document));
        expect(report.ok).toBe(false);
        // The fixture intentionally has no SurfaceOutput node; the validator
        // correctly reports that too.
        expect(report.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.CycleDetected, severity: "error", dataPath: "$.nodes[0]" }),
            expect.objectContaining({ code: DiagnosticCode.MissingOutput, severity: "error", dataPath: "$" }),
        ]);
    });

    it("detects a self-loop as a cycle", () => {
        const document = {
            schemaVersion: 1,
            graphId: "graph.self-loop",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: [{ id: "node.s", type: "Saturate", version: 1, properties: {} }],
            connections: [
                { id: "conn.loop", from: { nodeId: "node.s", portId: "value" }, to: { nodeId: "node.s", portId: "value" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const report = validateRaw(JSON.stringify(document));
        expect(report.ok).toBe(false);
        // The fixture intentionally has no SurfaceOutput node; the validator
        // correctly reports that too.
        expect(report.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.CycleDetected, severity: "error", dataPath: "$.nodes[0]" }),
            expect.objectContaining({ code: DiagnosticCode.MissingOutput, severity: "error", dataPath: "$" }),
        ]);
    });

    it("reports a missing surface output node", () => {
        const report = validateVariant((document) => {
            document["nodes"] = (document["nodes"] as Record<string, unknown>[]).filter((node) => node["id"] !== "node.output");
            document["connections"] = [];
        });
        expect(report.ok).toBe(false);
        expect(report.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.MissingOutput, severity: "error", dataPath: "$" }),
        ]);
    });

    it("warns on unknown node types and skips their port checks (self-contained)", () => {
        const report = validateVariant((document) => {
            const nodes = document["nodes"] as Record<string, unknown>[];
            const connections = document["connections"] as Record<string, unknown>[];
            nodes.push({ id: "node.warp", type: "WarpField", version: 1, properties: {} });
            connections.push({
                id: "conn.warp",
                from: { nodeId: "node.warp", portId: "value" },
                to: { nodeId: "node.output", portId: "BaseColor" },
            });
            // Keep BaseColor singly fed: drop its original connection.
            document["connections"] = connections.filter((connection) => connection["id"] !== "conn.base");
        });
        expect(report.ok).toBe(true);
        expect(report.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnknownNodeType, severity: "warning", dataPath: "$.nodes[6].type" }),
        ]);
    });

    it("warns on node versions outside the definition's supported range", () => {
        const report = validateVariant((document) => {
            const nodes = document["nodes"] as Record<string, unknown>[];
            expectElement(nodes, 2)["version"] = 9;
        });
        expect(report.ok).toBe(true);
        expect(report.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnknownNodeVersion, severity: "warning", dataPath: "$.nodes[2].version" }),
        ]);
    });

    it("rejects a profile this core does not implement", () => {
        const report = validateVariant((document) => {
            document["profile"] = "gglab.fresnel";
        });
        expect(report.ok).toBe(false);
        expect(report.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnknownProfileFeature, severity: "error", dataPath: "$" }),
        ]);
    });

    it("rejects a profile version this core does not implement", () => {
        const report = validateVariant((document) => {
            document["profileVersion"] = 2;
        });
        expect(report.ok).toBe(false);
        expect(report.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnknownProfileFeature, severity: "error", dataPath: "$" }),
        ]);
    });

    it("composes with the parse layer: parse then validate", () => {
        const parsed = parseShaderGraphDocument(baseJson);
        if (!parsed.ok || parsed.value === null) {
            throw new Error("expected the base document to parse");
        }
        const report = validateShaderGraph(parsed.value);
        expect(report.ok).toBe(true);
        expect(report.diagnostics).toEqual([]);
    });
});
