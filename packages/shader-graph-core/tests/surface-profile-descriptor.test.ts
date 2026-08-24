import { describe, expect, it } from "vitest";
import {
    DiagnosticCode,
    parseSurfaceProfileDescriptor,
} from "../src/index.js";
import type { ParseResult, SurfaceProfileDescriptor } from "../src/index.js";
import { canonicalV1Fixture } from "./fixtures/descriptor-v1.js";
import { canonicalV2Fixture } from "./fixtures/descriptor-v2.js";

const canonicalV1Json = JSON.stringify(canonicalV1Fixture);
const canonicalV2Json = JSON.stringify(canonicalV2Fixture);

function parseVariant(mutate: (fixture: Record<string, unknown>) => void, canonicalJson: string = canonicalV1Json): ParseResult<SurfaceProfileDescriptor> {
    const fixture: Record<string, unknown> = JSON.parse(canonicalJson);
    mutate(fixture);
    return parseSurfaceProfileDescriptor(JSON.stringify(fixture));
}

function expectParsed(value: SurfaceProfileDescriptor | null): SurfaceProfileDescriptor {
    if (value === null) {
        throw new Error("expected a parsed descriptor");
    }
    return value;
}

function expectElement<T>(elements: readonly T[], index: number): T {
    const element = elements[index];
    if (element === undefined) {
        throw new Error(`expected array element ${index}`);
    }
    return element;
}

