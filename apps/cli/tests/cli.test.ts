/**
 * CLI command tests — the commands are serializations of core services, so
 * these tests pin the machine contract: strict per-command grammars (no
 * silently ignored tokens), the failure-envelope invariant (payload is
 * null on failure), stable codes, the central exit-code classification
 * (0/1/2), the profile-line selection rule with explicit considered
 * surfacing, the capability-based compatibility verdict both directions,
 * and byte-deterministic emission. Fixtures are embedded (small,
 * deterministic) and mirror the core test fixtures' proven shapes.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DiagnosticCode, sha256Hex, utf8Encode } from "@gglab/shader-graph-core";
import { COMMAND_GRAMMARS, parseCommandArgs, type KnownCommand } from "../src/command-grammar.js";
import { CliCode } from "../src/envelope.js";
import { runDescriptor } from "../src/commands/descriptor.js";
import { runEmit } from "../src/commands/emit.js";
import { runValidate } from "../src/commands/validate.js";
import { classifyExitCode, main, usageText } from "../src/index.js";
import { buildEnvelope } from "../src/envelope.js";
import { serializeEnvelope } from "../src/envelope.js";

// --- proven fixture shapes (mirror the core test fixtures) ---------------

const canonicalV1Fixture: Record<string, unknown> = {
    descriptorVersion: 1,
    profileId: "gglab.surface",
    profileVersion: 1,
    language: "hlsl",
    generatedFunction: {
        name: "EvaluateSurface",
        stage: "pixel",
        returnValue: { objectName: "SurfaceData", fieldsSource: "requiredOutputs" },
        parameterContract: {
            ordering: "graphParametersThenGraphVisibleInputs",
            graphParameters: { source: "graphDocument", classConstraint: "parameterClasses" },
            graphVisibleInputs: { source: "graphVisibleInputs" },
        },
    },
    graphVisibleInputs: [{ id: "uv0", type: "float2", semantic: "primary texture coordinate supplied by the rendering pass" }],
    requiredOutputs: [
        { name: "BaseColor", type: "float3", required: true, semantic: "linear-RGB albedo contribution (pre-lighting)" },
        { name: "Emissive", type: "float3", required: true, semantic: "linear-RGB emissive contribution (pre-lighting)" },
        { name: "Metallic", type: "float", required: true, semantic: "metallic factor; BRDF interpretation is pass-owned" },
        { name: "Roughness", type: "float", required: true, semantic: "perceived roughness factor; BRDF clamping is pass-owned" },
        { name: "Opacity", type: "float", required: true, semantic: "raw surface alpha before alpha-mode resolution; alpha mode, cutoff, and discard are pass-owned" },
    ],
    outputFieldOrdering: "descriptorListOrder",
    parameterClasses: [
        { class: "ScalarParameter", valueTypes: ["float"] },
        { class: "VectorParameter", valueTypes: ["float2", "float3", "float4"] },
        { class: "Texture2DParameter", valueType: "Texture2D" },
    ],
    resourceClasses: [{ class: "Texture2D", sampledType: "float4" }],
    samplingContract: {
        policy: "reuseRuntimeTextureSamplerBinding",
        appliesToResourceClass: "Texture2D",
        samplerAuthoring: "deferred",
        samplerResolution: { owner: "materialBindingLayer", cardinality: "oneSamplerPerTexture2DBinding" },
        authorableFilterModes: [],
        authorableAddressModes: [],
        comparisonSamplerAuthoring: "deferred",
    },
    requiredIncludes: [],
    processContract: { tool: { identity: "gglab-shaderc", minimumVersion: "1.0.0", versionComparison: "semver" } },
    deferred: { parameterClasses: ["BoolParameter", "SamplerParameter"], surfaceOutputs: ["normalTangentSpaceAuthoring"] },
};

const canonicalV2Fixture: Record<string, unknown> = {
    ...canonicalV1Fixture,
    descriptorVersion: 2,
    profileVersion: 2,
    samplingContract: {
        ...((canonicalV1Fixture["samplingContract"] as Record<string, unknown>) ?? {}),
        generatedTextureSignature: {
            cardinality: "oneParameterPerTexture2DParameter",
            parameterType: "uint2",
            componentOrder: [
                { position: 0, role: "textureBindingIndex", description: "index into the shared texture resource heap" },
                { position: 1, role: "samplerBindingIndex", description: "index into the shared sampler heap" },
            ],
        },
        generatedSampleForm: {
            resourceHeapBuiltin: "ResourceDescriptorHeap",
            resourceElementType: "Texture2D<float4>",
            samplerHeapBuiltin: "SamplerDescriptorHeap",
            samplerElementType: "SamplerState",
            indexScope: "NonUniformResourceIndex",
            operation: "Sample",
            coordinateType: "float2",
            resultType: "float4",
        },
    },
};

function numericV1Document(): Record<string, unknown> {
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

function textureV2Document(): Record<string, unknown> {
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

function cycleV1Document(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        graphId: "graph.cycle",
        profile: "gglab.surface",
        profileVersion: 1,
        parameters: [],
        nodes: [
            { id: "n.a", type: "Multiply", version: 1, properties: {} },
            { id: "n.b", type: "Multiply", version: 1, properties: {} },
        ],
        connections: [
            { id: "c1", from: { nodeId: "n.a", portId: "value" }, to: { nodeId: "n.b", portId: "a" } },
            { id: "c2", from: { nodeId: "n.b", portId: "value" }, to: { nodeId: "n.a", portId: "a" } },
        ],
        editorMetadata: { nodes: {} },
    };
}

// --- staging (temp files) --------------------------------------------------

const stageRoot = mkdtempSync(join(tmpdir(), "gglab-shader-graph-cli-"));
function stage(name: string, fixture: unknown): string {
    const filePath = join(stageRoot, name);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(fixture), "utf8");
    return filePath;
}
afterAll(() => {
    rmSync(stageRoot, { recursive: true, force: true });
});

function parse(command: KnownCommand, argv: string[]) {
    return parseCommandArgs(COMMAND_GRAMMARS[command], command, argv);
}

// --- strict grammars ---------------------------------------------------------

describe("command grammars (no silently ignored tokens)", () => {
    it("accepts exactly the declared positionals, value options, and flags", () => {
        const parsed = parse("emit", ["doc.json", "--descriptor", "d1.json", "--pretty"]);
        expect(parsed.positionals).toEqual(["doc.json"]);
        expect(parsed.options.get("descriptor")).toBe("d1.json");
        expect(parsed.flags.has("pretty")).toBe(true);
        expect(parsed.diagnostics).toEqual([]);
    });

    it("rejects an unknown option — a typo is never a silent no-op", () => {
        const parsed = parse("validate", ["doc.json", "--descripter", "d1.json"]);
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: CliCode.InvalidArgument, severity: "error", dataPath: "$.args[1]" }),
            ]),
        );
        expect(parsed.options.has("descripter")).toBe(false);
    });

    it("rejects a value-option whose value would swallow another option", () => {
        const parsed = parse("validate", ["doc.json", "--descriptor", "--pretty"]);
        expect(parsed.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: CliCode.InvalidArgument, severity: "error" })]),
        );
        expect(parsed.options.has("descriptor")).toBe(false);
    });

    it("rejects a missing value, a duplicated option, and extra positionals", () => {
        expect(parse("emit", ["doc.json", "--descriptor"]).diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: CliCode.InvalidArgument })]),
        );
        expect(parse("validate", ["doc.json", "--descriptor", "a.json", "--descriptor", "b.json"]).diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: CliCode.InvalidArgument })]),
        );
        expect(parse("descriptor", ["foo.json", "WTF.json"]).diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: CliCode.InvalidArgument })]),
        );
        expect(parse("emit", []).diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: CliCode.MissingArgument })]),
        );
    });
});

// --- validate ---------------------------------------------------------------

describe("validate", () => {
    it("runs the core authoring checks on a v1 numeric document without a descriptor", () => {
        const documentPath = stage("validate/numeric-v1.json", numericV1Document());
        const envelope = runValidate(parse("validate", [documentPath]));
        expect(envelope.ok).toBe(true);
        expect(envelope.command).toBe("validate");
        expect(envelope.diagnostics).toEqual([]);
        expect(envelope.payload).toMatchObject({
            document: documentPath,
            descriptor: null,
            profile: "gglab.surface",
            profileVersion: 1,
            diagnostics: { error: 0, warning: 0 },
        });
    });

    it("adds the descriptor pairing (compatibility + conformance) when a descriptor is supplied", () => {
        const documentPath = stage("validate/numeric-v1b.json", numericV1Document());
        const descriptorPath = stage("validate/desc-v1.json", canonicalV1Fixture);
        const envelope = runValidate(parse("validate", [documentPath, "--descriptor", descriptorPath]));
        expect(envelope.ok).toBe(true);
        const payload = envelope.payload as { descriptor: string; descriptorResolution: { selected: string } };
        expect(payload.descriptor).toBe(descriptorPath);
        expect(payload.descriptorResolution.selected).toBe(descriptorPath);
    });

    it("refuses a descriptor on a different profile line (PROFILE_MISMATCH; failure envelope has no payload)", () => {
        const documentPath = stage("validate/numeric-v1c.json", numericV1Document());
        const descriptorPath = stage("validate/desc-v2.json", canonicalV2Fixture); // line pV2
        const envelope = runValidate(parse("validate", [documentPath, "--descriptor", descriptorPath]));
        expect(envelope.ok).toBe(false);
        expect(envelope.payload).toBeNull();
        expect(envelope.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.ProfileMismatch, severity: "error", dataPath: "$" }),
        ]);
    });

    it("reports a cyclic document as a semantic failure with CYCLE_DETECTED and no payload", () => {
        const documentPath = stage("validate/cycle.json", cycleV1Document());
        const envelope = runValidate(parse("validate", [documentPath]));
        expect(envelope.ok).toBe(false);
        expect(envelope.payload).toBeNull();
        expect(envelope.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: DiagnosticCode.CycleDetected })]));
    });
});

// --- emit -------------------------------------------------------------------

describe("emit", () => {
    it("emits a v1 numeric document deterministically with identity = SHA-256(exact bytes)", () => {
        const documentPath = stage("emit/numeric-v1.json", numericV1Document());
        const descriptorPath = stage("emit/desc-v1.json", canonicalV1Fixture);
        const envelope = runEmit(parse("emit", [documentPath, "--descriptor", descriptorPath]));
        expect(envelope.ok).toBe(true);
        const payload = envelope.payload as { source: string; generatedSourceIdentity: string; sourceMap: readonly unknown[] };
        expect(payload.source).toContain("EvaluateSurface");
        expect(payload.generatedSourceIdentity).toMatch(/^[0-9a-f]{64}$/);
        expect(payload.generatedSourceIdentity).toBe(sha256Hex(utf8Encode(payload.source)));
        expect(payload.sourceMap.length).toBeGreaterThan(0);
    });

    it("produces byte-identical envelopes for identical requests (determinism)", () => {
        const documentPath = stage("emit/numeric-v1-determinism.json", numericV1Document());
        const descriptorPath = stage("emit/desc-v1-determinism.json", canonicalV1Fixture);
        const first = serializeEnvelope(runEmit(parse("emit", [documentPath, "--descriptor", descriptorPath])), true);
        const second = serializeEnvelope(runEmit(parse("emit", [documentPath, "--descriptor", descriptorPath])), true);
        expect(first).toBe(second);
    });

    it("emits the v2 texture document with the contract-driven spelling", () => {
        const documentPath = stage("emit/texture-v2.json", textureV2Document());
        const descriptorPath = stage("emit/desc-v2.json", canonicalV2Fixture);
        const envelope = runEmit(parse("emit", [documentPath, "--descriptor", descriptorPath]));
        expect(envelope.ok).toBe(true);
        const payload = envelope.payload as { source: string };
        expect(payload.source).toContain("float4 v_n_smp = gglab_sampleTexture2D(v_n_tp, v_n_uv);");
        expect(payload.source).toContain("Texture2D<float4> texture = ResourceDescriptorHeap[NonUniformResourceIndex(textureSamplerBinding.x)];");
        expect(payload.source).toContain("SamplerState sampler = SamplerDescriptorHeap[NonUniformResourceIndex(textureSamplerBinding.y)];");
        expect(payload.source).toContain("EvaluateSurface");
    });

    it("refuses a v2-line document against a descriptor that does not serialize the contract (MISSING_PROFILE_CAPABILITY)", () => {
        // The file parses (descriptorVersion 1 shape, strict) but declares the
        // pV2 line — the reader is agnostic; capability is not.
        const descriptor = { ...canonicalV1Fixture, profileVersion: 2 };
        const documentPath = stage("emit/texture-v2-missing.json", textureV2Document());
        const descriptorPath = stage("emit/desc-missing.json", descriptor);
        const envelope = runEmit(parse("emit", [documentPath, "--descriptor", descriptorPath]));
        expect(envelope.ok).toBe(false);
        expect(envelope.payload).toBeNull();
        expect(envelope.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.MissingProfileCapability,
                severity: "error",
                message: expect.stringContaining("requires the generated texture-signature contract"),
            }),
        ]);
    });

    it("refuses a v1-line document against a descriptor that serializes the contract (FORBIDDEN_PROFILE_CAPABILITY)", () => {
        // The file parses fine (descriptorVersion 2 shape, declared on the pV1
        // line) — but the v1 line's frozen semantics do not admit the
        // texture-signature contract, so the descriptor cannot serve that
        // line. Capability, not version numbers, decides.
        const descriptor = { ...canonicalV2Fixture, profileVersion: 1 };
        const documentPath = stage("emit/numeric-v1-forbidden.json", numericV1Document());
        const descriptorPath = stage("emit/desc-forbidden.json", descriptor);
        const envelope = runEmit(parse("emit", [documentPath, "--descriptor", descriptorPath]));
        expect(envelope.ok).toBe(false);
        expect(envelope.payload).toBeNull();
        expect(envelope.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.ForbiddenProfileCapability,
                severity: "error",
                message: expect.stringContaining("does not admit the generated texture-signature contract"),
            }),
        ]);
    });

    it("requires exactly one descriptor source (MISSING_OPTION / INVALID_ARGUMENT; failure envelopes have no payload)", () => {
        const documentPath = stage("emit/numeric-v1-opts.json", numericV1Document());
        const none = runEmit(parse("emit", [documentPath]));
        expect(none.ok).toBe(false);
        expect(none.payload).toBeNull();
        expect(none.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: CliCode.MissingOption })]));

        const both = runEmit(parse("emit", [documentPath, "--descriptor", "a.json", "--descriptors-dir", "b/"]));
        expect(both.ok).toBe(false);
        expect(both.payload).toBeNull();
        expect(both.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: CliCode.InvalidArgument })]));
    });

    it("reports an unreadable descriptor file as FILE_NOT_FOUND (semantic failure class, no payload)", () => {
        const documentPath = stage("emit/numeric-v1-io.json", numericV1Document());
        const envelope = runEmit(parse("emit", [documentPath, "--descriptor", join(stageRoot, "does-not-exist.json")]));
        expect(envelope.ok).toBe(false);
        expect(envelope.payload).toBeNull();
        expect(envelope.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: CliCode.FileNotFound, dataPath: "$.descriptor" })]),
        );
    });
});

// --- descriptor --------------------------------------------------------------

describe("descriptor", () => {
    it("inspects a v1 instance: texture-signature contract not serialized", () => {
        const descriptorPath = stage("descriptor/desc-v1.json", canonicalV1Fixture);
        const envelope = runDescriptor(parse("descriptor", [descriptorPath]));
        expect(envelope.ok).toBe(true);
        const payload = envelope.payload as Record<string, unknown> & {
            descriptorVersion: number;
            profileId: string;
            profileVersion: number;
            textureSignatureSerialized: boolean;
            sampling: { policy: string };
            tool: { identity: string };
        };
        expect(payload.descriptorVersion).toBe(1);
        expect(payload.profileId).toBe("gglab.surface");
        expect(payload.profileVersion).toBe(1);
        expect(payload.textureSignatureSerialized).toBe(false);
        expect(payload.sampling.policy).toBe("reuseRuntimeTextureSamplerBinding");
        expect(payload.tool.identity).toBe("gglab-shaderc");
    });

    it("inspects a v2 instance: texture-signature contract serialized", () => {
        const descriptorPath = stage("descriptor/desc-v2.json", canonicalV2Fixture);
        const envelope = runDescriptor(parse("descriptor", [descriptorPath]));
        expect(envelope.ok).toBe(true);
        const payload = envelope.payload as { descriptorVersion: number; textureSignatureSerialized: boolean };
        expect(payload.descriptorVersion).toBe(2);
        expect(payload.textureSignatureSerialized).toBe(true);
    });
});

// --- discovery (selection rule + explicit considered surfacing) ---------------

describe("descriptor discovery", () => {
    function buildTree(): string {
        const base = join(stageRoot, "discovery");
        const write = (relativePath: string, fixture: unknown): void => {
            const filePath = join(base, relativePath);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, JSON.stringify(fixture), "utf8");
        };
        write("GGLab.Surface/1/descriptor.json", canonicalV1Fixture);
        write("GGLab.Surface/2/descriptor.json", canonicalV2Fixture);
        write("GGLab.Surface/3/descriptor.json", { ...canonicalV2Fixture, descriptorVersion: 3, profileVersion: 3 });
        write("GGLab.Other/2/descriptor.json", { ...canonicalV2Fixture, profileId: "gglab.other" });
        return base;
    }

    it("selects the highest supported descriptorVersion within the requested profile line, and surfaces every considered candidate", () => {
        const base = buildTree();
        const documentPath = stage("discovery/doc-v2.json", textureV2Document());
        const envelope = runEmit(parse("emit", [documentPath, "--descriptors-dir", base]));
        expect(envelope.ok).toBe(true);
        const payload = envelope.payload as { descriptor: string; descriptorResolution: { selected: string; considered: readonly { instancePath: string; supported: boolean; failure: string | undefined }[] } };
        expect(payload.descriptor).toBe(join(base, "GGLab.Surface", "2", "descriptor.json"));
        expect(payload.descriptorResolution.selected).toBe(join(base, "GGLab.Surface", "2", "descriptor.json"));
        const considered = payload.descriptorResolution.considered;
        expect(considered).toHaveLength(4);
        const v3 = considered.find((candidate) => candidate.instancePath.endsWith(join("3", "descriptor.json")));
        expect(v3 !== undefined).toBe(true);
        if (v3 !== undefined) {
            expect(v3.supported).toBe(false);
            expect(v3.failure).toBe(DiagnosticCode.UnsupportedDescriptorVersion);
        }
    });

    it("never crosses profile lines: the v1 line resolves to the descriptorVersion-1 instance only", () => {
        const base = buildTree();
        const documentPath = stage("discovery/doc-v1.json", numericV1Document());
        const envelope = runValidate(parse("validate", [documentPath, "--descriptors-dir", base]));
        expect(envelope.ok).toBe(true);
        const payload = envelope.payload as { descriptor: string; descriptorResolution: { selected: string } };
        expect(payload.descriptor).toBe(join(base, "GGLab.Surface", "1", "descriptor.json"));
        expect(payload.descriptorResolution.selected).toBe(join(base, "GGLab.Surface", "1", "descriptor.json"));
    });

    it("fails explicitly (DESCRIPTOR_NOT_RESOLVED, no payload) when the requested line has no supported instance", () => {
        const base = buildTree();
        const document = { ...textureV2Document(), profileVersion: 3 } as Record<string, unknown>;
        const documentPath = stage("discovery/doc-v3.json", document);
        const envelope = runValidate(parse("validate", [documentPath, "--descriptors-dir", base]));
        expect(envelope.ok).toBe(false);
        expect(envelope.payload).toBeNull();
        expect(envelope.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: CliCode.DescriptorNotResolved })]),
        );
        expect(classifyExitCode(envelope)).toBe(1); // well-formed request, unsatisfied environment
    });
});

// --- envelope invariant + exit-code classification ----------------------------

describe("machine protocol invariants", () => {
    it("buildEnvelope centrally nulls the payload on failure", () => {
        const success = buildEnvelope("emit", [], { source: "x" });
        expect(success.ok).toBe(true);
        expect(success.payload).toEqual({ source: "x" });
        const failure = buildEnvelope("emit", [{ code: DiagnosticCode.CycleDetected, severity: "error", message: "cycle", dataPath: "$" }], { source: "x" });
        expect(failure.ok).toBe(false);
        expect(failure.payload).toBeNull();
    });

    it("classifies exit codes: usage only => 2, semantic/environment => 1, success => 0", () => {
        expect(classifyExitCode(buildEnvelope("emit", [], {}))).toBe(0);
        expect(
            classifyExitCode(
                buildEnvelope("emit", [{ code: CliCode.InvalidArgument, severity: "error", message: "x", dataPath: "$" }], null),
            ),
        ).toBe(2);
        expect(
            classifyExitCode(
                buildEnvelope("emit", [{ code: CliCode.MissingOption, severity: "error", message: "x", dataPath: "$" }], null),
            ),
        ).toBe(2);
        expect(
            classifyExitCode(
                buildEnvelope("emit", [{ code: CliCode.FileNotFound, severity: "error", message: "x", dataPath: "$" }], null),
            ),
        ).toBe(1);
        expect(
            classifyExitCode(
                buildEnvelope("emit", [{ code: DiagnosticCode.MissingProfileCapability, severity: "error", message: "x", dataPath: "$" }], null),
            ),
        ).toBe(1);
        expect(
            classifyExitCode(
                buildEnvelope("emit", [
                    { code: CliCode.InvalidArgument, severity: "error", message: "x", dataPath: "$" },
                    { code: DiagnosticCode.TypeMismatch, severity: "error", message: "y", dataPath: "$" },
                ], null),
            ),
        ).toBe(1); // a real failure in the mix is never masked as usage
    });
});

// --- entry point --------------------------------------------------------------

describe("main", () => {
    function runMain(argv: string[]): { code: number; text: string } {
        let text = "";
        const sink = {
            write(chunk: string): void {
                text += chunk;
            },
        };
        const code = main(argv, sink);
        return { code, text };
    }

    it("prints usage and returns code 2 when no command is given", () => {
        const result = runMain([]);
        expect(result.code).toBe(2);
        expect(result.text).toBe(`${usageText()}\n`);
    });

    it("prints usage and returns code 2 for --help", () => {
        const result = runMain(["validate", "--help"]);
        expect(result.code).toBe(2);
        expect(result.text).toContain("usage: shader-graph <command>");
    });

    it("returns code 2 with a structured INVALID_ARGUMENT envelope for an unknown command", () => {
        const result = runMain(["frobnicate"]);
        expect(result.code).toBe(2);
        const envelope = JSON.parse(result.text) as { ok: boolean; diagnostics: readonly { code: string }[] };
        expect(envelope.ok).toBe(false);
        expect(envelope.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "INVALID_ARGUMENT" })]));
    });

    it("returns code 2 when the invocation is malformed (missing positional)", () => {
        const result = runMain(["emit"]);
        expect(result.code).toBe(2);
        const envelope = JSON.parse(result.text) as { ok: boolean; payload: unknown; diagnostics: readonly { code: string }[] };
        expect(envelope.ok).toBe(false);
        expect(envelope.payload).toBeNull();
        expect(envelope.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MISSING_ARGUMENT" })]));
    });

    it("returns code 2 for a typo'd option — and never a green result", () => {
        const documentPath = stage("main/numeric-v1.json", numericV1Document());
        const descriptorPath = stage("main/desc-v1.json", canonicalV1Fixture);
        const result = runMain(["validate", documentPath, "--descripter", descriptorPath]);
        expect(result.code).toBe(2);
        const envelope = JSON.parse(result.text) as { ok: boolean; payload: unknown; diagnostics: readonly { code: string }[] };
        expect(envelope.ok).toBe(false);
        expect(envelope.payload).toBeNull();
        expect(envelope.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "INVALID_ARGUMENT" })]));
    });

    it("returns code 0 with a JSON envelope on success", () => {
        const documentPath = stage("main/numeric-v1-ok.json", numericV1Document());
        const descriptorPath = stage("main/desc-v1-ok.json", canonicalV1Fixture);
        const result = runMain(["emit", documentPath, "--descriptor", descriptorPath]);
        expect(result.code).toBe(0);
        const envelope = JSON.parse(result.text) as { ok: boolean; command: string; payload: { source: string } };
        expect(envelope.ok).toBe(true);
        expect(envelope.command).toBe("emit");
        expect(envelope.payload.source).toContain("EvaluateSurface");
    });

    it("returns code 1 with semantic diagnostics and no payload on command failure", () => {
        const documentPath = stage("main/cycle.json", cycleV1Document());
        const result = runMain(["validate", documentPath]);
        expect(result.code).toBe(1);
        const envelope = JSON.parse(result.text) as { ok: boolean; payload: unknown; diagnostics: readonly { code: string }[] };
        expect(envelope.ok).toBe(false);
        expect(envelope.payload).toBeNull();
        expect(envelope.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: DiagnosticCode.CycleDetected })]));
    });
});
