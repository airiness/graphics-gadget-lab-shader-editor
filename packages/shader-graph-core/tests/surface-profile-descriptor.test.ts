import { describe, expect, it } from "vitest";
import {
    DiagnosticCode,
    parseSurfaceProfileDescriptor,
} from "../src/index.js";
import type { ParseResult, SurfaceProfileDescriptor } from "../src/index.js";
import { canonicalV1Fixture } from "./fixtures/descriptor-v1.js";

const canonicalV1Json = JSON.stringify(canonicalV1Fixture);

function parseVariant(mutate: (fixture: Record<string, unknown>) => void): ParseResult<SurfaceProfileDescriptor> {
    const fixture: Record<string, unknown> = JSON.parse(canonicalV1Json);
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

    it("rejects an out-of-range descriptor version before interpreting any field", () => {
        const result = parseVariant((fixture) => {
            fixture["descriptorVersion"] = 2;
        });
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