describe("parseSurfaceProfileDescriptor", () => {
    it("parses a v1 descriptor with the canonical field set", () => {
        const result = parseSurfaceProfileDescriptor(canonicalV1Json);
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        const descriptor = expectParsed(result.value);
        expect(descriptor.descriptorVersion).toBe(1);
        expect(descriptor.profileId).toBe("gglab.surface");
        expect(descriptor.profileVersion).toBe(1);
        expect(descriptor.language).toBe("hlsl");
        expect(descriptor.generatedFunction.name).toBe("EvaluateSurface");
        expect(descriptor.generatedFunction.stage).toBe("pixel");
        expect(descriptor.generatedFunction.returnValue.objectName).toBe("SurfaceData");
        expect(descriptor.generatedFunction.returnValue.fieldsSource).toBe("requiredOutputs");
        expect(descriptor.graphVisibleInputs.map((input) => input.id)).toEqual(["uv0"]);
        expect(descriptor.requiredOutputs.map((output) => output.name)).toEqual(["BaseColor", "Emissive", "Metallic", "Roughness", "Opacity"]);
        expect(descriptor.outputFieldOrdering).toBe("descriptorListOrder");
        expect(descriptor.samplingContract.samplerResolution.cardinality).toBe("oneSamplerPerTexture2DBinding");
        expect(descriptor.requiredIncludes).toEqual([]);
        expect(descriptor.processContract.tool.identity).toBe("gglab-shaderc");
        expect(descriptor.processContract.tool.minimumVersion).toBe("1.0.0");
        expect(descriptor.processContract.tool.versionComparison).toBe("semver");
        expect(descriptor.deferred.parameterClasses).toEqual(["BoolParameter", "SamplerParameter"]);
        expect(descriptor.deferred.surfaceOutputs).toEqual(["normalTangentSpaceAuthoring"]);
    });

    it("preserves the mixed valueTypes/valueType parameter class shape", () => {
        const result = parseSurfaceProfileDescriptor(canonicalV1Json);
        expect(result.ok).toBe(true);
        const descriptor = expectParsed(result.value);
        expect(descriptor.parameterClasses.map((parameterClass) => parameterClass.class)).toEqual(["ScalarParameter", "VectorParameter", "Texture2DParameter"]);
        const scalar = descriptor.parameterClasses[0];
        const vector = descriptor.parameterClasses[1];
        const texture = descriptor.parameterClasses[2];
        expect(scalar).toEqual({ class: "ScalarParameter", valueTypes: ["float"] });
        expect(vector).toEqual({ class: "VectorParameter", valueTypes: ["float2", "float3", "float4"] });
        expect(texture).toEqual({ class: "Texture2DParameter", valueType: "Texture2D" });
    });

    it("parses a v2 descriptor with the texture-signature contract", () => {
        const result = parseSurfaceProfileDescriptor(canonicalV2Json);
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        const descriptor = expectParsed(result.value);
        expect(descriptor.descriptorVersion).toBe(2);
        expect(descriptor.profileVersion).toBe(2);
        const sampling = descriptor.samplingContract;
        if (!("generatedTextureSignature" in sampling)) {
            throw new Error("expected the v2 sampling contract shape");
        }
        expect(sampling.policy).toBe("reuseRuntimeTextureSamplerBinding");
        expect(sampling.generatedTextureSignature).toEqual({
            cardinality: "oneParameterPerTexture2DParameter",
            parameterType: "uint2",
            componentOrder: [
                { position: 0, role: "textureBindingIndex", description: "index into the shared texture resource heap" },
                { position: 1, role: "samplerBindingIndex", description: "index into the shared sampler heap" },
            ],
        });
        expect(sampling.generatedSampleForm).toEqual({
            resourceHeapBuiltin: "ResourceDescriptorHeap",
            resourceElementType: "Texture2D<float4>",
            samplerHeapBuiltin: "SamplerDescriptorHeap",
            samplerElementType: "SamplerState",
            indexScope: "NonUniformResourceIndex",
            operation: "Sample",
            coordinateType: "float2",
            resultType: "float4",
        });
    });

    it("rejects an out-of-range descriptor version before interpreting any field", () => {
        const result = parseVariant(
            (fixture) => {
                fixture["descriptorVersion"] = 3;
            },
            canonicalV2Json,
        );
        expect(result.ok).toBe(false);
        expect(result.value).toBeNull();
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.UnsupportedDescriptorVersion,
                severity: "error",
                dataPath: "$.descriptorVersion",
            }),
        ]);
    });

    it("rejects a non-integer descriptor version", () => {
        const result = parseVariant((fixture) => {
            fixture["descriptorVersion"] = 1.5;
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnexpectedType, dataPath: "$.descriptorVersion" }),
        ]);
    });

    it("reports every missing required top-level field", () => {
        const result = parseVariant((fixture) => {
            delete fixture["samplingContract"];
            delete fixture["processContract"];
            delete fixture["requiredIncludes"];
        });
        // Diagnostics are in the parser's deterministic field-traversal order.
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.MissingRequiredField, dataPath: "$.samplingContract" }),
            expect.objectContaining({ code: DiagnosticCode.MissingRequiredField, dataPath: "$.requiredIncludes" }),
            expect.objectContaining({ code: DiagnosticCode.MissingRequiredField, dataPath: "$.processContract" }),
        ]);
    });

    it("rejects unknown top-level fields explicitly", () => {
        const result = parseVariant((fixture) => {
            fixture["experimental"] = 1;
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnexpectedField, severity: "error", dataPath: "$.experimental" }),
        );
    });

    it("rejects unknown nested fields explicitly", () => {
        const result = parseVariant((fixture) => {
            (fixture["generatedFunction"] as Record<string, unknown>)["extra"] = true;
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnexpectedField, severity: "error", dataPath: "$.generatedFunction.extra" }),
        );
    });

    it("rejects a language this reader does not support", () => {
        const result = parseVariant((fixture) => {
            fixture["language"] = "wgsl";
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnsupportedLanguage, severity: "error", dataPath: "$.language" }),
        );
    });

    it("rejects an unsupported vocabulary literal with the expected value in the diagnostic", () => {
        const result = parseVariant((fixture) => {
            const sampling = fixture["samplingContract"] as Record<string, unknown>;
            (sampling["samplerResolution"] as Record<string, unknown>)["cardinality"] = "oneSamplerPerTexture";
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: DiagnosticCode.UnexpectedType,
                severity: "error",
                dataPath: "$.samplingContract.samplerResolution.cardinality",
            }),
        );
    });

    it("parses a descriptorVersion 2 file regardless of the profileVersion it declares", () => {
        // The parser answers "can I understand this serialization?"; the
        // version axes stay independent, so a v2 serialization declaring any
        // profile version parses. Compatibility with a requested profile
        // line is a capability question decided where the document and the
        // descriptor meet (emission), not here.
        const result = parseVariant(
            (fixture) => {
                fixture["profileVersion"] = 1;
            },
            canonicalV2Json,
        );
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        const descriptor = expectParsed(result.value);
        expect(descriptor.profileVersion).toBe(1);
        expect("generatedTextureSignature" in descriptor.samplingContract).toBe(true);
    });

    it("parses a descriptorVersion 1 file regardless of the profileVersion it declares", () => {
        const result = parseVariant((fixture) => {
            fixture["profileVersion"] = 2;
        });
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        const descriptor = expectParsed(result.value);
        expect("generatedTextureSignature" in descriptor.samplingContract).toBe(false);
    });

    it("rejects a descriptorVersion 2 file missing the texture-signature fields", () => {
        const result = parseVariant(
            (fixture) => {
                const sampling = fixture["samplingContract"] as Record<string, unknown>;
                delete sampling["generatedTextureSignature"];
                delete sampling["generatedSampleForm"];
            },
            canonicalV2Json,
        );
        expect(result.ok).toBe(false);
        expect(result.value).toBeNull();
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.MissingRequiredField, severity: "error", dataPath: "$.samplingContract.generatedTextureSignature" }),
            expect.objectContaining({ code: DiagnosticCode.MissingRequiredField, severity: "error", dataPath: "$.samplingContract.generatedSampleForm" }),
        ]);
    });

    it("rejects a generated sample-form literal the reader does not support", () => {
        const result = parseVariant(
            (fixture) => {
                const sampling = fixture["samplingContract"] as Record<string, unknown>;
                (sampling["generatedSampleForm"] as Record<string, unknown>)["resourceHeapBuiltin"] = "ResourceHeap";
            },
            canonicalV2Json,
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: DiagnosticCode.UnexpectedType,
                severity: "error",
                dataPath: "$.samplingContract.generatedSampleForm.resourceHeapBuiltin",
                message: 'Expected "ResourceDescriptorHeap", got "ResourceHeap".',
            }),
        );
    });

    it("rejects a texture-signature component position outside the pair slots", () => {
        const result = parseVariant(
            (fixture) => {
                const sampling = fixture["samplingContract"] as Record<string, unknown>;
                const order = (sampling["generatedTextureSignature"] as Record<string, unknown>)["componentOrder"] as Record<string, unknown>[];
                expectElement(order, 1)["position"] = 5;
            },
            canonicalV2Json,
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnexpectedType, severity: "error", dataPath: "$.samplingContract.generatedTextureSignature.componentOrder[1].position" }),
        );
    });

    it("rejects a texture-signature component role the reader does not support", () => {
        const result = parseVariant(
            (fixture) => {
                const sampling = fixture["samplingContract"] as Record<string, unknown>;
                const order = (sampling["generatedTextureSignature"] as Record<string, unknown>)["componentOrder"] as Record<string, unknown>[];
                expectElement(order, 0)["role"] = "bindingIndex";
            },
            canonicalV2Json,
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: DiagnosticCode.UnexpectedType,
                severity: "error",
                dataPath: "$.samplingContract.generatedTextureSignature.componentOrder[0].role",
                message: 'Expected role "textureBindingIndex" or "samplerBindingIndex", got "bindingIndex".',
            }),
        );
    });

    it("rejects a componentOrder whose two components declare the same role", () => {
        const result = parseVariant(
            (fixture) => {
                const sampling = fixture["samplingContract"] as Record<string, unknown>;
                const order = (sampling["generatedTextureSignature"] as Record<string, unknown>)["componentOrder"] as Record<string, unknown>[];
                expectElement(order, 1)["role"] = "textureBindingIndex";
            },
            canonicalV2Json,
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnexpectedType, severity: "error", dataPath: "$.samplingContract.generatedTextureSignature.componentOrder" }),
        );
    });

    it("rejects a componentOrder whose two components declare the same slot position", () => {
        const result = parseVariant(
            (fixture) => {
                const sampling = fixture["samplingContract"] as Record<string, unknown>;
                const order = (sampling["generatedTextureSignature"] as Record<string, unknown>)["componentOrder"] as Record<string, unknown>[];
                expectElement(order, 1)["position"] = 0;
            },
            canonicalV2Json,
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnexpectedType, severity: "error", dataPath: "$.samplingContract.generatedTextureSignature.componentOrder" }),
        );
    });

    it("rejects a generated sample form without its sampler element type", () => {
        const result = parseVariant(
            (fixture) => {
                const sampling = fixture["samplingContract"] as Record<string, unknown>;
                delete (sampling["generatedSampleForm"] as Record<string, unknown>)["samplerElementType"];
            },
            canonicalV2Json,
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.MissingRequiredField, severity: "error", dataPath: "$.samplingContract.generatedSampleForm.samplerElementType" }),
        );
    });

    it("rejects a texture-signature componentOrder that is not exactly two components", () => {
        const result = parseVariant(
            (fixture) => {
                const sampling = fixture["samplingContract"] as Record<string, unknown>;
                (sampling["generatedTextureSignature"] as Record<string, unknown>)["componentOrder"] = [{ position: 0, meaning: "texture binding index" }];
            },
            canonicalV2Json,
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnexpectedType, severity: "error", dataPath: "$.samplingContract.generatedTextureSignature.componentOrder" }),
        );
    });

    it("rejects unknown fields inside the generated texture-signature objects", () => {
        const result = parseVariant(
            (fixture) => {
                const sampling = fixture["samplingContract"] as Record<string, unknown>;
                (sampling["generatedSampleForm"] as Record<string, unknown>)["experimental"] = true;
            },
            canonicalV2Json,
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnexpectedField, severity: "error", dataPath: "$.samplingContract.generatedSampleForm.experimental" }),
        );
    });

    it("rejects the texture-signature fields on a descriptorVersion 1 file as unknown fields", () => {
        const result = parseVariant((fixture) => {
            const sampling = fixture["samplingContract"] as Record<string, unknown>;
            sampling["generatedTextureSignature"] = {
                cardinality: "oneParameterPerTexture2DParameter",
                parameterType: "uint2",
                componentOrder: [{ position: 0, meaning: "texture binding index" }, { position: 1, meaning: "sampler binding index" }],
            };
        });
        expect(result.ok).toBe(false);
        expect(result.value).toBeNull();
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnexpectedField, severity: "error", dataPath: "$.samplingContract.generatedTextureSignature" }),
        ]);
    });

    it("rejects a parameter class that declares neither valueType nor valueTypes", () => {
        const result = parseVariant((fixture) => {
            (fixture["parameterClasses"] as unknown[])["push"]({ class: "BoolParameter" });
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.MissingRequiredField, severity: "error", dataPath: "$.parameterClasses[3]" }),
        );
    });

    it("rejects a parameter class that declares both valueType and valueTypes", () => {
        const result = parseVariant((fixture) => {
            const classes = fixture["parameterClasses"] as Record<string, unknown>[];
            // classes[0] already declares valueTypes; adding the singular
            // valueType is what creates the conflicting double declaration.
            expectElement(classes, 0)["valueType"] = "float";
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnexpectedField, severity: "error", dataPath: "$.parameterClasses[0].valueTypes" }),
        );
    });

    it("reports malformed JSON input", () => {
        const result = parseSurfaceProfileDescriptor("{ not json");
        expect(result.ok).toBe(false);
        expect(result.value).toBeNull();
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.InvalidJson, severity: "error", dataPath: "$" }),
        ]);
    });

    it("rejects a non-object root", () => {
        const result = parseSurfaceProfileDescriptor("[1, 2, 3]");
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnexpectedType, severity: "error", dataPath: "$" }),
        ]);
    });
});
