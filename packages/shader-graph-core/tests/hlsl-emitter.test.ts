import { describe, expect, it } from "vitest";
import {
    DiagnosticCode,
    emitHlsl,
    parseShaderGraphDocument,
    parseSurfaceProfileDescriptor,
    sha256Hex,
    utf8Encode,
} from "../src/index.js";
import type { HlslEmission, SurfaceProfileDescriptor } from "../src/index.js";
import { canonicalV1Fixture } from "./fixtures/descriptor-v1.js";
import { canonicalV2Fixture } from "./fixtures/descriptor-v2.js";

const parsedDescriptor = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV1Fixture));
if (parsedDescriptor.value === null) {
    throw new Error("expected the canonical v1 descriptor fixture to parse");
}
const descriptor: SurfaceProfileDescriptor = parsedDescriptor.value;

const parsedV2Descriptor = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV2Fixture));
if (parsedV2Descriptor.value === null) {
    throw new Error("expected the canonical v2 descriptor fixture to parse");
}
const v2Descriptor: SurfaceProfileDescriptor = parsedV2Descriptor.value;

function baseDocument(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        graphId: "graph.emit",
        profile: "gglab.surface",
        profileVersion: 1,
        parameters: [
            { id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float3" },
            { id: "p.metal", name: "Metal Factor", class: "ScalarParameter", valueType: "float" },
        ],
        nodes: [
            { id: "n.t", type: "VectorParameter", version: 1, properties: { parameterId: "p.tint" } },
            { id: "n.sf", type: "ScalarParameter", version: 1, properties: { parameterId: "p.metal" } },
            { id: "n.c", type: "Float3", version: 1, properties: { value: [1, 1, 1] } },
            { id: "n.r", type: "Float", version: 1, properties: { value: 0.5 } },
            { id: "n.o", type: "Float", version: 1, properties: { value: 1 } },
            { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
        ],
        connections: [
            { id: "c1", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
            { id: "c2", from: { nodeId: "n.c", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } },
            { id: "c3", from: { nodeId: "n.sf", portId: "value" }, to: { nodeId: "n.out", portId: "Metallic" } },
            { id: "c4", from: { nodeId: "n.r", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
            { id: "c5", from: { nodeId: "n.o", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
        ],
        editorMetadata: { nodes: {} },
    };
}

const baseJson = JSON.stringify(baseDocument());

function emitParsed(raw: string): HlslEmission {
    const parsed = parseShaderGraphDocument(raw);
    if (!parsed.ok || parsed.value === null) {
        throw new Error(`expected a parseable document: ${JSON.stringify(parsed.diagnostics)}`);
    }
    return emitHlsl(parsed.value, descriptor);
}

function emitVariant(mutate: (document: Record<string, unknown>) => void): HlslEmission {
    const document: Record<string, unknown> = JSON.parse(baseJson);
    mutate(document);
    return emitParsed(JSON.stringify(document));
}

function textureDocument(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        graphId: "graph.texture2d",
        profile: "gglab.surface",
        profileVersion: 2,
        parameters: [
            { id: "p.tex", name: "Texture", class: "Texture2DParameter", valueType: "Texture2D" },
            { id: "p.rough", name: "Roughness Factor", class: "ScalarParameter", valueType: "float" },
        ],
        nodes: [
            { id: "n.tp", type: "Texture2DParameter", version: 1, properties: { parameterId: "p.tex" } },
            { id: "n.uv", type: "UV0", version: 1, properties: {} },
            { id: "n.smp", type: "SampleTexture2D", version: 1, properties: {} },
            { id: "n.e", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
            { id: "n.r", type: "ScalarParameter", version: 1, properties: { parameterId: "p.rough" } },
            { id: "n.o", type: "Float", version: 1, properties: { value: 1 } },
            { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
        ],
        connections: [
            { id: "c1", from: { nodeId: "n.tp", portId: "value" }, to: { nodeId: "n.smp", portId: "texture" } },
            { id: "c2", from: { nodeId: "n.uv", portId: "value" }, to: { nodeId: "n.smp", portId: "uv" } },
            { id: "c3", from: { nodeId: "n.smp", portId: "RGB" }, to: { nodeId: "n.out", portId: "BaseColor" } },
            { id: "c4", from: { nodeId: "n.smp", portId: "B" }, to: { nodeId: "n.out", portId: "Metallic" } },
            { id: "c5", from: { nodeId: "n.e", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
            { id: "c6", from: { nodeId: "n.r", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
            { id: "c7", from: { nodeId: "n.o", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
        ],
        editorMetadata: { nodes: {} },
    };
}

function emitParsedAgainstV2(raw: string): HlslEmission {
    const parsed = parseShaderGraphDocument(raw);
    if (!parsed.ok || parsed.value === null) {
        throw new Error(`expected a parseable document: ${JSON.stringify(parsed.diagnostics)}`);
    }
    return emitHlsl(parsed.value, v2Descriptor);
}

function expectElement<T>(elements: readonly T[], index: number): T {
    const element = elements[index];
    if (element === undefined) {
        throw new Error(`expected element ${index} to exist in [${elements.length}]`);
    }
    return element;
}

describe("emitHlsl", () => {
    it("emits the frozen contract shape for a numeric surface document, byte-for-byte", () => {
        const result = emitParsed(baseJson);
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        expect(result.source).toBe(
            [
                "// Generated by GGLab ShaderGraphCore. Do not edit; regenerate from the source .shadergraph document.",
                "",
                "struct SurfaceData",
                "{",
                "    float3 BaseColor;",
                "    float3 Emissive;",
                "    float Metallic;",
                "    float Roughness;",
                "    float Opacity;",
                "};",
                "",
                "SurfaceData EvaluateSurface(",
                // Canonical stable-id order: "p.metal" < "p.tint".
                "    float gglab_p_metal,",
                "    float3 gglab_p_tint,",
                "    float2 gglab_uv0",
                ")",
                "{",
                "    SurfaceData surface;",
                "    float3 v_n_c = float3(1.0, 1.0, 1.0);",
                "    float v_n_o = 1.0;",
                "    float v_n_r = 0.5;",
                "    float v_n_sf = gglab_p_metal;",
                "    float3 v_n_t = gglab_p_tint;",
                "    surface.BaseColor = v_n_c;",
                "    surface.Emissive = v_n_t;",
                "    surface.Metallic = v_n_sf;",
                "    surface.Roughness = v_n_r;",
                "    surface.Opacity = v_n_o;",
                "    return surface;",
                "}",
                "",
            ].join("\n"),
        );
        const map = result.sourceMap;
        expect(map).not.toBeNull();
        if (map !== null) {
            // The durable generated-source identity is the exact-byte SHA-256.
            expect(map.generatedSourceIdentity).toMatch(/^[0-9a-f]{64}$/);
            expect(map.generatedSourceIdentity).toBe(sha256Hex(utf8Encode(result.source)));
        }
    });

    it("is byte-stable under incidental array order", () => {
        const reference = emitParsed(baseJson);
        expect(reference.ok).toBe(true);
        const variant = (
            nodeOrder: "keep" | "reverse",
            connectionOrder: "keep" | "reverse",
            parameterOrder: "keep" | "reverse",
        ): HlslEmission => {
            const raw = JSON.parse(baseJson) as Record<string, unknown>;
            if (nodeOrder === "reverse") {
                raw["nodes"] = [...(raw["nodes"] as unknown[])].reverse();
            }
            if (connectionOrder === "reverse") {
                raw["connections"] = [...(raw["connections"] as unknown[])].reverse();
            }
            if (parameterOrder === "reverse") {
                raw["parameters"] = [...(raw["parameters"] as unknown[])].reverse();
            }
            return emitParsed(JSON.stringify(raw));
        };
        for (const check of [
            variant("reverse", "keep", "keep"),
            variant("keep", "reverse", "keep"),
            variant("keep", "keep", "reverse"),
            variant("reverse", "reverse", "reverse"),
        ]) {
            expect(check.ok).toBe(true);
            // Byte identity is the strongest form of the deterministic-
            // emission invariant; the SHA-256 durable identity (AGENTS.md)
            // follows from byte identity by definition.
            expect(check.source).toBe(reference.source);
            expect(check.sourceMap).toEqual(reference.sourceMap);
        }
    });

    it("never changes the bytes for display-name-only renames", () => {
        const reference = emitParsed(baseJson);
        const renamed = emitVariant((document) => {
            (document["parameters"] as Record<string, unknown>[]).forEach((parameter) => {
                parameter["name"] = `${parameter["name"]} (renamed)`;
            });
            const nodes = document["nodes"] as Record<string, unknown>[];
            nodes.forEach((node) => {
                node["label"] = `Label ${node["id"]}`;
            });
        });
        expect(renamed.ok).toBe(true);
        expect(renamed.source).toBe(reference.source);
    });

    it("reports the §24 source map: roles, line/column spans, and coherent identities", () => {
        const result = emitParsed(baseJson);
        const map = result.sourceMap;
        expect(map).not.toBeNull();
        const source = result.source;
        const sourceLines = source.split("\n");
        if (map === null) {
            throw new Error("unreachable");
        }
        const ranges = map.ranges;
        // 5 profile fields + function declaration + 2 parameter declarations
        // + 1 visible-input declaration + 5 node statements + 5 assignments.
        expect(ranges).toHaveLength(19);
        let previousLine = 0;
        for (const range of ranges) {
            // Ranges follow source order; each spans its single generated line.
            expect(range.startLine).toBeGreaterThan(previousLine);
            previousLine = range.startLine;
            expect(range.endLine).toBe(range.startLine);
            expect(range.startColumn).toBe(1);
            const lineText = sourceLines[range.startLine - 1];
            if (lineText === undefined) {
                throw new Error("unreachable");
            }
            expect(range.endColumn).toBe(lineText.length + 1);
            // Role/identity coherence.
            switch (range.role) {
                case "nodeValueStatement":
                case "requiredOutputAssignment":
                    expect(range.nodeId).toBeDefined();
                    expect(range.portId).toBe("value");
                    expect(range.parameterId).toBeUndefined();
                    expect(range.graphVisibleInputId).toBeUndefined();
                    break;
                case "graphParameterDeclaration":
                    expect(range.parameterId).toBeDefined();
                    expect(range.nodeId).toBeUndefined();
                    break;
                case "graphVisibleInputDeclaration":
                    expect(range.graphVisibleInputId).toBeDefined();
                    expect(range.nodeId).toBeUndefined();
                    break;
                case "requiredOutputField":
                case "include":
                    expect(range.name).toBeDefined();
                    expect(range.nodeId).toBeUndefined();
                    break;
                case "generatedFunctionDeclaration":
                    expect(range.nodeId).toBeUndefined();
                    expect(range.parameterId).toBeUndefined();
                    break;
            }
        }
        const lineAt = (line: number): string => {
            const text = sourceLines[line - 1];
            if (text === undefined) {
                throw new Error("unreachable");
            }
            return text;
        };
        // Spans land on their symbols.
        const parameterRange = ranges.find((range) => range.parameterId === "p.tint");
        expect(parameterRange).toBeDefined();
        if (parameterRange !== undefined) {
            expect(lineAt(parameterRange.startLine)).toContain("gglab_p_tint");
        }
        const statementRange = ranges.find((range) => range.nodeId === "n.c");
        expect(statementRange).toBeDefined();
        if (statementRange !== undefined) {
            expect(lineAt(statementRange.startLine)).toContain("v_n_c");
        }
        const assignmentRange = ranges.find((range) => range.role === "requiredOutputAssignment" && range.name === "Metallic");
        expect(assignmentRange).toBeDefined();
        if (assignmentRange !== undefined) {
            expect(lineAt(assignmentRange.startLine)).toContain("surface.Metallic");
        }
    });

    it("sanitizes parameter ids to ASCII-safe, collision-free symbols", () => {
        const raw = JSON.parse(baseJson) as Record<string, unknown>;
        const parameters = raw["parameters"] as Record<string, unknown>[];
        const nodes = raw["nodes"] as Record<string, unknown>[];
        // Rename the parameter ids and the node references that name them.
        expectElement(parameters, 0)["id"] = "a.b";
        expectElement(parameters, 1)["id"] = "a_b";
        (nodes.find((node) => node["id"] === "n.t") as Record<string, unknown>)["properties"] = { parameterId: "a.b" };
        (nodes.find((node) => node["id"] === "n.sf") as Record<string, unknown>)["properties"] = { parameterId: "a_b" };
        const result = emitParsed(JSON.stringify(raw));
        expect(result.ok).toBe(true);
        const source = result.source;
        expect(source).toContain("gglab_a_b");
        expect(source).toContain("gglab_a_b_2");
        // Each symbol appears on its signature line and its node statement.
        const symbolMatches = [...new Set(source.match(/\bgglab_a_b(_2)?\b/g) ?? [])];
        expect(symbolMatches).toEqual(["gglab_a_b", "gglab_a_b_2"]);
    });

    it("rejects mixed vector sizes meeting in a math operation", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.mixed",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [{ id: "p.metal", name: "M", class: "ScalarParameter", valueType: "float" }],
            nodes: [
                { id: "n.f2", type: "Float2", version: 1, properties: { value: [1, 1] } },
                { id: "n.f3", type: "Float3", version: 1, properties: { value: [1, 1, 1] } },
                { id: "n.m", type: "Multiply", version: 1, properties: {} },
                { id: "n.e", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
                { id: "n.sf", type: "ScalarParameter", version: 1, properties: { parameterId: "p.metal" } },
                { id: "n.r", type: "Float", version: 1, properties: { value: 0.5 } },
                { id: "n.o", type: "Float", version: 1, properties: { value: 1 } },
                { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.f2", portId: "value" }, to: { nodeId: "n.m", portId: "a" } },
                { id: "c2", from: { nodeId: "n.f3", portId: "value" }, to: { nodeId: "n.m", portId: "b" } },
                { id: "c3", from: { nodeId: "n.m", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } },
                { id: "c4", from: { nodeId: "n.e", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
                { id: "c5", from: { nodeId: "n.sf", portId: "value" }, to: { nodeId: "n.out", portId: "Metallic" } },
                { id: "c6", from: { nodeId: "n.r", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
                { id: "c7", from: { nodeId: "n.o", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const result = emitParsed(JSON.stringify(document));
        expect(result.ok).toBe(false);
        expect(result.source).toBe("");
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.TypeMismatch, severity: "error", dataPath: "$.nodes[2]" }),
        ]);
    });

    it("refuses a parameter class in the descriptor's deferred set", () => {
        const result = emitVariant((document) => {
            // A parameter entry nobody declares: exercises the class gate
            // without tripping the parameter-node class-mismatch check.
            (document["parameters"] as Record<string, unknown>[]).push({ id: "p.flag", name: "Flag", class: "BoolParameter", valueType: "float" });
        });
        expect(result.ok).toBe(false);
        expect(result.source).toBe("");
        expect(result.sourceMap).toBeNull();
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.UnsupportedParameterClass,
                severity: "error",
                dataPath: "$.parameters[2]",
                message: expect.stringContaining("deferred"),
            }),
        ]);
    });

    it("refuses texture sampling nodes with a structured diagnostic", () => {
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
                { id: "n.e", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
                { id: "n.r", type: "Float", version: 1, properties: { value: 0.5 } },
                { id: "n.o", type: "Float", version: 1, properties: { value: 1 } },
                { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.tp", portId: "value" }, to: { nodeId: "n.smp", portId: "texture" } },
                { id: "c2", from: { nodeId: "n.uv", portId: "value" }, to: { nodeId: "n.smp", portId: "uv" } },
                { id: "c3", from: { nodeId: "n.smp", portId: "RGB" }, to: { nodeId: "n.out", portId: "BaseColor" } },
                { id: "c4", from: { nodeId: "n.smp", portId: "R" }, to: { nodeId: "n.out", portId: "Metallic" } },
                { id: "c5", from: { nodeId: "n.e", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
                { id: "c6", from: { nodeId: "n.r", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
                { id: "c7", from: { nodeId: "n.o", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const result = emitParsed(JSON.stringify(document));
        expect(result.ok).toBe(false);
        expect(result.source).toBe("");
        // Topological order visits the texture parameter before the sampler.
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.UnsupportedNodeEmission,
                severity: "error",
                dataPath: "$.nodes[0]",
                message: expect.stringContaining("texture-sampling"),
            }),
            expect.objectContaining({
                code: DiagnosticCode.UnsupportedNodeEmission,
                severity: "error",
                dataPath: "$.nodes[2]",
                message: expect.stringContaining("texture-sampling"),
            }),
        ]);
    });

    it("emits the frozen v2 texture-sampling contract, byte-for-byte", () => {
        const result = emitParsedAgainstV2(JSON.stringify(textureDocument()));
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        expect(result.source).toBe(
            [
                "// Generated by GGLab ShaderGraphCore. Do not edit; regenerate from the source .shadergraph document.",
                "",
                "struct SurfaceData",
                "{",
                "    float3 BaseColor;",
                "    float3 Emissive;",
                "    float Metallic;",
                "    float Roughness;",
                "    float Opacity;",
                "};",
                "",
                "float4 gglab_sampleTexture2D(uint2 textureSamplerBinding, float2 uv0)",
                "{",
                "    Texture2D<float4> texture = ResourceDescriptorHeap[NonUniformResourceIndex(textureSamplerBinding.x)];",
                "    SamplerState sampler = SamplerDescriptorHeap[NonUniformResourceIndex(textureSamplerBinding.y)];",
                "    return texture.Sample(sampler, uv0);",
                "}",
                "",
                "SurfaceData EvaluateSurface(",
                // Canonical stable-id order: "p.rough" < "p.tex".
                "    float gglab_p_rough,",
                "    uint2 gglab_p_tex,",
                "    float2 gglab_uv0",
                ")",
                "{",
                "    SurfaceData surface;",
                // Topological order: the sampler depends on n.tp and n.uv.
                "    float3 v_n_e = float3(0.0, 0.0, 0.0);",
                "    float v_n_o = 1.0;",
                "    float v_n_r = gglab_p_rough;",
                "    uint2 v_n_tp = gglab_p_tex;",
                "    float2 v_n_uv = gglab_uv0;",
                "    float4 v_n_smp = gglab_sampleTexture2D(v_n_tp, v_n_uv);",
                // Channel ports decompose the single float4 sample.
                "    surface.BaseColor = v_n_smp.rgb;",
                "    surface.Emissive = v_n_e;",
                "    surface.Metallic = v_n_smp.b;",
                "    surface.Roughness = v_n_r;",
                "    surface.Opacity = v_n_o;",
                "    return surface;",
                "}",
                "",
            ].join("\n"),
        );
        const map = result.sourceMap;
        expect(map).not.toBeNull();
        if (map !== null) {
            expect(map.generatedSourceIdentity).toBe(sha256Hex(utf8Encode(result.source)));
            // The helper has its own navigable identity.
            const helperRange = map.ranges.find((range) => range.role === "textureSampleHelperDeclaration");
            expect(helperRange).toBeDefined();
            if (helperRange !== undefined) {
                expect(helperRange.name).toBe("gglab_sampleTexture2D");
            }
            // The RGB assignment stands for the RGB port, not "value".
            const baseColorAssignment = map.ranges.find((range) => range.role === "requiredOutputAssignment" && range.name === "BaseColor");
            expect(baseColorAssignment).toBeDefined();
            if (baseColorAssignment !== undefined) {
                expect(baseColorAssignment.nodeId).toBe("n.smp");
                expect(baseColorAssignment.portId).toBe("RGB");
            }
            const samplerStatement = map.ranges.find((range) => range.nodeId === "n.smp" && range.role === "nodeValueStatement");
            expect(samplerStatement).toBeDefined();
            if (samplerStatement !== undefined) {
                expect(samplerStatement.portId).toBe("RGBA");
            }
        }
    });

    it("is byte-stable under incidental order for the v2 texture graph", () => {
        const reference = emitParsedAgainstV2(JSON.stringify(textureDocument()));
        expect(reference.ok).toBe(true);
        const variant = (nodeOrder: "keep" | "reverse", connectionOrder: "keep" | "reverse", parameterOrder: "keep" | "reverse"): HlslEmission => {
            const raw = JSON.parse(JSON.stringify(textureDocument()));
            if (nodeOrder === "reverse") {
                raw["nodes"] = [...(raw["nodes"] as unknown[])].reverse();
            }
            if (connectionOrder === "reverse") {
                raw["connections"] = [...(raw["connections"] as unknown[])].reverse();
            }
            if (parameterOrder === "reverse") {
                raw["parameters"] = [...(raw["parameters"] as unknown[])].reverse();
            }
            return emitParsedAgainstV2(JSON.stringify(raw));
        };
        for (const check of [variant("reverse", "keep", "keep"), variant("keep", "reverse", "keep"), variant("keep", "keep", "reverse"), variant("reverse", "reverse", "reverse")]) {
            expect(check.ok).toBe(true);
            expect(check.source).toBe(reference.source);
            expect(check.sourceMap).toEqual(reference.sourceMap);
        }
    });

    it("decomposes sampler channels into math operations and keeps the single-channel access", () => {
        const document = textureDocument();
        // Feed the sampler's RGB channel through a multiply and its B channel
        // through a saturate, exercising channel access at operation inputs
        // (not only at the root assignments).
        (document["nodes"] as Record<string, unknown>[]).push(
            { id: "n.scale", type: "Float3", version: 1, properties: { value: [0.5, 0.5, 0.5] } },
            { id: "n.mul", type: "Multiply", version: 1, properties: {} },
            { id: "n.sat", type: "Saturate", version: 1, properties: {} },
        );
        const connections = document["connections"] as Record<string, unknown>[];
        connections[2] = { id: "c3", from: { nodeId: "n.mul", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } };
        connections[3] = { id: "c4", from: { nodeId: "n.sat", portId: "value" }, to: { nodeId: "n.out", portId: "Metallic" } };
        connections.push({ id: "c8", from: { nodeId: "n.smp", portId: "RGB" }, to: { nodeId: "n.mul", portId: "a" } });
        connections.push({ id: "c9", from: { nodeId: "n.scale", portId: "value" }, to: { nodeId: "n.mul", portId: "b" } });
        connections.push({ id: "c10", from: { nodeId: "n.smp", portId: "B" }, to: { nodeId: "n.sat", portId: "value" } });
        const result = emitParsedAgainstV2(JSON.stringify(document));
        expect(result.ok).toBe(true);
        const source = result.source;
        expect(source).toContain("float3 v_n_mul = v_n_smp.rgb * v_n_scale;");
        expect(source).toContain("float v_n_sat = saturate(v_n_smp.b);");
        expect(source).toContain("surface.BaseColor = v_n_mul;");
        expect(source).toContain("surface.Metallic = v_n_sat;");
    });

    it("reserves the texture-sampling helper name in the signature namespace", () => {
        const document = textureDocument();
        // A parameter id that sanitizes to the helper's base must collide
        // into base_2, and the helper keeps the base.
        const parameters = document["parameters"] as Record<string, unknown>[];
        const scalar = parameters.find((parameter) => parameter["id"] === "p.rough");
        if (scalar === undefined) {
            throw new Error("expected the p.rough parameter entry");
        }
        scalar["id"] = "sampleTexture2D";
        const nodes = document["nodes"] as Record<string, unknown>[];
        const rough = nodes.find((node) => node["id"] === "n.r");
        if (rough !== undefined) {
            rough["properties"] = { parameterId: "sampleTexture2D" };
        }
        const result = emitParsedAgainstV2(JSON.stringify(document));
        expect(result.ok).toBe(true);
        const source = result.source;
        expect(source).toContain("float gglab_sampleTexture2D_2,");
        expect(source).toContain("float4 gglab_sampleTexture2D(uint2 textureSamplerBinding, float2 uv0)");
        expect(source).toContain("float v_n_r = gglab_sampleTexture2D_2;");
    });

    it("refuses a texture document on the wrong profile line against the v2 descriptor", () => {
        // Document on the v1 profile line against the descriptor that serves
        // the v2 line: the profile line must match, never be upgraded
        // implicitly.
        const document = textureDocument();
        document["profileVersion"] = 1;
        const result = emitParsedAgainstV2(JSON.stringify(document));
        expect(result.ok).toBe(false);
        expect(result.source).toBe("");
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.ProfileMismatch, severity: "error", dataPath: "$" }),
        ]);
    });

    it("refuses a profileVersion 2 document against a descriptor that does not serialize the required contract", () => {
        // The descriptor declares the v2 profile line but serializes it with
        // descriptorVersion 1, which cannot express the texture-signature
        // contract the v2 line requires: incompatible on capability, not on
        // version numbers (the axes stay independent).
        const raw = JSON.parse(JSON.stringify(canonicalV1Fixture));
        raw["profileVersion"] = 2;
        const mismatched = parseSurfaceProfileDescriptor(JSON.stringify(raw));
        expect(mismatched.ok).toBe(true); // parsing understands the serialization
        if (mismatched.value === null) {
            throw new Error("expected the descriptor to parse");
        }
        const document = textureDocument();
        const result = emitParsedAgainst(document, mismatched.value);
        expect(result.ok).toBe(false);
        expect(result.source).toBe("");
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.ProfileMismatch,
                severity: "error",
                dataPath: "$",
                message: expect.stringContaining("requires the generated texture-signature contract"),
            }),
        ]);
    });

    it("emits texture sampling for a profileVersion 1 document served by a v2-serialization descriptor", () => {
        // Independent axes in one direction: the descriptor declares the
        // v1 profile line (matching the document) while serializing its
        // contract with descriptorVersion 2. Emission is contract-driven:
        // the requested line does not demand the texture contract, nothing
        // forbids it, and the descriptor supplies it — so it works.
        const raw = JSON.parse(JSON.stringify(canonicalV2Fixture));
        raw["profileVersion"] = 1;
        const served = parseSurfaceProfileDescriptor(JSON.stringify(raw));
        expect(served.ok).toBe(true);
        if (served.value === null) {
            throw new Error("expected the descriptor to parse");
        }
        const document = textureDocument();
        document["profileVersion"] = 1;
        const result = emitParsedAgainst(document, served.value);
        expect(result.ok).toBe(true);
        expect(result.source).toContain("float4 v_n_smp = gglab_sampleTexture2D(v_n_tp, v_n_uv);");
        expect(result.source).toContain("SamplerState sampler = SamplerDescriptorHeap[NonUniformResourceIndex(textureSamplerBinding.y)];");
    });

    function emitParsedAgainst(document: Record<string, unknown>, descriptor: SurfaceProfileDescriptor): HlslEmission {
        const parsed = parseShaderGraphDocument(JSON.stringify(document));
        if (!parsed.ok || parsed.value === null) {
            throw new Error(`expected a parseable document: ${JSON.stringify(parsed.diagnostics)}`);
        }
        return emitHlsl(parsed.value, descriptor);
    }

    it("propagates validation failures without emitting", () => {
        const result = emitVariant((document) => {
            document["connections"] = (document["connections"] as Record<string, unknown>[]).filter(
                (connection) => connection["id"] !== "c4",
            );
        });
        expect(result.ok).toBe(false);
        expect(result.source).toBe("");
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.MissingRequiredInput, severity: "error" }),
        );
    });

    it("refuses a parameter concrete type the profile's class does not permit", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.pair",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [
                // Authored "float" on a Vector entry: the gglab.surface v1
                // Vector class permits float2/float3/float4 only.
                { id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float" },
                { id: "p.metal", name: "M", class: "ScalarParameter", valueType: "float" },
            ],
            nodes: [
                { id: "n.t", type: "VectorParameter", version: 1, properties: { parameterId: "p.tint" } },
                { id: "n.sf", type: "ScalarParameter", version: 1, properties: { parameterId: "p.metal" } },
                { id: "n.e", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
                { id: "n.r", type: "Float", version: 1, properties: { value: 0.5 } },
                { id: "n.o", type: "Float", version: 1, properties: { value: 1 } },
                { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } },
                { id: "c2", from: { nodeId: "n.e", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
                { id: "c3", from: { nodeId: "n.sf", portId: "value" }, to: { nodeId: "n.out", portId: "Metallic" } },
                { id: "c4", from: { nodeId: "n.r", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
                { id: "c5", from: { nodeId: "n.o", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const result = emitParsed(JSON.stringify(document));
        expect(result.ok).toBe(false);
        expect(result.source).toBe("");
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.UnsupportedParameterType,
                severity: "error",
                dataPath: "$.parameters[0]",
            }),
        ]);
    });

    it("still rejects mixed vector operands once the parameter type is authored", () => {
        // The former under-constrained scenario with an explicit "float3":
        // the failure now surfaces where it belongs — the operation's type
        // rule — not as a parameter guess.
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.mixed",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [
                { id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float3" },
                { id: "p.metal", name: "M", class: "ScalarParameter", valueType: "float" },
            ],
            nodes: [
                { id: "n.t", type: "VectorParameter", version: 1, properties: { parameterId: "p.tint" } },
                { id: "n.mf", type: "Multiply", version: 1, properties: {} },
                { id: "n.f2", type: "Float2", version: 1, properties: { value: [1, 1] } },
                { id: "n.e", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
                { id: "n.sf", type: "ScalarParameter", version: 1, properties: { parameterId: "p.metal" } },
                { id: "n.r", type: "Float", version: 1, properties: { value: 0.5 } },
                { id: "n.o", type: "Float", version: 1, properties: { value: 1 } },
                { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.mf", portId: "a" } },
                { id: "c2", from: { nodeId: "n.f2", portId: "value" }, to: { nodeId: "n.mf", portId: "b" } },
                { id: "c3", from: { nodeId: "n.mf", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } },
                { id: "c4", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
                { id: "c5", from: { nodeId: "n.sf", portId: "value" }, to: { nodeId: "n.out", portId: "Metallic" } },
                { id: "c6", from: { nodeId: "n.r", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
                { id: "c7", from: { nodeId: "n.o", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const result = emitParsed(JSON.stringify(document));
        expect(result.ok).toBe(false);
        expect(result.source).toBe("");
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.TypeMismatch,
                severity: "error",
                dataPath: "$.nodes[1]",
            }),
        ]);
    });

    it("emits an authored float3 vector parameter multiplied by a float scalar into BaseColor", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.vecmul",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [{ id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float3" }],
            nodes: [
                { id: "n.t", type: "VectorParameter", version: 1, properties: { parameterId: "p.tint" } },
                { id: "n.f", type: "Float", version: 1, properties: { value: 0.5 } },
                { id: "n.m", type: "Multiply", version: 1, properties: {} },
                { id: "n.c", type: "Float3", version: 1, properties: { value: [0, 0, 1] } },
                { id: "n.o", type: "Float", version: 1, properties: { value: 1 } },
                { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.m", portId: "a" } },
                { id: "c2", from: { nodeId: "n.f", portId: "value" }, to: { nodeId: "n.m", portId: "b" } },
                { id: "c3", from: { nodeId: "n.m", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } },
                { id: "c4", from: { nodeId: "n.c", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
                { id: "c5", from: { nodeId: "n.f", portId: "value" }, to: { nodeId: "n.out", portId: "Metallic" } },
                { id: "c6", from: { nodeId: "n.f", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
                { id: "c7", from: { nodeId: "n.o", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const result = emitParsed(JSON.stringify(document));
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        const source = result.source;
        expect(source).toContain("float3 gglab_p_tint,");
        // The operation rule: authored float3 operand with a float scalar
        // widens to float3, which is exactly what BaseColor requires.
        expect(source).toContain("float3 v_n_m = v_n_t * v_n_f;");
        expect(source).toContain("surface.BaseColor = v_n_m;");
        expect(result.sourceMap).not.toBeNull();
    });

    it("fails explicitly when an authored float2 is wired to a float3 required output", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.f2root",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [{ id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float2" }],
            nodes: [
                { id: "n.t", type: "VectorParameter", version: 1, properties: { parameterId: "p.tint" } },
                { id: "n.e", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
                { id: "n.meta", type: "Float", version: 1, properties: { value: 0.5 } },
                { id: "n.rough", type: "Float", version: 1, properties: { value: 0.25 } },
                { id: "n.o", type: "Float", version: 1, properties: { value: 1 } },
                { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
            ],
            connections: [
                { id: "c1", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } },
                { id: "c2", from: { nodeId: "n.e", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
                { id: "c3", from: { nodeId: "n.meta", portId: "value" }, to: { nodeId: "n.out", portId: "Metallic" } },
                { id: "c4", from: { nodeId: "n.rough", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
                { id: "c5", from: { nodeId: "n.o", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
            ],
            editorMetadata: { nodes: {} },
        };
        const result = emitParsed(JSON.stringify(document));
        expect(result.ok).toBe(false);
        expect(result.source).toBe("");
        // Location authority is the output node that owns the required
        // output (n.out, index 5), naming the offending source.
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.TypeMismatch,
                severity: "error",
                dataPath: "$.nodes[5]",
            }),
        ]);
    });

    it("reports a second output node as an ambiguous output root", () => {
        const result = emitVariant((document) => {
            (document["nodes"] as Record<string, unknown>[]).push({ id: "n.out2", type: "SurfaceOutput", version: 1, properties: {} });
            const connections = document["connections"] as Record<string, unknown>[];
            connections.forEach((connection) => {
                const target = (connection["to"] as Record<string, unknown>)["nodeId"];
                if (target === "n.out") {
                    connections.push({
                        id: `${connection["id"]}_2`,
                        from: connection["from"],
                        to: { nodeId: "n.out2", portId: (connection["to"] as Record<string, unknown>)["portId"] },
                    });
                }
            });
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.AmbiguousOutputRoot, severity: "error", dataPath: "$" }),
        ]);
    });

    it("rejects a descriptor whose profile does not match the document", () => {
        const result = emitVariant((document) => {
            document["profile"] = "gglab.fresnel";
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.ProfileMismatch, severity: "error", dataPath: "$" }),
        ]);
    });

    it("propagates topology cycle failures", () => {
        const document: Record<string, unknown> = {
            schemaVersion: 1,
            graphId: "graph.cycle-emit",
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
        const result = emitParsed(JSON.stringify(document));
        expect(result.ok).toBe(false);
        expect(result.source).toBe("");
        // The cycle plus the four unconnected required inputs of the output
        // node are all surfaced by the validation gate.
        expect(result.diagnostics).toHaveLength(5);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.CycleDetected, severity: "error" }),
        );
    });

    it("refuses a live node whose version is outside its definition's supported range", () => {
        const result = emitVariant((document) => {
            const nodes = document["nodes"] as Record<string, unknown>[];
            const float = nodes.find((node) => node["id"] === "n.c");
            if (float !== undefined) {
                float["version"] = 2; // v1 supports 1..1 only
            }
        });
        expect(result.ok).toBe(false);
        expect(result.source).toBe("");
        expect(result.sourceMap).toBeNull();
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.UnknownNodeVersion,
                severity: "error",
                dataPath: "$.nodes[2]",
            }),
        ]);
    });

    it("refuses a parameter node whose class does not match the referenced parameter entry", () => {
        const result = emitVariant((document) => {
            const parameters = document["parameters"] as Record<string, unknown>[];
            // n.sf is a ScalarParameter node referencing "p.metal";
            // redeclare that entry as a VectorParameter.
            expectElement(parameters, 1)["class"] = "VectorParameter";
        });
        expect(result.ok).toBe(false);
        expect(result.sourceMap).toBeNull();
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.ParameterClassMismatch,
                severity: "error",
                dataPath: "$.nodes[1]",
            }),
        ]);
    });

    it("carries structural validation warnings through on successful emission", () => {
        const result = emitVariant((document) => {
            // A dead node of unknown type: warning, never on the live path.
            (document["nodes"] as Record<string, unknown>[]).push({ id: "n.ghost", type: "MysteryNode", version: 1, properties: {} });
        });
        expect(result.ok).toBe(true);
        expect(result.sourceMap).not.toBeNull();
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnknownNodeType, severity: "warning" }),
        );
    });

    it("does not let a dead type failure block emission", () => {
        const result = emitVariant((document) => {
            const nodes = document["nodes"] as Record<string, unknown>[];
            const connections = document["connections"] as Record<string, unknown>[];
            // A disconnected experiment with mixed vector sizes: visible in
            // the whole-document domain, but the emitter resolves only the
            // live slice, so dead authoring content never blocks
            // compilation.
            nodes.push(
                { id: "n.d2", type: "Float2", version: 1, properties: { value: [1, 1] } },
                { id: "n.d3", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
                { id: "n.dm", type: "Multiply", version: 1, properties: {} },
            );
            connections.push(
                { id: "cdead1", from: { nodeId: "n.d2", portId: "value" }, to: { nodeId: "n.dm", portId: "a" } },
                { id: "cdead2", from: { nodeId: "n.d3", portId: "value" }, to: { nodeId: "n.dm", portId: "b" } },
            );
        });
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        expect(result.source).toContain("surface.BaseColor = v_n_c;");
        expect(result.source).toContain("surface.Emissive = v_n_t;");
        expect(result.sourceMap).not.toBeNull();
    });
});
