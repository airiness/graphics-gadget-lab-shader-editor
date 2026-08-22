import { describe, expect, it } from "vitest";
import {
    DEFERRED_GRAPH_TYPES,
    GRAPH_TYPES,
    NUMERIC_TYPES,
    NODE_DEFINITIONS,
    getNodeDefinition,
    createNode,
    supportedNodeTypeCatalog,
    isGraphType,
    isImplicitlyConvertible,
    isNumericType,
} from "../src/index.js";
import { DiagnosticCode, parseShaderGraphDocument } from "../src/index.js";
import type { GraphType, NodeDefinition } from "../src/index.js";

// Local test helpers (not part of the public API).

function definition(type: string): NodeDefinition {
    const found = getNodeDefinition(type);
    if (found === undefined) {
        throw new Error(`expected node definition ${type}`);
    }
    return found;
}

function inputTypes(type: string): Record<string, readonly GraphType[]> {
    return portTypes(definition(type).inputs);
}

function outputTypes(type: string): Record<string, readonly GraphType[]> {
    return portTypes(definition(type).outputs);
}

function portTypes(ports: readonly { id: string; types: readonly GraphType[] }[]): Record<string, readonly GraphType[]> {
    const result: Record<string, readonly GraphType[]> = {};
    for (const port of ports) {
        result[port.id] = port.types;
    }
    return result;
}

describe("graph type system", () => {
    it("exposes exactly the v1 value domain", () => {
        expect([...GRAPH_TYPES].sort()).toEqual(["Texture2D", "float", "float2", "float3", "float4"]);
        expect([...NUMERIC_TYPES].sort()).toEqual(["float", "float2", "float3", "float4"]);
    });

    it("classifies v1 types and rejects deferred or unknown ones", () => {
        expect(isGraphType("float")).toBe(true);
        expect(isGraphType("float4")).toBe(true);
        expect(isGraphType("Texture2D")).toBe(true);
        expect(isGraphType("bool")).toBe(false);
        expect(isGraphType("Sampler")).toBe(false);
        expect(isGraphType("float5")).toBe(false);
        expect(isGraphType("float2x2")).toBe(false);

        expect(isNumericType("float3")).toBe(true);
        expect(isNumericType("Texture2D")).toBe(false);

        // Deferred types are named so consumers can diagnose them explicitly.
        expect([...DEFERRED_GRAPH_TYPES].sort()).toEqual(["Sampler", "bool"]);
    });

    it("keeps implicit conversion conservative: identity only", () => {
        expect(isImplicitlyConvertible("float", "float")).toBe(true);
        expect(isImplicitlyConvertible("Texture2D", "Texture2D")).toBe(true);
        // Vector-to-vector is explicitly not implicit.
        expect(isImplicitlyConvertible("float2", "float3")).toBe(false);
        expect(isImplicitlyConvertible("float4", "float3")).toBe(false);
        expect(isImplicitlyConvertible("float", "float3")).toBe(false);
        expect(isImplicitlyConvertible("Texture2D", "float")).toBe(false);
    });
});

