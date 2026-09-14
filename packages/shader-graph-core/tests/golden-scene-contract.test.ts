/**
 * Golden graphs — the fixed content scenes for the editor and the
 * toolchain alike. This file is the CORE's home for them: what the
 * graphs MEAN (parse strictness, validation vocabulary, and the
 * deterministic emission fingerprint) is core contract; how they
 * project visually is the editor's, and lives in the editor tests.
 *
 * SurfaceTextureGolden.shadergraph is the ONE fully-legal surface graph
 * that exercises the broadest slice of shader authoring: the whole
 * parameter vocabulary (texture / vector / scalar), UV, a sample whose
 * typed channel outputs are all consumed for what they are —
 *
 *   Texture → SampleTexture2D,  UV0 → uv
 *   RGB (float3) → BaseColor path AND Emissive path (the fan-out)
 *   R   (float)  → Metallic
 *   G   (float)  → Roughness
 *   A   (float)  → Opacity
 *
 * — with the math set propagating over the RGB paths and all five
 * SurfaceOutput inputs claimed. Opening it must be a clean session
 * (zero diagnostics of any severity) and its HLSL emission must be
 * byte-durable: the SHA-256 below is the fingerprint. The B channel
 * and RGBA are deliberately left to the core unit tests — the golden
 * is a scene, not a circuit-board.
 *
 * SurfaceDiagnostics.shadergraph is its deliberate dark twin: the same
 * catalog wired into as many distinct semantic defects as possible, so
 * the diagnostics panel always has a scene with real material to
 * render. It must stay OPENABLE (structural references resolve — the
 * panel, not a load failure, is the scene) and must REFUSE emission
 * with the structured error set.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    DiagnosticCode,
    emitHlsl,
    parseShaderGraphDocument,
    parseSurfaceProfileDescriptor,
    sha256Hex,
    utf8Encode,
    validateShaderGraph,
} from "../src/index.js";
import type { ShaderGraphDocument, SurfaceProfileDescriptor } from "../src/index.js";
import { canonicalV1Fixture } from "./fixtures/descriptor-v1.js";
import { canonicalV2Fixture } from "./fixtures/descriptor-v2.js";

function fixture(name: string): string {
    return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const parsedV1Descriptor = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV1Fixture));
if (parsedV1Descriptor.value === null) {
    throw new Error("expected the canonical v1 descriptor fixture to parse");
}
const v1Descriptor: SurfaceProfileDescriptor = parsedV1Descriptor.value;

const parsedV2Descriptor = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV2Fixture));
if (parsedV2Descriptor.value === null) {
    throw new Error("expected the canonical v2 descriptor fixture to parse");
}
const v2Descriptor: SurfaceProfileDescriptor = parsedV2Descriptor.value;

function expectParsed(raw: string): ShaderGraphDocument {
    const parsed = parseShaderGraphDocument(raw);
    if (!parsed.ok || parsed.value === null) {
        throw new Error(`expected a parseable document: ${JSON.stringify(parsed.diagnostics)}`);
    }
    return parsed.value;
}

describe("SurfaceTextureGolden.shadergraph", () => {
    const golden = fixture("SurfaceTextureGolden.shadergraph");
    // The durable fingerprint of the golden's generated source (the
    // SHA-256 of the exact HLSL bytes; lower-case hex). A change is a
    // content- or lowering-level decision, never a silent drift.
    const GOLDEN_SOURCE_FINGERPRINT = "ab14a2d526925a56a3b41e64eb4558905e12c2fa26f8a287cb3ef91eba17e7ba";

    it("opens as a fully legal v2 graph: zero diagnostics of any severity", () => {
        const parsed = parseShaderGraphDocument(golden);
        expect(parsed.ok).toBe(true);
        expect(parsed.value).not.toBeNull();
        // "0 errors" is the floor; the golden demands NO diagnostics at
        // all — a warning is a defect in the scene, not in the tool.
        expect(parsed.diagnostics).toEqual([]);
        const document = expectParsed(golden);
        expect(validateShaderGraph(document).diagnostics).toEqual([]);
    });

    it("consumes the sample's typed channels for what they are: RGB float3 paths, R/G/A float scalars, no B", () => {
        const document = expectParsed(golden);
        // The broadest-coverage node set (texture, vector, scalar,
        // UV, sample, math, output).
        expect(document.nodes.map((node) => node.type).sort()).toEqual(
            ["Lerp", "Multiply", "SampleTexture2D", "Saturate", "Saturate", "ScalarParameter", "ScalarParameter", "SurfaceOutput", "Texture2DParameter", "UV0", "VectorParameter"].sort(),
        );
        expect(document.parameters).toHaveLength(4);
        expect(document.parameters.map((entry) => entry.class).sort()).toEqual(["ScalarParameter", "ScalarParameter", "Texture2DParameter", "VectorParameter"]);
        // The typed channel outputs, each consumed exactly once — the
        // frozen SampleTexture2D contract exercised channel by channel.
        const sampleOutputs = document.connections.filter((entry) => entry.from.nodeId === "n.sample").map((entry) => entry.from.portId).sort();
        expect(sampleOutputs).toEqual(["A", "G", "R", "RGB", "RGB"]);
        // RGB (float3) is the FAN-OUT: one output drives BOTH the
        // BaseColor path and the Emissive path (Lerp.a of each).
        const rgbTargets = document.connections
            .filter((entry) => entry.from.nodeId === "n.sample" && entry.from.portId === "RGB")
            .map((entry) => entry.to.portId)
            .sort();
        expect(rgbTargets).toEqual(["a", "a"]);
        // ...while the float channels land on the float surface inputs:
        const scalarChannelTargets = document.connections
            .filter((entry) => entry.from.nodeId === "n.sample" && entry.from.portId !== "RGB")
            .map((entry) => [entry.from.portId, entry.to.portId])
            .sort();
        expect(scalarChannelTargets).toEqual([
            ["A", "Opacity"],
            ["G", "Roughness"],
            ["R", "Metallic"],
        ]);
        // And the graph never consumes B or RGBA (deliberate: the
        // six-output matrix belongs to the core unit tests, not to the
        // scene).
        expect(sampleOutputs).not.toContain("B");
        expect(sampleOutputs).not.toContain("RGBA");
        // All five SurfaceOutput inputs are claimed exactly once.
        const inputClaims = document.connections.filter((entry) => entry.to.nodeId === "n.out").map((entry) => entry.to.portId).sort();
        expect(inputClaims).toEqual(["BaseColor", "Emissive", "Metallic", "Opacity", "Roughness"]);
    });

    it("emits HLSL deterministically with the durable fingerprint (v2 profile), channel lowering included", () => {
        const document = expectParsed(golden);
        const first = emitHlsl(document, v2Descriptor);
        expect(first.ok).toBe(true);
        expect(first.source).not.toHaveLength(0);
        expect(first.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
        const map = first.sourceMap;
        expect(map).not.toBeNull();
        // The identity is the SHA-256 of the EXACT bytes (self-consistency)…
        expect(map?.generatedSourceIdentity).toBe(sha256Hex(utf8Encode(first.source)));
        // …and of the canonical generated source of THIS graph (durable
        // fingerprint — a change here is a content-level decision).
        expect(map?.generatedSourceIdentity).toBe(GOLDEN_SOURCE_FINGERPRINT);
        // The sample is in the source (helper contract)…
        expect(first.source).toContain("gglab_sampleTexture2D");
        // …and the channels the graph CONSUMED lowered visibly: .r/.g/.a
        // are there (R/G/A feed Metallic/Roughness/Opacity), .b is NOT
        // (the graph consumes no B channel) — the lowering mirrors the
        // wiring, it is not a constant template.
        expect(/\b\.r\b/.test(first.source)).toBe(true);
        expect(/\b\.g\b/.test(first.source)).toBe(true);
        expect(/\b\.a\b/.test(first.source)).toBe(true);
        expect(/\b\.b\b/.test(first.source)).toBe(false);
        // Deterministic: the second emission is byte-identical.
        expect(emitHlsl(document, v2Descriptor).sourceMap?.generatedSourceIdentity).toBe(map?.generatedSourceIdentity);
    });
});

describe("SurfaceDiagnostics.shadergraph", () => {
    const diagnosticsJson = fixture("SurfaceDiagnostics.shadergraph");

    it("opens as a session document (structural references resolve) and then exposes EVERY semantic defect, structured", () => {
        // The scene is deliberately semantically broken but structurally
        // sound: the graph OPENS (the diagnostics panel has real material
        // to render) and then the core's validation names each defect with
        // its stable code and severity — nothing free-form, nothing silent.
        const parsed = parseShaderGraphDocument(diagnosticsJson);
        expect(parsed.ok).toBe(true); // the parse layer sees no reference break
        expect(parsed.value).not.toBeNull();
        // ...and the parse-level warnings are fully structured too.
        expect(parsed.diagnostics.every((entry) => entry.severity === "warning")).toBe(true);
        const document = expectParsed(diagnosticsJson);
        const report = validateShaderGraph(document);
        const byCode = new Map<string, string[]>();
        for (const entry of report.diagnostics) {
            const severities = byCode.get(entry.code) ?? [];
            severities.push(entry.severity);
            byCode.set(entry.code, severities);
        }
        expect(byCode.get(DiagnosticCode.TypeMismatch)).toContain("error"); // Float → float3 Emissive
        expect(byCode.get(DiagnosticCode.MissingRequiredInput)).toContain("error"); // BaseColor never claimed
        expect(byCode.get(DiagnosticCode.CycleDetected)).toContain("error"); // Add ⇄ Multiply
        expect(byCode.get(DiagnosticCode.DuplicateConnection)).toContain("error"); // dupA / dupB
        expect(byCode.get(DiagnosticCode.UnknownPort)).toContain("error"); // SurfaceOutput has no "Albedo"
        expect(byCode.get(DiagnosticCode.UnresolvedParameterReference)).toContain("error"); // p.doesNotExist
        expect(byCode.get(DiagnosticCode.UnknownNodeType)).toContain("warning"); // BogusOp: preserved, warned
        for (const entry of report.diagnostics) {
            expect(entry.dataPath.length).toBeGreaterThan(0);
            expect(entry.message.length).toBeGreaterThan(0);
        }
    });

    it("refuses emission with the structured error set — a semantically broken graph never ships HLSL", () => {
        const document = expectParsed(diagnosticsJson);
        const emission = emitHlsl(document, v1Descriptor);
        expect(emission.ok).toBe(false);
        expect(emission.source).toBe("");
        expect(emission.sourceMap).toBeNull();
        const errors = emission.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.code as string);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors).toContain(DiagnosticCode.TypeMismatch);
        expect(errors).toContain(DiagnosticCode.MissingRequiredInput);
        expect(errors).toContain(DiagnosticCode.CycleDetected);
    });
});


it("emits the neon reactor sample within the frozen two-parameter Preview contract", () => {
    const graph = expectParsed(fixture("surface-neon-reactor-preview.shadergraph"));
    expect(validateShaderGraph(graph).diagnostics).toEqual([]);
    expect(graph.parameters.map(p => [p.id, p.class, p.valueType])).toEqual([
        ["p.rough", "ScalarParameter", "float"], ["p.tex", "Texture2DParameter", "Texture2D"],
    ]);
    const emission = emitHlsl(graph, v2Descriptor);
    expect(emission.ok).toBe(true);
    expect(emission.diagnostics).toEqual([]);
});
