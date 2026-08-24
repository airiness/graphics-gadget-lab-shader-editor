import { describe, expect, it } from "vitest";
import { checkProfileConformance, DiagnosticCode, parseShaderGraphDocument, parseSurfaceProfileDescriptor } from "../src/index.js";
import type { ProfileConformance, SurfaceProfileDescriptor } from "../src/index.js";
import { canonicalV1Fixture } from "./fixtures/descriptor-v1.js";

function conformance(parameters: Record<string, unknown>[]): ProfileConformance {
    const descriptor = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV1Fixture));
    if (!descriptor.ok || descriptor.value === null) {
        throw new Error("fixture descriptor did not parse");
    }
    const parsed = parseShaderGraphDocument(
        JSON.stringify({
            schemaVersion: 1,
            graphId: "graph.conformance",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters,
            nodes: [],
            connections: [],
            editorMetadata: { nodes: {} },
        }),
    );
    if (!parsed.ok || parsed.value === null) {
        throw new Error(`document did not parse: ${JSON.stringify(parsed.diagnostics)}`);
    }
    return checkProfileConformance(parsed.value, descriptor.value as SurfaceProfileDescriptor);
}

describe("checkProfileConformance", () => {
    it("passes conformant (class, valueType) pairs and reports the verdicts", () => {
        const result = conformance([
            { id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float3" },
            { id: "p.metal", name: "M", class: "ScalarParameter", valueType: "float" },
        ]);
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        // Canonical (stable-id) order, not serialization order.
        expect(result.parameters.map((entry) => entry.parameterId)).toEqual(["p.metal", "p.tint"]);
        for (const entry of result.parameters) {
            expect(entry.conformant).toBe(true);
            expect(entry.resourceClass).toBe(false);
            expect(entry.valueType).toBeDefined();
        }
    });

    it("refuses a valueType the profile's class does not permit", () => {
        const result = conformance([{ id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float" }]);
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.UnsupportedParameterType,
                severity: "error",
                dataPath: "$.parameters[0]",
            }),
        ]);
        expect(result.parameters[0]).toEqual(expect.objectContaining({ parameterId: "p.tint", conformant: false, resourceClass: false }));
    });

    it("refuses a deferred class of the descriptor with a structured diagnostic", () => {
        const result = conformance([{ id: "p.flag", name: "Flag", class: "BoolParameter", valueType: "float" }]);
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.UnsupportedParameterClass,
                severity: "error",
                dataPath: "$.parameters[0]",
                message: expect.stringContaining("deferred"),
            }),
        ]);
        expect(result.parameters[0]).toEqual(expect.objectContaining({ parameterId: "p.flag", conformant: false }));
    });

    it("reports a class the descriptor does not define", () => {
        const result = conformance([{ id: "p.x", name: "X", class: "MysteryParameter", valueType: "float" }]);
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.UnsupportedParameterClass,
                severity: "error",
                dataPath: "$.parameters[0]",
                message: expect.stringContaining("does not define"),
            }),
        ]);
    });

    it("checks the resource class pairing and reports it as a resource", () => {
        const conformant = conformance([{ id: "p.tex", name: "Texture", class: "Texture2DParameter", valueType: "Texture2D" }]);
        expect(conformant.ok).toBe(true);
        expect(conformant.parameters[0]).toEqual(
            expect.objectContaining({ parameterId: "p.tex", valueType: "Texture2D", conformant: true, resourceClass: true }),
        );

        const mismatched = conformance([{ id: "p.tex", name: "Texture", class: "Texture2DParameter", valueType: "float" }]);
        expect(mismatched.ok).toBe(false);
        expect(mismatched.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnsupportedParameterType, severity: "error", dataPath: "$.parameters[0]" }),
        ]);
        expect(mismatched.parameters[0]).toEqual(expect.objectContaining({ conformant: false, resourceClass: true }));
    });

    it("orders diagnostics in canonical id order, not serialization order", () => {
        // Serialization order: p.z first, p.a second. Both pairs are bad,
        // so canonical order must put p.a's diagnostic first while keeping
        // each diagnostic at its authoritative parameters[] index.
        const result = conformance([
            { id: "p.z", name: "Z", class: "VectorParameter", valueType: "float" },
            { id: "p.a", name: "A", class: "VectorParameter", valueType: "float" },
        ]);
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toHaveLength(2);
        expect(result.diagnostics[0]).toEqual(expect.objectContaining({ dataPath: "$.parameters[1]" }));
        expect(result.diagnostics[1]).toEqual(expect.objectContaining({ dataPath: "$.parameters[0]" }));
    });
});
