/**
 * GUI authoring surface tests. The components forward intents and render
 * core-owned facts; these tests lock the slice's invariants:
 *
 *   - the palette is the core node catalog itself (no UI-side registry);
 *   - authoring operations are data construction; validity is what the
 *     core's services say (structured codes, rendered verbatim);
 *   - descriptor loading is the core's strict reader; compatibility and
 *     conformance are the core's shared verdict (capability, both
 *     directions);
 *   - emission is the core's deterministic service: save → load →
 *     compile preserves the HLSL bytes and the generated-source identity,
 *     and canvas placement never changes them.
 */
import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
    addConnection,
    addNode,
    addParameter,
    diagnosticFocus,
    documentToFlow,
    nodeCatalogGroups,
    parameterChoices,
    portTop,
    readDescriptorText,
    textureSignatureSerialized,
    DiagnosticsPanel,
    NodePalette,
    ReactFlowProvider,
    ShaderNode,
    useSyncedFlowNodes,
    type ShaderFlowNode,
} from "@gglab/editor-ui";
import {
    checkProfileConformance,
    checkProfileDescriptorCompatibility,
    DiagnosticCode,
    emitHlsl,
    parseShaderGraphDocument,
    parseSurfaceProfileDescriptor,
    validateShaderGraph,
    type ShaderGraphDiagnostic,
    type SurfaceProfileDescriptor,
} from "@gglab/shader-graph-core";

// --- proven descriptor fixtures (same shapes the CLI tests use) ------------

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

function parseSurfaceProfileDescriptorFixture(fixture: Record<string, unknown>): SurfaceProfileDescriptor {
    const parsed = parseSurfaceProfileDescriptor(JSON.stringify(fixture));
    if (!parsed.ok || parsed.value === null) {
        throw new Error("fixture descriptor must parse (proven shape)");
    }
    return parsed.value;
}

