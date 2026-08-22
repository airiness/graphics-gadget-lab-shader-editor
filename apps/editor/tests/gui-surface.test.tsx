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
import { act, render, renderHook, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
    addConnection,
    addNode,
    addParameter,
    autoLayout,
    decodeAuthoringDrop,
    diagnosticFocus,
    documentToFlow,
    DescriptorPanel,
    encodeAuthoringDrop,
    FLOW_GEOMETRY,
    flowGeometryCssVars,
    handleTop,
    libraryMatchesQuery,
    nodeCardHeight,
    nodeCatalogGroups,
    parameterChoices,
    portCenterY,
    portKind,
    portRowTop,
    portTop,
    readDescriptorText,
    resolveDropCoordinate,
    textureSignatureSerialized,
    DiagnosticsPanel,
    NodePalette,
    ReactFlowProvider,
    ShaderNode,
    useSyncedFlowNodes,
    withNodePosition,
    type AuthoringDropPayload,
    type DescriptorPanelState,
    type ShaderFlowNode,
} from "@gglab/editor-ui";
import {
    checkProfileConformance,
    checkProfileDescriptorCompatibility,
    DiagnosticCode,
    emitHlsl,
    parseShaderGraphDocument,
    parseSurfaceProfileDescriptor,
    serializeShaderGraphDocument,
    validateShaderGraph,
    type GraphConnection,
    type ShaderGraphDiagnostic,
    type ShaderGraphDocument,
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
        expect(choices).toContainEqual({ class: "ScalarParameter", valueTypes: ["float"], kind: "scalar", deferred: false });
        expect(choices).toContainEqual({ class: "VectorParameter", valueTypes: ["float2", "float3", "float4"], kind: "vector", deferred: false });
        expect(choices).toContainEqual({ class: "Texture2DParameter", valueTypes: ["Texture2D"], kind: "texture", deferred: false });
        // Deferred classes are surfaced, never authorable.
        expect(choices).toContainEqual({ class: "BoolParameter", valueTypes: [], kind: "generic", deferred: true });
        expect(choices).toContainEqual({ class: "SamplerParameter", valueTypes: [], kind: "generic", deferred: true });
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
            // Six output sockets + two input sockets (texture, uv) — the
            // real Handles, rendered one per port by the row itself.
            expect((html.match(/react-flow__handle-right/g) ?? []).length).toBe(6);
            expect((html.match(/react-flow__handle-left/g) ?? []).length).toBe(2);
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
            data: { label: "n1", nodeType: "Float", inputPorts: [], outputPorts: ["value"], inputPortKinds: [], outputPortKinds: ["scalar"], nodeCategory: "constant", knownToCatalog: true, focused: false, focusedPorts: [] },
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

// --- typed port presentation + node library filter (visual foundation) -----------

describe("typed port presentation (core types → data categories)", () => {
    it("maps the catalog's type lists to scalar / vector / texture / generic", () => {
        expect(portKind(["float"])).toBe("scalar");
        expect(portKind(["float2"])).toBe("vector");
        expect(portKind(["float3", "float"])).toBe("vector");
        expect(portKind(["float", "float2", "float3", "float4"])).toBe("vector");
        expect(portKind(["Texture2D"])).toBe("texture");
        expect(portKind([])).toBe("generic");
    });

    it("exposes per-port kinds and the node category on the projection (catalog facts only)", () => {
        const document = loaded(textureV2Document());
        const projection = documentToFlow(document);
        const sample = projection.nodes.find((node) => node.data.nodeType === "SampleTexture2D");
        expect(sample !== undefined).toBe(true);
        if (sample !== undefined) {
            expect(sample.data.nodeCategory).toBe("texture");
            expect(sample.data.inputPortKinds).toEqual(["texture", "vector"]);
            expect(sample.data.outputPortKinds).toEqual(["vector", "vector", "scalar", "scalar", "scalar", "scalar"]);
        }
        const surface = projection.nodes.find((node) => node.data.nodeType === "SurfaceOutput");
        expect(surface !== undefined).toBe(true);
        if (surface !== undefined) {
            expect(surface.data.nodeCategory).toBe("output");
            expect(surface.data.inputPortKinds).toEqual(["vector", "vector", "scalar", "scalar", "scalar"]);
        }
        // Edges carry their data category (from the producer port's core types).
        expect(projection.edges.some((edge) => edge.className?.includes("gglab-edge-kind-texture"))).toBe(true);
        expect(projection.edges.some((edge) => edge.className?.includes("gglab-edge-kind-vector"))).toBe(true);
    });

    it("renders the Handle as the port's sole socket glyph — type-colored, and no second dot in the card", () => {
        const document = loaded(textureV2Document());
        const projection = documentToFlow(document);
        const surface = projection.nodes.find((node) => node.data.nodeType === "SurfaceOutput");
        expect(surface !== undefined).toBe(true);
        if (surface !== undefined) {
            const html = renderToString(
                <ReactFlowProvider>
                    <ShaderNode {...(surface as unknown as Parameters<typeof ShaderNode>[0])} />
                </ReactFlowProvider>,
            );
            // The socket glyph is the Handle, carrying the data-category color.
            expect(html).toContain("gglab-handle-kind-vector");
            expect(html).toContain("gglab-handle-kind-scalar");
            expect(html).toContain("gglab-node-cat-output");
            // Port labels are plain text now — one visual dot per port, not two.
            expect(html).not.toContain("gglab-dot-");
            // And the count matches exactly: one Handle per input port.
            const handles = html.match(/class="[^"]*react-flow__handle[^"]*"/g) ?? [];
            expect(handles.length).toBe(5);
        }
    });

    it("every node renders exactly one Handle per port (no orphan or duplicate sockets)", () => {
        const document = loaded(textureV2Document());
        const projection = documentToFlow(document);
        const textureParameter = projection.nodes.find((node) => node.data.nodeType === "Texture2DParameter");
        const float = projection.nodes.find((node) => node.data.nodeType === "Float");
        expect(textureParameter !== undefined).toBe(true);
        expect(float !== undefined).toBe(true);
        if (textureParameter !== undefined && float !== undefined) {
            const vp = renderToString(
                <ReactFlowProvider>
                    <ShaderNode {...(textureParameter as unknown as Parameters<typeof ShaderNode>[0])} />
                </ReactFlowProvider>,
            );
            // One output port ("value") → exactly one socket.
            expect((vp.match(/class="[^"]*react-flow__handle[^"]*"/g) ?? []).length).toBe(1);
            // Input side: no port, no socket.
            expect(vp).not.toContain("react-flow__handle-left");
            const f = renderToString(
                <ReactFlowProvider>
                    <ShaderNode {...(float as unknown as Parameters<typeof ShaderNode>[0])} />
                </ReactFlowProvider>,
            );
            // Float (catalog: zero inputs, one output) → exactly one socket,
            // on the output side only.
            expect((f.match(/class="[^"]*react-flow__handle[^"]*"/g) ?? []).length).toBe(1);
            expect(f).not.toContain("react-flow__handle-left");
            expect(f).toContain("react-flow__handle-right");
            // No second socket glyph of any kind.
            expect(f).not.toContain("gglab-dot-");
        }
    });
});

describe("node library search (pure presentation filter)", () => {
    it("filters over display names only — empty query passes everything, case-insensitive", () => {
        expect(libraryMatchesQuery("", ["Multiply"])).toBe(true);
        expect(libraryMatchesQuery("  mul  ", ["Multiply", "Lerp"])).toBe(true);
        expect(libraryMatchesQuery("lerp", ["Multiply"])).toBe(false);
    });

    it("hides non-matching nodes and parameter classes (server render)", () => {
        const descriptor = parseSurfaceProfileDescriptorFixture(canonicalV1Fixture);
        const withLerp = renderToString(<NodePalette onAddNode={() => undefined} onAddParameter={() => undefined} descriptor={descriptor} query="lerp" />);
        expect(withLerp).toContain("Lerp");
        expect(withLerp).not.toContain("Multiply");
        const withTex = renderToString(<NodePalette onAddNode={() => undefined} onAddParameter={() => undefined} descriptor={descriptor} query="tex" />);
        expect(withTex).toContain("Texture2DParameter");
        expect(withTex).not.toContain("VectorParameter");
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
    it("saves through the core's .shadergraph serialization authority (not a raw object dump)", () => {
        const original = loaded(validV1Document());
        // The app's save path is the core's canonical serializer.
        const saved = serializeShaderGraphDocument(original);
        // The model's internal `unknownFields` bookkeeping keys are NOT the
        // disk format: a raw JSON.stringify(document) would emit them, and
        // the reader would re-nest retained data under a literal
        // "unknownFields" field on the way back in. The canonical form has
        // none — this is what makes save → load structurally lossless.
        expect(saved).not.toContain("\"unknownFields\"");
        // Structural round-trip closure: parse(saved) === the document.
        const reloaded = loaded(saved);
        expect(reloaded).toEqual(original);
        // …and byte-stable for a further write.
        expect(serializeShaderGraphDocument(reloaded)).toBe(saved);
    });

    it("preserves the HLSL bytes and the generated-source identity", () => {
        const original = loaded(validV1Document());
        const descriptor = parseSurfaceProfileDescriptorFixture(canonicalV1Fixture);
        const first = emitHlsl(original, descriptor);
        expect(first.ok).toBe(true);
        const firstSource = first.source;
        const firstIdentity = first.sourceMap?.generatedSourceIdentity;
        expect(firstIdentity).toMatch(/^[0-9a-f]{64}$/);

        // Save (the core's canonical serialization) → load (parse) → compile again.
        const saved = serializeShaderGraphDocument(original);
        const reloaded = loaded(saved);
        const second = emitHlsl(reloaded, descriptor);
        expect(second.ok).toBe(true);
        expect(second.source).toBe(firstSource);
        expect(second.sourceMap?.generatedSourceIdentity).toBe(firstIdentity);
    });

    it("retained unknown fields and their raw-dump corruption are both proven at the editor boundary", () => {
        // A document carrying retained forward-compatible fields at three
        // levels must survive the editor's save → load structurally.
        const fixture = JSON.parse(validV1Document()) as Record<string, unknown>;
        fixture["experimental"] = { retained: true };
        const nodes = fixture["nodes"] as Record<string, unknown>[];
        const firstNode = nodes[0];
        if (firstNode === undefined) {
            throw new Error("fixture must have a node");
        }
        firstNode["futureTintMode"] = "linear";
        const editorMetadata = (fixture["editorMetadata"] ?? { nodes: {} }) as Record<string, Record<string, Record<string, unknown>>>;
        const metaNodes = (editorMetadata["nodes"] ?? {}) as Record<string, Record<string, unknown>>;
        for (const nodeId of Object.keys(metaNodes)) {
            const state = metaNodes[nodeId];
            if (state !== undefined) {
                state["focusDepth"] = 4;
            }
        }
        const original = loaded(JSON.stringify(fixture));
        expect(original.unknownFields).toEqual({ experimental: { retained: true } });
        expect(original.nodes[0]?.unknownFields).toEqual({ futureTintMode: "linear" });

        // The core authority round-trips all of it structurally.
        const saved = serializeShaderGraphDocument(original);
        const reloaded = loaded(saved);
        expect(reloaded).toEqual(original);
        expect(serializeShaderGraphDocument(reloaded)).toBe(saved);

        // And the refused debug path is demonstrated to corrupt: a raw
        // JSON.stringify(document) emits the bookkeeping keys, which the
        // reader then re-nests — the structure is NOT preserved.
        const rawDump = JSON.stringify(original, null, 2);
        const rawReloaded = loaded(rawDump);
        expect(rawReloaded).not.toEqual(original);
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

// --- flow geometry: one source, three consumers ------------------------------

describe("flow geometry (single source of truth)", () => {
    it("handle center == port row center for every row (shared axis)", () => {
        for (const index of [0, 1, 2, 5]) {
            expect(portCenterY(index)).toBe(handleTop(index) + FLOW_GEOMETRY.handleSize / 2);
        }
    });

    it("port rows are monotonic and the card height derives from the same numbers", () => {
        expect(portRowTop(1)).toBeGreaterThan(portRowTop(0));
        expect(portRowTop(1) - portRowTop(0)).toBe(FLOW_GEOMETRY.portRowHeight);
        expect(nodeCardHeight(1)).toBe(FLOW_GEOMETRY.headerHeight + FLOW_GEOMETRY.portRowHeight + FLOW_GEOMETRY.rowsBottomPad);
        expect(portTop(0)).toBe(handleTop(0));
    });

    it("the CSS custom properties are derived from the same geometry object", () => {
        const vars = flowGeometryCssVars() as Record<string, string>;
        expect(vars["--gglab-geom-row-h"]).toBe(`${FLOW_GEOMETRY.portRowHeight}px`);
        expect(vars["--gglab-geom-node-w"]).toBe(`${FLOW_GEOMETRY.nodeWidth}px`);
        expect(vars["--gglab-geom-handle-s"]).toBe(`${FLOW_GEOMETRY.handleSize}px`);
        expect(vars["--gglab-geom-header-h"]).toBe(`${FLOW_GEOMETRY.headerHeight}px`);
    });
});

// --- auto layout: session state only -----------------------------------------

describe("auto layout (session state only)", () => {
    /** Same placement merge the composition root applies. */
    function applyAutoLayout(document: ReturnType<typeof loaded>) {
        const layout = autoLayout(document);
        const nodes = { ...document.editorMetadata.nodes };
        for (const [id, position] of Object.entries(layout.positions)) {
            nodes[id] = { position, unknownFields: {} };
        }
        return { ...document, editorMetadata: { ...document.editorMetadata, nodes } };
    }

    it("is deterministic and covers every node", () => {
        const document = loaded(validV1Document());
        const first = autoLayout(document);
        const second = autoLayout(document);
        expect(second.positions).toEqual(first.positions);
        expect(Object.keys(first.positions).sort()).toEqual(document.nodes.map((node) => node.id).sort());
        expect(first.nodeCount).toBe(document.nodes.length);
    });

    it("lays the graph out left-to-right along the connection direction", () => {
        const document = loaded(validV1Document());
        const { positions } = autoLayout(document);
        const output = positions["n.out"];
        const producerC = positions["n.c"];
        const producerR = positions["n.r"];
        if (output === undefined || producerC === undefined || producerR === undefined) {
            throw new Error("auto layout must place these fixture nodes");
        }
        // n.c (and the other producers) feed n.out — the output sits to the right.
        expect(output.x).toBeGreaterThan(producerC.x);
        expect(output.x).toBeGreaterThan(producerR.x);
    });

    it("only touches editorMetadata: semantics, validation, and emission stay identical", () => {
        const document = loaded(validV1Document());
        const descriptor = parseSurfaceProfileDescriptorFixture(canonicalV1Fixture);
        const baseline = emitHlsl(document, descriptor);
        expect(baseline.ok).toBe(true);

        const laidOut = applyAutoLayout(document);
        // Semantic fields byte-identical…
        expect(laidOut.nodes).toEqual(document.nodes);
        expect(laidOut.connections).toEqual(document.connections);
        expect(laidOut.parameters).toEqual(document.parameters);
        // …every node got an authored position…
        for (const node of document.nodes) {
            expect(laidOut.editorMetadata.nodes[node.id]).toBeDefined();
        }
        // …the core still validates it…
        expect(validateShaderGraph(laidOut).ok).toBe(true);
        // …and emission (bytes + identity) is unchanged.
        const after = emitHlsl(laidOut, descriptor);
        expect(after.ok).toBe(true);
        expect(after.source).toBe(baseline.source);
        expect(after.sourceMap?.generatedSourceIdentity).toBe(baseline.sourceMap?.generatedSourceIdentity);
    });

    it("survives self-loop connections by skipping them for layout", () => {
        const base = loaded(validV1Document());
        const selfLoop: GraphConnection = {
            id: "c.self",
            from: { nodeId: "n.r", portId: "value", unknownFields: {} },
            to: { nodeId: "n.r", portId: "value", unknownFields: {} },
            unknownFields: {},
        };
        const document = { ...base, connections: [...base.connections, selfLoop] };
        const result = autoLayout(document);
        expect(Object.keys(result.positions).sort()).toEqual(base.nodes.map((node) => node.id).sort());
    });
});

// --- node library collapse: UI session state, never document data -------------

describe("node library collapse (UI session state)", () => {
    it("collapses and reopens a section via its header (state stays in the palette)", async () => {
        render(
            <NodePalette
                onAddNode={() => {}}
                onAddParameter={() => {}}
                descriptor={parseSurfaceProfileDescriptorFixture(canonicalV1Fixture)}
            />,
        );
        const header = screen.getByRole("button", { name: /math/ });
        const section = (): HTMLElement | null => (header as HTMLElement).closest('[data-slot="collapsible-section"]');
        expect(section()?.getAttribute("data-state")).toBe("open");
        await act(async () => {
            header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(section()?.getAttribute("data-state")).toBe("closed");
        await act(async () => {
            header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(section()?.getAttribute("data-state")).toBe("open");
    });

    it("renders a rail (expand intent) instead of the library when collapsed", async () => {
        let expanded = false;
        const { container } = render(
            <NodePalette
                rail
                onAddNode={() => {}}
                onAddParameter={() => {}}
                descriptor={null}
                onExpandLibrary={() => {
                    expanded = true;
                }}
            />,
        );
        // Scope to this render: RTL auto-cleanup is not registered here, so
        // earlier mounts may still be attached to the shared document.
        expect(within(container).queryByText("Multiply")).toBeNull();
        const expandButton = within(container).getByRole("button", { name: /node library/i });
        await act(async () => {
            expandButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(expanded).toBe(true);
    });

    it("collapse-all / expand-all, and an active search keeps matched sections visible", async () => {
        const descriptor = parseSurfaceProfileDescriptorFixture(canonicalV1Fixture);
        const { container, rerender } = render(
            <NodePalette onAddNode={() => {}} onAddParameter={() => {}} descriptor={descriptor} query="" />,
        );
        const sections = (): HTMLElement[] =>
            Array.from(container.querySelectorAll('[data-slot="collapsible-section"]')) as HTMLElement[];
        expect(sections().length).toBeGreaterThan(1);

        // Collapse all → every section closed.
        const collapseAll = within(container).getByRole("button", { name: /collapse all/i });
        await act(async () => {
            collapseAll.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        for (const section of sections()) {
            expect(section.getAttribute("data-state")).toBe("closed");
        }

        // An active search must force the matched section open…
        rerender(<NodePalette onAddNode={() => {}} onAddParameter={() => {}} descriptor={descriptor} query="mul" />);
        const matched = sections().filter((section) => (section.textContent ?? "").includes("Multiply"));
        expect(matched.length).toBeGreaterThan(0);
        for (const section of matched) {
            expect(section.getAttribute("data-state")).toBe("open");
        }

        // …and the user's previous choice is restored when the search clears.
        rerender(<NodePalette onAddNode={() => {}} onAddParameter={() => {}} descriptor={descriptor} query="" />);
        for (const section of matched) {
            expect(section.getAttribute("data-state")).toBe("closed");
        }

        // Expand all → everything open again.
        const expandAll = within(container).getByRole("button", { name: /expand all/i });
        await act(async () => {
            expandAll.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        for (const section of sections()) {
            expect(section.getAttribute("data-state")).toBe("open");
        }
    });
});

// --- palette → canvas drag and drop (authoring intent + coordinate) ---------

describe("palette → canvas drag and drop", () => {
    it("drag payload round-trips and rejects anything that is not a known payload", () => {
        const node: AuthoringDropPayload = { kind: "node", nodeType: "Float3" };
        expect(decodeAuthoringDrop(encodeAuthoringDrop(node))).toEqual(node);
        const parameter: AuthoringDropPayload = { kind: "parameter", parameterClass: "ScalarParameter", valueType: "float" };
        expect(decodeAuthoringDrop(encodeAuthoringDrop(parameter))).toEqual(parameter);
        expect(decodeAuthoringDrop("")).toBeNull();
        expect(decodeAuthoringDrop("not json")).toBeNull();
        expect(decodeAuthoringDrop(JSON.stringify({ kind: "node" }))).toBeNull();
        expect(decodeAuthoringDrop(JSON.stringify({ kind: "alien", nodeType: "X" }))).toBeNull();
    });

    it("marks node and parameter entries as drag sources (click-to-add remains)", () => {
        const descriptor = parseSurfaceProfileDescriptorFixture(canonicalV1Fixture);
        const html = renderToString(<NodePalette onAddNode={() => {}} onAddParameter={() => {}} descriptor={descriptor} />);
        // Node entries are draggable HTML5 DnD sources…
        expect(html).toContain("gglab-palette-draggable");
        expect(html).toMatch(/draggable/);
        // …and the usage hint tells the user both interactions.
        expect(html).toContain("Drag an entry onto the canvas");
    });

    it("rejects a parameter payload whose valueType is outside the core's GraphType vocabulary", () => {
        // The runtime string boundary is closed at the decode boundary,
        // with the core's own authority (isGraphType): no downstream cast
        // can turn an untrusted string into a GraphType.
        const bad = JSON.stringify({ kind: "parameter", parameterClass: "ScalarParameter", valueType: "banana" });
        expect(decodeAuthoringDrop(bad)).toBeNull();
        // A legal vocabulary member decodes and stays typed.
        const good = JSON.stringify({ kind: "parameter", parameterClass: "ScalarParameter", valueType: "float" });
        const decoded = decodeAuthoringDrop(good);
        expect(decoded).not.toBeNull();
        if (decoded !== null && decoded.kind === "parameter") {
            expect(decoded.valueType).toBe("float");
        }
    });

    it("a drop with no ready flow instance is a no-op (never a silent (0,0) creation)", () => {
        // Instance not ready / transform unavailable → no coordinate.
        expect(resolveDropCoordinate(null, { x: 400, y: 300 })).toBeNull();
        expect(resolveDropCoordinate({} as { screenToFlowPosition?: (point: { x: number; y: number }) => { x: number; y: number } }, { x: 400, y: 300 })).toBeNull();
        // A ready instance resolves through its own transform, rounded to int.
        const instance = { screenToFlowPosition: (point: { x: number; y: number }) => ({ x: point.x / 2 + 0.4, y: point.y / 2 - 0.6 }) };
        expect(resolveDropCoordinate(instance, { x: 400, y: 300 })).toEqual({ x: 200, y: 149 });
    });

    it("a node drop seeds the initial position in editorMetadata (atomic, core-judged)", () => {
        const base = loaded(validV1Document());
        // Seed pre-existing editor-state metadata on an unrelated node…
        const seeded = withNodePosition(base, "n.r", { x: 5, y: 5 });
        const withMeta: ShaderGraphDocument = {
            ...seeded,
            editorMetadata: {
                ...seeded.editorMetadata,
                nodes: { ...seeded.editorMetadata.nodes, "n.r": { ...(seeded.editorMetadata.nodes["n.r"] as object), unknownFields: { gizmo: 42 } } },
            },
        };
        const result = addNode(withMeta, "Float", { position: { x: 123, y: 45 } });
        expect(result.applied).toBe(true);
        expect(result.document.nodes).toHaveLength(base.nodes.length + 1);
        expect(result.createdId).toBeDefined();
        if (result.createdId !== undefined) {
            expect(result.document.editorMetadata.nodes[result.createdId]?.position).toEqual({ x: 123, y: 45 });
        }
        // …and a drop must not disturb metadata it does not own.
        expect(result.document.editorMetadata.nodes["n.r"]?.unknownFields).toEqual({ gizmo: 42 });
    });

    it("a parameter drop goes through the atomic addParameter authority, with position in the same operation", () => {
        const base = loaded(validV1Document());
        const result = addParameter(
            base,
            { name: "New Parameter", class: "ScalarParameter", valueType: "float" },
            { position: { x: 77, y: 88 } },
        );
        expect(result.applied).toBe(true);
        expect(result.document.parameters).toHaveLength(base.parameters.length + 1);
        expect(result.document.nodes).toHaveLength(base.nodes.length + 1);
        if (result.createdId !== undefined) {
            expect(result.document.editorMetadata.nodes[result.createdId]?.position).toEqual({ x: 77, y: 88 });
        }
    });

    it("an uncreatable parameter class is refused atomically (unchanged input, no position side-effect)", () => {
        const base = loaded(validV1Document());
        const result = addParameter(
            base,
            { name: "New Parameter", class: "GhostParameter", valueType: "float" },
            { position: { x: 1, y: 2 } },
        );
        expect(result.applied).toBe(false);
        expect(result.document).toBe(base);
        expect(result.createdId).toBeUndefined();
    });
});

// --- position patch preserves editor metadata (regression) ------------------

describe("position patching preserves existing editor metadata", () => {
    it("patching a position only touches position — unknownFields survive (drag + auto layout)", () => {
        const base = loaded(validV1Document());
        let seeded = withNodePosition(base, "n.r", { x: 1, y: 1 });
        // Simulate newer presentation metadata already present on the node…
        seeded = {
            ...seeded,
            editorMetadata: {
                ...seeded.editorMetadata,
                nodes: {
                    ...seeded.editorMetadata.nodes,
                    "n.r": { ...(seeded.editorMetadata.nodes["n.r"] as object), unknownFields: { gizmo: 42, nested: { a: 1 } } },
                },
            },
        };
        // …a drag-placement patch keeps it…
        const patched = withNodePosition(seeded, "n.r", { x: 9, y: 9 });
        expect(patched.editorMetadata.nodes["n.r"]?.position).toEqual({ x: 9, y: 9 });
        expect(patched.editorMetadata.nodes["n.r"]?.unknownFields).toEqual({ gizmo: 42, nested: { a: 1 } });
        expect(patched.nodes).toEqual(seeded.nodes);

        // …and a full auto-layout pass (through the same helper) keeps it too.
        const layout = autoLayout(seeded);
        let laidOut = seeded;
        for (const [id, position] of Object.entries(layout.positions)) {
            laidOut = withNodePosition(laidOut, id, position);
        }
        expect(laidOut.editorMetadata.nodes["n.r"]?.unknownFields).toEqual({ gizmo: 42, nested: { a: 1 } });

        // …with emission (bytes + identity) still unchanged.
        const descriptor = parseSurfaceProfileDescriptorFixture(canonicalV1Fixture);
        expect(emitHlsl(laidOut, descriptor).sourceMap?.generatedSourceIdentity).toBe(
            emitHlsl(base, descriptor).sourceMap?.generatedSourceIdentity,
        );
    });
});

// --- action affordance (chrome kit) -----------------------------------------

describe("action affordance (chrome kit)", () => {
    it("the descriptor panel's Open file is a clear neutral action (secondary, icon, pressed/focus states)", () => {
        const html = renderToString(<DescriptorPanel state={{ kind: "empty" }} onStateChange={() => {}} />);
        const button = html.match(/<button[^>]*>[\s\S]*?Open descriptor file/);
        expect(button).not.toBeNull();
        const tag = button !== null && button[0] !== undefined ? button[0].slice(0, button[0].indexOf(">") + 1) : "";
        // Secondary raised surface — deliberately NOT a saturated-CTA primary.
        expect(tag).toContain("bg-raised");
        expect(tag).toContain("border-border");
        // Physical + keyboard affordance from the button design language.
        expect(tag).toContain("active:translate-y-px");
        expect(tag).toContain("focus-visible:outline-ring");
        // Icon glyph present in the action.
        expect(html).toContain("<svg");
    });
});

// --- desktop slice 1: host file-open injection into the descriptor panel -----

describe("descriptor panel: host file-open injection (desktop)", () => {
    it("uses the injected host open and feeds its text to the core reader", async () => {
        const states: DescriptorPanelState[] = [];
        const { unmount } = render(
            <DescriptorPanel
                state={{ kind: "empty" }}
                onStateChange={(state) => states.push(state)}
                openDescriptorFile={async () => ({ name: "descriptor.json", text: JSON.stringify(canonicalV2Fixture) })}
            />,
        );
        const button = screen.getByRole("button", { name: /open descriptor file/i });
        await act(async () => {
            void button.click();
        });
        expect(states).toHaveLength(1);
        expect(states[0]).toMatchObject({ kind: "ready" });
        if (states[0] !== undefined) {
            expect(states[0]).toEqual({ kind: "ready", descriptor: parseSurfaceProfileDescriptorFixture(canonicalV2Fixture) });
        }
        unmount();
    });

    it("a cancelled host open leaves the panel state untouched (no spurious change)", async () => {
        const states: DescriptorPanelState[] = [];
        const { unmount } = render(
            <DescriptorPanel
                state={{ kind: "empty" }}
                onStateChange={(state) => states.push(state)}
                openDescriptorFile={async () => null}
            />,
        );
        const button = screen.getByRole("button", { name: /open descriptor file/i });
        await act(async () => {
            void button.click();
        });
        expect(states).toHaveLength(0);
        unmount();
    });

    it("a rejected host read surfaces the core reader's verdict, not a crash", async () => {
        const states: DescriptorPanelState[] = [];
        const { unmount } = render(
            <DescriptorPanel
                state={{ kind: "empty" }}
                onStateChange={(state) => states.push(state)}
                openDescriptorFile={async () => ({ name: "broken.json", text: "{ not a descriptor" })}
            />,
        );
        const button = screen.getByRole("button", { name: /open descriptor file/i });
        await act(async () => {
            void button.click();
        });
        expect(states).toHaveLength(1);
        expect(states[0]).toMatchObject({ kind: "rejected" });
        unmount();
    });

    it("a host IO failure (file vanished after the dialog) is an explicit rejected state, not an unhandled rejection", async () => {
        const states: DescriptorPanelState[] = [];
        const { unmount } = render(
            <DescriptorPanel
                state={{ kind: "empty" }}
                onStateChange={(state) => states.push(state)}
                openDescriptorFile={async () => {
                    throw new Error("Access to the scoped file is denied by the host");
                }}
            />,
        );
        const button = screen.getByRole("button", { name: /open descriptor file/i });
        await act(async () => {
            void button.click();
        });
        expect(states).toHaveLength(1);
        expect(states[0]).toMatchObject({ kind: "rejected", diagnosticCode: "IO" });
        if (states[0] !== undefined && (states[0] as { kind?: string }).kind === "rejected") {
            expect((states[0] as { diagnosticMessage: string }).diagnosticMessage).toContain("denied");
        }
        unmount();
    });
});
