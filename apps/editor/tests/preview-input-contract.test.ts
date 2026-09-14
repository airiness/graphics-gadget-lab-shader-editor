import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
    parseSurfaceProfileDescriptor,
    parseShaderGraphDocument,
    validateShaderGraph,
    emitHlsl,
    type GraphParameter,
    type ShaderGraphDocument,
    type SurfaceProfileDescriptor,
} from "@gglab/shader-graph-core";
import { canonicalV1Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v1.js";
import { canonicalV2Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v2.js";
import { selectPreviewInputContract } from "../src/preview-input-contract.js";

it.each(["surface-texture-preview.shadergraph", "surface-color-study-preview.shadergraph"])("admits %s while keeping the authoring golden distinct", name => {
    const load = (name: string) => {
        const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/shader-graph-core/tests/fixtures");
        const parsed = parseShaderGraphDocument(readFileSync(resolve(fixtures, name), "utf8"));
        expect(parsed.diagnostics).toEqual([]);
        if (!parsed.value) throw new Error("Fixture must parse");
        return parsed.value;
    };
    const sample = load(name), contract = descriptor(canonicalV2Fixture);
    expect(validateShaderGraph(sample).diagnostics).toEqual([]);
    expect(selectPreviewInputContract(sample, contract)).toMatchObject({ matched: true, contract: { id: "gglab.preview-input.surface.texture2d" } });
    expect(emitHlsl(sample, contract).ok).toBe(true);
    expect(selectPreviewInputContract(load("SurfaceTextureGolden.shadergraph"), contract)).toMatchObject({ matched: false, mismatch: { reason: "graph-parameter-count-mismatch", expected: 2, observed: 4 } });
});

function descriptor(fixture: Record<string, unknown>): SurfaceProfileDescriptor {
    const parsed = parseSurfaceProfileDescriptor(JSON.stringify(fixture));
    if (!parsed.ok || parsed.value === null) {
        throw new Error("test descriptor must parse");
    }
    return parsed.value;
}

function parameter(id: string, parameterClass: string, valueType: GraphParameter["valueType"]): GraphParameter {
    return { id, name: id, class: parameterClass, valueType, unknownFields: {} };
}

function document(profileVersion: number, parameters: readonly GraphParameter[]): ShaderGraphDocument {
    return {
        schemaVersion: 1,
        graphId: "preview-contract-test",
        profile: "gglab.surface",
        profileVersion,
        parameters,
        nodes: [],
        connections: [],
        editorMetadata: { nodes: {}, unknownFields: {} },
        unknownFields: {},
    };
}

describe("the frozen Preview input contracts", () => {
    it("selects numeric-v1 in stable-id order, independent of persisted array order", () => {
        const result = selectPreviewInputContract(
            document(1, [
                parameter("p.tint", "VectorParameter", "float3"),
                parameter("p.metal", "ScalarParameter", "float"),
            ]),
            descriptor(canonicalV1Fixture),
        );
        expect(result).toEqual({
            matched: true,
            contract: {
                id: "gglab.preview-input.surface.numeric",
                profileId: "gglab.surface",
                profileVersion: 1,
            },
        });
    });

    it("selects texture2d-v2 only with the exact parameter and uint2 binding-pair contracts", () => {
        const graph = document(2, [
            parameter("p.tex", "Texture2DParameter", "Texture2D"),
            parameter("p.rough", "ScalarParameter", "float"),
        ]);
        expect(selectPreviewInputContract(graph, descriptor(canonicalV2Fixture))).toMatchObject({
            matched: true,
            contract: { id: "gglab.preview-input.surface.texture2d" },
        });

        const changed = structuredClone(canonicalV2Fixture);
        const sampling = changed["samplingContract"] as Record<string, unknown>;
        const signature = sampling["generatedTextureSignature"] as Record<string, unknown>;
        signature["componentOrder"] = [
            { position: 0, role: "samplerBindingIndex", description: "wrong first role" },
            { position: 1, role: "textureBindingIndex", description: "wrong second role" },
        ];
        expect(selectPreviewInputContract(graph, descriptor(changed))).toMatchObject({
            matched: false,
            mismatch: { reason: "texture-binding-pair-mismatch" },
        });
    });

    it.each([
        ["name", "ShadeSurface"],
        ["stage", "vertex"],
        ["returnValue.objectName", "OtherSurfaceData"],
    ] as const)("rejects a changed generated-function %s", (field, value) => {
        // The strict descriptor reader already rejects a non-pixel stage.
        // Mutate an accepted value here so this test independently freezes
        // the downstream Preview selector's complete ABI gate as well.
        const changed = structuredClone(descriptor(canonicalV1Fixture));
        const generatedFunction = changed.generatedFunction as unknown as Record<string, unknown>;
        if (field === "returnValue.objectName") {
            const returnValue = generatedFunction["returnValue"] as Record<string, unknown>;
            returnValue["objectName"] = value;
        } else {
            generatedFunction[field] = value;
        }

        expect(
            selectPreviewInputContract(
                document(1, [
                    parameter("p.metal", "ScalarParameter", "float"),
                    parameter("p.tint", "VectorParameter", "float3"),
                ]),
                changed,
            ),
        ).toEqual({
            matched: false,
            mismatch: {
                reason: "generated-function-mismatch",
                field,
                expected:
                    field === "name"
                        ? "EvaluateSurface"
                        : field === "stage"
                          ? "pixel"
                          : "SurfaceData",
                observed: value,
            },
        });
    });

    it.each([
        [
            "stable id",
            [parameter("p.other", "ScalarParameter", "float"), parameter("p.tint", "VectorParameter", "float3")],
        ],
        [
            "class",
            [parameter("p.metal", "VectorParameter", "float"), parameter("p.tint", "VectorParameter", "float3")],
        ],
        [
            "value type",
            [parameter("p.metal", "ScalarParameter", "float"), parameter("p.tint", "VectorParameter", "float4")],
        ],
    ])("rejects a near-miss parameter %s", (_name, parameters) => {
        expect(selectPreviewInputContract(document(1, parameters), descriptor(canonicalV1Fixture))).toMatchObject({
            matched: false,
            mismatch: { reason: "graph-parameter-mismatch" },
        });
    });

    it("rejects an extra parameter and a changed graph-visible input", () => {
        const graph = document(1, [
            parameter("p.metal", "ScalarParameter", "float"),
            parameter("p.tint", "VectorParameter", "float3"),
            parameter("p.extra", "ScalarParameter", "float"),
        ]);
        expect(selectPreviewInputContract(graph, descriptor(canonicalV1Fixture))).toMatchObject({
            matched: false,
            mismatch: { reason: "graph-parameter-count-mismatch" },
        });

        const changed = structuredClone(canonicalV1Fixture);
        changed["graphVisibleInputs"] = [
            { id: "uv1", type: "float2", semantic: "wrong input" },
        ];
        expect(
            selectPreviewInputContract(
                document(1, [
                    parameter("p.metal", "ScalarParameter", "float"),
                    parameter("p.tint", "VectorParameter", "float3"),
                ]),
                descriptor(changed),
            ),
        ).toMatchObject({ matched: false, mismatch: { reason: "graph-visible-input-mismatch" } });
    });
});