function validV1Document(): string {
    return JSON.stringify({
        schemaVersion: 1,
        graphId: "graph.gui",
        profile: "gglab.surface",
        profileVersion: 1,
        parameters: [{ id: "p.metal", name: "Metal", class: "ScalarParameter", valueType: "float" }],
        nodes: [
            { id: "n.sf", type: "ScalarParameter", version: 1, properties: { parameterId: "p.metal" } },
            { id: "n.r", type: "Float", version: 1, properties: { value: 0.5 } },
            { id: "n.o", type: "Float", version: 1, properties: { value: 1 } },
            { id: "n.c", type: "Float3", version: 1, properties: { value: [1, 1, 1] } },
            { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
        ],
        connections: [
            { id: "c1", from: { nodeId: "n.c", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } },
            { id: "c2", from: { nodeId: "n.c", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
            { id: "c3", from: { nodeId: "n.sf", portId: "value" }, to: { nodeId: "n.out", portId: "Metallic" } },
            { id: "c4", from: { nodeId: "n.r", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
            { id: "c5", from: { nodeId: "n.o", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
        ],
        editorMetadata: { nodes: {} },
    });
}

function textureV2Document(): string {
    return JSON.stringify({
        schemaVersion: 1,
        graphId: "graph.gui-tex",
        profile: "gglab.surface",
        profileVersion: 2,
        parameters: [
            { id: "p.tex", name: "Texture", class: "Texture2DParameter", valueType: "Texture2D" },
            { id: "p.rough", name: "Roughness", class: "ScalarParameter", valueType: "float" },
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
    });
}

function loaded(text: string) {
    const parsed = parseShaderGraphDocument(text);
    if (!parsed.ok || parsed.value === null) {
        throw new Error("fixture document must parse (proven shape)");
    }
    return parsed.value;
}

// --- palette: the core catalog itself ---------------------------------------

describe("node palette", () => {
    it("is the core's node catalog, grouped in a stable order — no UI-side registry", () => {
        const groups = nodeCatalogGroups();
        const names = groups.flatMap((group) => group.definitions.map((definition) => definition.type));
        expect(groups.map((group) => group.category)).toEqual(["parameter", "constant", "math", "input", "texture", "output"]);
        expect(names).toEqual(expect.arrayContaining(["Float", "Multiply", "ScalarParameter", "VectorParameter", "UV0", "SampleTexture2D", "SurfaceOutput"]));
        // Every catalog entry appears exactly once; nothing invented here.
        expect(names.length).toBe(new Set(names).size);
    });

    it("renders (server render smoke): palette entries and a passed diagnostics panel", () => {
        const html = renderToString(
            <NodePalette onAddNode={() => undefined} onAddParameter={() => undefined} descriptor={null} />,
        );
        expect(html).toContain("Multiply");
        expect(html).toContain("SurfaceOutput");
        // Without a descriptor, parameter authoring is explicitly unavailable —
        // the UI projects the absence instead of inventing a vocabulary.
        expect(html).toContain("descriptor-owned");
        const passed = renderToString(<DiagnosticsPanel title="Graph validation" ok={true} diagnostics={[]} passedText="No graph validation problems." />);
        expect(passed).toContain("No graph validation problems.");
    });

    it("parameter choices are the descriptor's own vocabulary (projection, not a register)", () => {
        expect(parameterChoices(null)).toEqual([]);
        const descriptor = parseSurfaceProfileDescriptorFixture(canonicalV1Fixture);
        const choices = parameterChoices(descriptor);
        // Every active class + its FULL value-type list from the descriptor
        // (including float2, which a UI-side list would omit).
        expect(choices).toContainEqual({ class: "ScalarParameter", valueTypes: ["float"], deferred: false });
        expect(choices).toContainEqual({ class: "VectorParameter", valueTypes: ["float2", "float3", "float4"], deferred: false });
        expect(choices).toContainEqual({ class: "Texture2DParameter", valueTypes: ["Texture2D"], deferred: false });
        // Deferred classes are surfaced, never authorable.
        expect(choices).toContainEqual({ class: "BoolParameter", valueTypes: [], deferred: true });
        expect(choices).toContainEqual({ class: "SamplerParameter", valueTypes: [], deferred: true });
    });

    it("a descriptor that admits no Texture2DParameter offers no Texture2DParameter (no drift)", () => {
        const descriptor = parseSurfaceProfileDescriptorFixture({ ...canonicalV1Fixture, parameterClasses: [{ class: "ScalarParameter", valueTypes: ["float"] }] });
        const names = parameterChoices(descriptor).map((choice) => choice.class);
        expect(names).not.toContain("Texture2DParameter");
        expect(names).toContain("ScalarParameter");
    });
});

// --- ports are the UI unit: distinct rows, distinct handles ------------------

describe("port layout (ShaderNode)", () => {
    it("gives every port its own row and vertically distinct handle position", () => {
        // SampleTexture2D's six channel outputs must be six distinguishable points.
        for (let index = 0; index < 6; index += 1) {
            for (let other = index + 1; other < 6; other += 1) {
                expect(portTop(index)).not.toBe(portTop(other));
            }
        }
        expect(portTop(5) - portTop(0)).toBe(5 * 26);
    });

    it("renders a SampleTexture2D card with six labeled, individually present outputs", () => {
        const document = loaded(textureV2Document());
        const projection = documentToFlow(document);
        const sample = projection.nodes.find((node) => node.data.nodeType === "SampleTexture2D");
        expect(sample !== undefined).toBe(true);
        if (sample !== undefined) {
            expect(sample.data.outputPorts).toEqual(["RGBA", "RGB", "R", "G", "B", "A"]);
            // Handle (v12) requires the xyflow store context: wrap standalone renders.
            const html = renderToString(
                <ReactFlowProvider>
                    <ShaderNode {...(sample as unknown as Parameters<typeof ShaderNode>[0])} />
                </ReactFlowProvider>,
            );
            for (const portName of ["RGBA", "RGB", "R", "G", "B", "A"]) {
                expect(html).toContain(portName);
            }
            // Six source handles + two target handles (texture, uv), each with its own top.
            const handleTops = [...html.matchAll(/top:\s*(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
            expect(new Set(handleTops).size).toBeGreaterThanOrEqual(6);
        }
    });
});

// --- controlled dragging: transient nodes own the drag; the projection syncs ----

function flowNodeAt(x: number, y: number): readonly ShaderFlowNode[] {
    return [
        {
            id: "n1",
            type: "gglab",
            position: { x, y },
            data: { label: "n1", nodeType: "Float", inputPorts: [], outputPorts: ["value"], knownToCatalog: true, focused: false, focusedPorts: [] },
        },
    ];
}

describe("viewport node state (controlled dragging)", () => {
    it("consumes drag position changes in real time — the node follows the mouse (no teleport on release)", () => {
        const projection = flowNodeAt(0, 0);
        const { result } = renderHook(() => useSyncedFlowNodes(projection));
        expect(result.current.nodes[0]?.position).toEqual({ x: 0, y: 0 });
        // This is exactly the change stream React Flow emits while dragging.
        act(() => {
            result.current.onNodesChange([{ id: "n1", type: "position", position: { x: 120, y: 60 } }]);
        });
        expect(result.current.nodes[0]?.position).toEqual({ x: 120, y: 60 });
    });

    it("re-syncs from a new projection after the commit (drag stop → editorMetadata → projection)", () => {
        const before = flowNodeAt(0, 0);
        const { result, rerender } = renderHook((nodes: readonly ShaderFlowNode[]) => useSyncedFlowNodes(nodes), { initialProps: before });
        // A transient drag moves the local node...
        act(() => {
            result.current.onNodesChange([{ id: "n1", type: "position", position: { x: 120, y: 60 } }]);
        });
        expect(result.current.nodes[0]?.position).toEqual({ x: 120, y: 60 });
        // ...and the commit produces a document with that position. The new
        // projection (same place) must take over transient state 1:1.
        const after = flowNodeAt(120, 60);
        rerender(after);
        expect(result.current.nodes[0]?.position).toEqual({ x: 120, y: 60 });
        // A document that moves the node elsewhere (e.g. a load) wins too.
        const loaded = flowNodeAt(500, 400);
        rerender(loaded);
        expect(result.current.nodes[0]?.position).toEqual({ x: 500, y: 400 });
    });
});

// --- diagnostic → canvas navigation (strict mode: structured only) ------------

function makeDiagnostic(code: string, message: string, dataPath: string): ShaderGraphDiagnostic {
    return { code, severity: "error", message, dataPath };
}

describe("diagnostic → canvas navigation (strict mode: structured data only)", () => {
    it("resolves a node anchor to the node — and does not mine ports from the message prose", () => {
        const document = loaded(validV1Document());
        // nodes[4] = n.out (SurfaceOutput). The message names "BaseColor"
        // in quotes — a real catalog input — but the target must still be
        // the node only: prose is a display surface, not a contract.
        const focus = diagnosticFocus(document, makeDiagnostic("MISSING_REQUIRED_INPUT", 'Node "n.out" (SurfaceOutput) has required input "BaseColor" without a connection.', "$.nodes[4]"));
        expect(focus).toEqual({
            nodeHighlights: [{ nodeId: "n.out", portIds: [] }],
            connectionHighlights: [],
        });
    });

    it("resolves a connection anchor to the edge and both endpoint ports (all structured data)", () => {
        const document = loaded(validV1Document());
        // connections[0] = c1: n.c.value → n.out.BaseColor.
        const focus = diagnosticFocus(document, makeDiagnostic("TYPE_MISMATCH", 'Connection "c1" carries an incompatible value to input "BaseColor".', "$.connections[0]"));
        expect(focus).toEqual({
            nodeHighlights: [
                { nodeId: "n.c", portIds: ["value"] },
                { nodeId: "n.out", portIds: ["BaseColor"] },
            ],
            connectionHighlights: ["c1"],
        });
    });

    it("a node anchor with a quoted unknown port in the message still resolves to the node only (no prose dependency at all)", () => {
        const document = loaded(validV1Document());
        const focus = diagnosticFocus(document, makeDiagnostic("UNKNOWN_PORT", 'Connection "c9" references unknown port "NoSuchPort" on node "n.out".', "$.nodes[4]"));
        expect(focus).toEqual({ nodeHighlights: [{ nodeId: "n.out", portIds: [] }], connectionHighlights: [] });
    });

    it("anchors without a canvas target resolve to null (honest absence, not a fake highlight)", () => {
        const document = loaded(validV1Document());
        expect(diagnosticFocus(document, makeDiagnostic("PROFILE_MISMATCH", "The profile line of the graph and the descriptor differ.", "$"))).toBeNull();
        expect(diagnosticFocus(document, makeDiagnostic("DUPLICATE_PARAMETER_ID", 'Parameter id "p.x" is duplicated.', "$.parameters[0]"))).toBeNull();
        expect(diagnosticFocus(document, makeDiagnostic("MISSING_REQUIRED_FIELD", "Missing a node at this index.", "$.nodes[41]"))).toBeNull();
    });
});

// --- authoring operations: construction here, judgment in the core -----------

describe("authoring operations + core verdicts", () => {
    it("adds a constant node with a deterministic numeric default (core still validates)", () => {
        const document = loaded(validV1Document());
        const added = addNode(document, "Float");
        expect(added.applied).toBe(true);
        // Stable id = first free `n<k>` slot in the document's id namespace.
        expect(added.createdId).toBe("n1");
        expect(added.document.nodes.at(-1)).toEqual(
            expect.objectContaining({ type: "Float", version: 1, properties: { value: 0 } }),
        );
        expect(validateShaderGraph(added.document).ok).toBe(true);
    });

    it("refuses a parameter node without naming a parameter first (structured refusal, no silent placeholder)", () => {
        const document = loaded(validV1Document());
        const refused = addNode(document, "ScalarParameter");
        expect(refused.applied).toBe(false);
        expect(refused.refusal).not.toBeNull();
        if (refused.refusal !== undefined) {
            expect(refused.refusal.reason).toContain("parameter");
        }
    });

    it("addParameter creates the document entry and the node that names it", () => {
        const document = loaded(validV1Document());
        const added = addParameter(document, { name: "Opacity Boost", class: "ScalarParameter", valueType: "float" });
        expect(added.applied).toBe(true);
        // The document already names "p.metal"; the stable-id namespaces are
        // independent, so the first free p-slot and first free n-slot are 1.
        expect(added.document.parameters.at(-1)).toEqual(
            expect.objectContaining({ id: "p1", name: "Opacity Boost", class: "ScalarParameter", valueType: "float" }),
        );
        const node = added.document.nodes.find((candidate) => candidate.id === "n1");
        expect(node).toEqual(expect.objectContaining({ type: "ScalarParameter", properties: { parameterId: "p1" } }));
    });

    it("addParameter is atomic: a class with no catalog-creatable node refuses with the unchanged input (no orphan parameter)", () => {
        const document = loaded(validV1Document());
        const before = JSON.stringify(document);
        const refused = addParameter(document, { name: "Flag", class: "BoolParameter", valueType: "float" });
        // BoolParameter is in the deferred set and has no catalog node entry.
        expect(refused.applied).toBe(false);
        expect(refused.refusal).not.toBeNull();
        // Contract: refusal returns the unchanged input — deep equality.
        expect(JSON.stringify(refused.document)).toBe(before);
        expect(refused.document.parameters.length).toBe(document.parameters.length);
    });

    it("node creation defaults come from the core's catalog, not from the UI (Float → 0 is a catalog fact)", () => {
        const document = loaded(validV1Document());
        const added = addNode(document, "Float2");
        expect(added.applied).toBe(true);
        expect(added.document.nodes.at(-1)?.properties).toEqual({ value: [0, 0] });
    });

    it("records canvas placement as session state without touching semantics", () => {
        const document = loaded(validV1Document());
        const placed = {
            ...document,
            editorMetadata: { ...document.editorMetadata, nodes: { ...document.editorMetadata.nodes, nsf: { position: { x: 400, y: 250 }, unknownFields: {} } } },
        };
        expect(placed.editorMetadata.nodes.nsf).toEqual(expect.objectContaining({ position: { x: 400, y: 250 } }));
        expect(validateShaderGraph(placed).ok).toBe(true);
    });
});

describe("connection validity is the core's call, rendered structurally", () => {
    it("a connection to a nonexistent port is accepted as data, then named by the core", () => {
        const document = loaded(validV1Document());
        const connected = addConnection(document, { nodeId: "n.r", portId: "value" }, { nodeId: "n.out", portId: "NoSuchPort" });
        expect(connected.applied).toBe(true);
        const report = validateShaderGraph(connected.document);
        expect(report.ok).toBe(false);
        const codes = report.diagnostics.map((diagnostic) => diagnostic.code);
        expect(codes).toEqual(expect.arrayContaining([DiagnosticCode.UnknownPort]));
    });

    it("a cyclic wiring is named CYCLE_DETECTED — the code is what the GUI renders", () => {
        const document = loaded(validV1Document());
        const withA = addNode(document, "Add");
        expect(withA.applied).toBe(true);
        const withB = addNode(withA.document, "Add");
        expect(withB.applied).toBe(true);
        const aId = withA.createdId;
        const bId = withB.createdId;
        expect(aId !== undefined && bId !== undefined).toBe(true);
        if (aId !== undefined && bId !== undefined) {
            const wired1 = addConnection(withB.document, { nodeId: aId, portId: "value" }, { nodeId: bId, portId: "a" });
            const wired2 = addConnection(wired1.document, { nodeId: bId, portId: "value" }, { nodeId: aId, portId: "a" });
            const report = validateShaderGraph(wired2.document);
            const codes = report.diagnostics.map((diagnostic) => diagnostic.code);
            expect(codes).toContain(DiagnosticCode.CycleDetected);
            // The GUI renders exactly these structured entries:
            const html = renderToString(
                <DiagnosticsPanel title="Graph validation" ok={false} diagnostics={report.diagnostics} passedText="unused" />,
            );
            expect(html).toContain("CYCLE_DETECTED");
        }
    });
});

// --- descriptor loading + shared verdict (the GUI never guesses) -------------

describe("descriptor panel + shared verdicts", () => {
    it("parses a v1 instance with the core's strict reader; exposes the texture-signature fact", () => {
        const state = readDescriptorText("descriptor.json", JSON.stringify(canonicalV1Fixture));
        expect(state.kind).toBe("ready");
        if (state.kind !== "ready") {
            return;
        }
        expect(state.descriptor.descriptorVersion).toBe(1);
        expect(textureSignatureSerialized(state.descriptor)).toBe(false);
    });

    it("parses a v2 instance; the texture-signature contract is serialized there", () => {
        const state = readDescriptorText("descriptor.json", JSON.stringify(canonicalV2Fixture));
        expect(state.kind).toBe("ready");
        if (state.kind !== "ready") {
            return;
        }
        expect(textureSignatureSerialized(state.descriptor)).toBe(true);
    });

    it("rejects an unparsable file with the reader's structured first diagnostic", () => {
        const state = readDescriptorText("junk.json", "{ not a descriptor");
        expect(state.kind).toBe("rejected");
        if (state.kind !== "rejected") {
            return;
        }
        expect(state.diagnosticCode).toBeDefined();
        expect(state.diagnosticMessage).not.toHaveLength(0);
    });

    it("v2 document + v2 descriptor: conformance and compatibility pass, emission carries the contract lines", () => {
        const document = loaded(textureV2Document());
        const descriptor = parseSurfaceProfileDescriptorFixture(canonicalV2Fixture);
        expect(checkProfileConformance(document, descriptor).ok).toBe(true);
        expect(checkProfileDescriptorCompatibility(document, descriptor).ok).toBe(true);
        const emission = emitHlsl(document, descriptor);
        expect(emission.ok).toBe(true);
        if (emission.ok && emission.source !== undefined) {
            expect(emission.source).toContain("float4 v_n_smp = gglab_sampleTexture2D(v_n_tp, v_n_uv);");
            expect(emission.source).toContain("Texture2D<float4> texture = ResourceDescriptorHeap[NonUniformResourceIndex(textureSamplerBinding.x)];");
            expect(emission.source).toContain("SamplerState sampler = SamplerDescriptorHeap[NonUniformResourceIndex(textureSamplerBinding.y)];");
        }
    });

    it("v2 document + a v1-line descriptor: the shared verdict refuses (PROFILE_MISMATCH — different lines)", () => {
        const document = loaded(textureV2Document());
        const descriptor = parseSurfaceProfileDescriptorFixture(canonicalV1Fixture);
        const verdict = checkProfileDescriptorCompatibility(document, descriptor);
        expect(verdict.ok).toBe(false);
        expect(verdict.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: DiagnosticCode.ProfileMismatch, severity: "error" })]),
        );
    });

    it("v2 document + a same-line descriptor that does not serialize the contract: MISSING_PROFILE_CAPABILITY", () => {
        // Serialized as descriptorVersion 1 shape (which the reader parses)
        // while declaring the profileVersion-2 line — the reader is
        // agnostic, capability is not (capability, not version numbers, decides).
        const document = loaded(textureV2Document());
        const descriptor = parseSurfaceProfileDescriptorFixture({ ...canonicalV1Fixture, profileVersion: 2 });
        const verdict = checkProfileDescriptorCompatibility(document, descriptor);
        expect(verdict.ok).toBe(false);
        expect(verdict.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: DiagnosticCode.MissingProfileCapability, severity: "error" })]),
        );
    });
});

// --- determinism at the GUI boundary -----------------------------------------

describe("save → load → compile at the GUI boundary", () => {
    it("preserves the HLSL bytes and the generated-source identity", () => {
        const original = loaded(validV1Document());
        const descriptor = parseSurfaceProfileDescriptorFixture(canonicalV1Fixture);
        const first = emitHlsl(original, descriptor);
        expect(first.ok).toBe(true);
        const firstSource = first.source;
        const firstIdentity = first.sourceMap?.generatedSourceIdentity;
        expect(firstIdentity).toMatch(/^[0-9a-f]{64}$/);

        // Save (serialize) → load (parse) → compile again.
        const saved = JSON.stringify(original, null, 2);
        const reloaded = loaded(saved);
        const second = emitHlsl(reloaded, descriptor);
        expect(second.ok).toBe(true);
        expect(second.source).toBe(firstSource);
        expect(second.sourceMap?.generatedSourceIdentity).toBe(firstIdentity);
    });

    it("canvas placement (session state) never changes the generated HLSL or identity", () => {
        const original = loaded(validV1Document());
        const descriptor = parseSurfaceProfileDescriptorFixture(canonicalV1Fixture);
        const baseline = emitHlsl(original, descriptor);
        expect(baseline.ok).toBe(true);

        const moved = {
            ...original,
            editorMetadata: {
                ...original.editorMetadata,
                nodes: {
                    ...original.editorMetadata.nodes,
                    n1: { position: { x: 123, y: 456 }, unknownFields: {} },
                    n2: { position: { x: 789, y: -12 }, unknownFields: {} },
                },
            },
        };
        const afterMove = emitHlsl(moved, descriptor);
        expect(afterMove.ok).toBe(true);
        expect(afterMove.source).toBe(baseline.source);
        expect(afterMove.sourceMap?.generatedSourceIdentity).toBe(baseline.sourceMap?.generatedSourceIdentity);
    });

    it("the flow projection keeps one node/edge per core entry (no invented entries)", () => {
        const document = loaded(textureV2Document());
        const projection = documentToFlow(document);
        expect(projection.nodes.map((node) => node.id)).toEqual(document.nodes.map((node) => node.id));
        expect(projection.edges).toHaveLength(document.connections.length);
        // Ports come from the core catalog: SampleTexture2D's RGB channel output exists in the projection.
        const sampleNode = projection.nodes.find((node) => node.data.nodeType === "SampleTexture2D");
        expect(sampleNode).toBeDefined();
        if (sampleNode !== undefined) {
            expect(sampleNode.data.outputPorts).toContain("RGB");
            expect(sampleNode.data.inputPorts).toContain("texture");
        }
    });
});