describe("initial node definitions", () => {
    it("defines exactly the initial node family, one version-1 range each", () => {
        const expected = [
            "Add",
            "Divide",
            "Dot",
            "Float",
            "Float2",
            "Float3",
            "Float4",
            "Lerp",
            "Max",
            "Min",
            "Multiply",
            "Normalize",
            "OneMinus",
            "SampleTexture2D",
            "Saturate",
            "ScalarParameter",
            "Subtract",
            "SurfaceOutput",
            "Texture2DParameter",
            "UV0",
            "VectorParameter",
        ];
        expect(NODE_DEFINITIONS.map((node) => node.type).sort()).toEqual(expected);
        for (const node of NODE_DEFINITIONS) {
            expect(node.versionRange).toEqual({ minimumVersion: 1, maximumVersion: 1 });
        }
    });

    it("declares channel and surface ports exactly as the architecture spells them", () => {
        // SampleTexture2D exposed channel outputs (architecture: initial
        // profile, node family).
        expect(outputTypes("SampleTexture2D")).toEqual({
            RGBA: ["float4"],
            RGB: ["float3"],
            R: ["float"],
            G: ["float"],
            B: ["float"],
            A: ["float"],
        });
        expect(inputTypes("SampleTexture2D")).toEqual({
            texture: ["Texture2D"],
            uv: ["float2"],
        });

        // SurfaceOutput maps one-to-one onto the profile's required outputs.
        expect(inputTypes("SurfaceOutput")).toEqual({
            BaseColor: ["float3"],
            Emissive: ["float3"],
            Metallic: ["float"],
            Roughness: ["float"],
            Opacity: ["float"],
        });
        expect(definition("SurfaceOutput").outputs).toEqual([]);

        // Math operand typing over the numeric family.
        expect(inputTypes("Multiply")).toEqual({
            a: ["float", "float2", "float3", "float4"],
            b: ["float", "float2", "float3", "float4"],
        });
        expect(outputTypes("Multiply")).toEqual({ value: ["float", "float2", "float3", "float4"] });
        expect(inputTypes("Lerp")).toEqual({
            a: ["float", "float2", "float3", "float4"],
            b: ["float", "float2", "float3", "float4"],
            t: ["float"],
        });
        expect(inputTypes("Dot")).toEqual({ a: ["float2", "float3", "float4"], b: ["float2", "float3", "float4"] });
        expect(outputTypes("Dot")).toEqual({ value: ["float"] });
        expect(inputTypes("Normalize")).toEqual({ value: ["float2", "float3", "float4"] });

        // Parameter and input nodes.
        expect(outputTypes("ScalarParameter")).toEqual({ value: ["float"] });
        expect(outputTypes("VectorParameter")).toEqual({ value: ["float2", "float3", "float4"] });
        expect(outputTypes("UV0")).toEqual({ value: ["float2"] });
        expect(outputTypes("Texture2DParameter")).toEqual({ value: ["Texture2D"] });
        expect(inputTypes("Texture2DParameter")).toEqual({});

        // Constants carry their constant as a property, not a port.
        expect(definition("Float").properties.map((prop) => `${prop.name}:${prop.type}`)).toEqual(["value:float"]);
        expect(definition("Float4").properties.map((prop) => `${prop.name}:${prop.type}`)).toEqual(["value:float4"]);
    });

    it("marks every declared input port required in the initial family", () => {
        for (const node of NODE_DEFINITIONS) {
            for (const input of node.inputs) {
                expect(input.required, `expected ${node.type}.${input.id} to be required`).toBe(true);
            }
        }
    });

    it("is pure, JSON-queryable data", () => {
        const serialized = JSON.stringify(NODE_DEFINITIONS);
        expect(JSON.parse(serialized)).toEqual(NODE_DEFINITIONS);
    });

    it("resolves definitions by type and rejects unknown types", () => {
        expect(getNodeDefinition("Add")?.category).toBe("math");
        expect(getNodeDefinition("UV0")?.category).toBe("input");
        expect(getNodeDefinition("SurfaceOutput")?.category).toBe("output");
        expect(getNodeDefinition("ComponentMask")).toBeUndefined();
        expect(getNodeDefinition("Swizzle")).toBeUndefined();
    });

    it("exposes the core's built-in node type catalog", () => {
        const catalog = supportedNodeTypeCatalog();
        expect(Object.keys(catalog).sort()).toEqual(NODE_DEFINITIONS.map((node) => node.type).sort());
        for (const node of NODE_DEFINITIONS) {
            expect(catalog[node.type]).toEqual({ minimumVersion: 1, maximumVersion: 1 });
        }
    });
});

describe("node definitions versus document parsing", () => {
    it("parses a document containing every v1 node type without diagnostics", () => {
        const nodes = NODE_DEFINITIONS.map((node) => ({
            id: `node.${node.type}`,
            type: node.type,
            version: 1,
            properties: {},
        }));
        const document = {
            schemaVersion: 1,
            graphId: "graph.node-set",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes,
            connections: [],
            editorMetadata: { nodes: {} },
        };
        const result = parseShaderGraphDocument(JSON.stringify(document));
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
    });

    it("warns on versions outside a definition's supported range", () => {
        const nodes = [
            { id: "node.multiply", type: "Multiply", version: 2, properties: {} },
        ];
        const document = {
            schemaVersion: 1,
            graphId: "graph.version-range",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes,
            connections: [],
            editorMetadata: { nodes: {} },
        };
        const result = parseShaderGraphDocument(JSON.stringify(document));
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnknownNodeVersion, severity: "warning", dataPath: "$.nodes[0].version" }),
        ]);
    });
});

describe("createNode — the single authority for node-creation semantics", () => {
    it("returns the version range minimum and the declared creation defaults for constants", () => {
        expect(createNode("Float")).toEqual({
            ok: true,
            nodeVersion: 1,
            properties: { value: 0 },
            diagnostics: [],
        });
        expect(createNode("Float2").properties).toEqual({ value: [0, 0] });
        expect(createNode("Float3").properties).toEqual({ value: [0, 0, 0] });
        expect(createNode("Float4").properties).toEqual({ value: [0, 0, 0, 0] });
    });

    it("returns no properties for types that declare none (nothing invented)", () => {
        expect(createNode("Multiply")).toEqual({ ok: true, nodeVersion: 1, properties: {}, diagnostics: [] });
        expect(createNode("SurfaceOutput").properties).toEqual({});
        expect(createNode("UV0").properties).toEqual({});
    });

    it("refuses a type the catalog does not know (structured, nothing created)", () => {
        const result = createNode("NoSuchNode");
        expect(result.ok).toBe(false);
        expect(result.properties).toEqual({});
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnknownNodeType, severity: "error" }),
        ]);
    });
});
