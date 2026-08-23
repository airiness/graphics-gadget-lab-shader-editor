/**
 * Golden graphs — the fixed content scenes for the editor and the
 * toolchain alike (the fixtures live with the semantic owner, in
 * shader-graph-core's test assets, and are referenced at that stable
 * path so every smoke test screenshots the SAME scene).
 *
 * SurfaceTextureGolden.shadergraph is the ONE fully-legal surface graph
 * that exercises the broadest slice of editor capability: the whole
 * parameter vocabulary (scalar, vector, texture), UV, a sample with
 * typed channel outputs, the math set, FAN-OUT from one output into
 * several inputs, and all five SurfaceOutput inputs. Opening it must be
 * a clean session: zero diagnostics of any severity, and a successful,
 * deterministic HLSL emission (the SHA-256 below is the durable
 * fingerprint of its generated source — a regression is a byte-level
 * difference, not a "it still compiles" hand-wave).
 *
 * SurfaceDiagnostics.shadergraph is its deliberate dark twin: the same
 * node vocabulary wired into as many distinct semantic defects as the
 * catalog allows, so the diagnostics panel always has a scene with real
 * material to render. It must stay OPENABLE (structural references
 * resolve — the panel, not a load failure, is the scene) and must REFUSE
 * emission with the structured error set.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    DiagnosticCode,
    emitHlsl,
    parseShaderGraphDocument,
    parseSurfaceProfileDescriptor,
    sha256Hex,
    utf8Encode,
    validateShaderGraph,
} from "@gglab/shader-graph-core";
import type { ShaderGraphDocument, SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { canonicalV1Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v1.js";
import { canonicalV2Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v2.js";

const CORE_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/shader-graph-core/tests/fixtures");

function fixture(name: string): string {
    return readFileSync(join(CORE_FIXTURES, name), "utf8");
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
    // SHA-256 of the exact HLSL bytes; lower-case hex).
    const GOLDEN_SOURCE_FINGERPRINT = "d37062da11f32ee2bb7c738661b81757c811241e5399a242874333f3e27c145d";

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

    it("is the broadest-coverage scene: every parameter class, UV, sampling, math, fan-out, and all surface inputs", () => {
        const document = expectParsed(golden);
        const types = document.nodes.map((node) => node.type).sort();
        expect(types).toEqual(
            [
                "Lerp",
                "Multiply",
                "OneMinus",
                "SampleTexture2D",
                "Saturate",
                "Saturate",
                "ScalarParameter",
                "ScalarParameter",
                "ScalarParameter",
                "ScalarParameter",
                "ScalarParameter",
                "SurfaceOutput",
                "Texture2DParameter",
                "UV0",
                "VectorParameter",
            ].sort(),
        );
        expect(document.parameters).toHaveLength(7);
        const classes = document.parameters.map((entry) => entry.class).sort();
        expect(classes).toEqual(["ScalarParameter", "ScalarParameter", "ScalarParameter", "ScalarParameter", "ScalarParameter", "Texture2DParameter", "VectorParameter"]);
        // Fan-out: one output feeding TWO inputs (the Lerp result drives
        // both the BaseColor clamp and the emissive mix).
        const fanSources = document.connections.filter((entry) => entry.from.nodeId === "n.mix" && entry.from.portId === "value").length;
        expect(fanSources).toBe(2);
        // All five SurfaceOutput inputs are claimed exactly once.
        const inputClaims = document.connections.filter((entry) => entry.to.nodeId === "n.out").map((entry) => entry.to.portId).sort();
        expect(inputClaims).toEqual(["BaseColor", "Emissive", "Metallic", "Opacity", "Roughness"]);
    });

    it("emits HLSL deterministically with the durable fingerprint (v2 profile)", () => {
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
        // The sampling contract is really in the source, not just claimed.
        expect(first.source).toContain("gglab_sampleTexture2D");
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
