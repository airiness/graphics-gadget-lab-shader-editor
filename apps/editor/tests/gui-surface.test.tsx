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
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/editor-ui/src");
const appCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/app.css"), "utf8");
const read = (relative: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), "utf8");
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
    EDGE_HIT_WIDTH,
    FLOW_GEOMETRY,
    flowGeometryCssVars,
    handleStyle,
    handleTop,
    isEditingTextTarget,
    libraryMatchesQuery,
    nodeCardHeight,
    nodeCatalogGroups,
    parameterChoices,
    portCenterY,
    portKind,
    portRowTop,
    portTop,
    readDescriptorText,
    removeConnection,
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
    getNodeDefinition,
    parseShaderGraphDocument,
    resolveGraphTypes,
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

function scalarMultiplyDocument(): string {
    return JSON.stringify({
        schemaVersion: 1,
        graphId: "graph.gui-mul-s",
        profile: "gglab.surface",
        profileVersion: 1,
        parameters: [],
        nodes: [
            { id: "n.f1", type: "Float", version: 1, properties: { value: 1 } },
            { id: "n.f2", type: "Float", version: 1, properties: { value: 1 } },
            { id: "n.m", type: "Multiply", version: 1, properties: {} },
        ],
        connections: [
            { id: "c1", from: { nodeId: "n.f1", portId: "value" }, to: { nodeId: "n.m", portId: "a" } },
            { id: "c2", from: { nodeId: "n.f2", portId: "value" }, to: { nodeId: "n.m", portId: "b" } },
        ],
        editorMetadata: { nodes: {} },
    });
}

function vectorMultiplyDocument(): string {
    return JSON.stringify({
        schemaVersion: 1,
        graphId: "graph.gui-mul-v",
        profile: "gglab.surface",
        profileVersion: 1,
        parameters: [],
        nodes: [
            { id: "n.v1", type: "Float3", version: 1, properties: { value: [1, 1, 1] } },
            { id: "n.v2", type: "Float3", version: 1, properties: { value: [1, 0, 0] } },
            { id: "n.m", type: "Multiply", version: 1, properties: {} },
        ],
        connections: [
            { id: "c1", from: { nodeId: "n.v1", portId: "value" }, to: { nodeId: "n.m", portId: "a" } },
            { id: "c2", from: { nodeId: "n.v2", portId: "value" }, to: { nodeId: "n.m", portId: "b" } },
        ],
        editorMetadata: { nodes: {} },
    });
}

function loneMultiplyDocument(): string {
    return JSON.stringify({
        schemaVersion: 1,
        graphId: "graph.gui-mul-0",
        profile: "gglab.surface",
        profileVersion: 1,
        parameters: [],
        nodes: [{ id: "n.m", type: "Multiply", version: 1, properties: {} }],
        connections: [],
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
        expect(portTop(5) - portTop(0)).toBe(5 * FLOW_GEOMETRY.portRowHeight);
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
            data: { label: "n1", nodeType: "Float", inputPorts: [], outputPorts: ["value"], inputPortKinds: [], outputPortKinds: ["scalar"], inputPortTypes: [], outputPortTypes: ["float"], nodeCategory: "constant", knownToCatalog: true, focused: false, focusedPorts: [] },
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
    it("classifies type sets honestly: pure sets map to their family, crossing sets map to generic", () => {
        expect(portKind(["float"])).toBe("scalar");
        expect(portKind(["float2"])).toBe("vector");
        expect(portKind(["float2", "float3", "float4"])).toBe("vector");
        // Crossing scalar AND vector: the port accepts either, so neither
        // family may be forced — a concrete type never hits this case
        // (a single type is a pure set).
        expect(portKind(["float3", "float"])).toBe("generic");
        expect(portKind(["float", "float2", "float3", "float4"])).toBe("generic");
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

    it("colors follow the RESOLVED concrete type — tooltip, socket, and edge always tell one story", () => {
        const valueIndex = (nodeData: { readonly outputPorts: readonly string[] }) => nodeData.outputPorts.indexOf("value");
        // Multiply fed by two scalar constants: value resolves to float →
        // scalar everywhere (tooltip "float", scalar socket, scalar edge).
        const scalar = documentToFlow(loaded(scalarMultiplyDocument()));
        const m1 = scalar.nodes.find((node) => node.data.nodeType === "Multiply");
        expect(m1 !== undefined).toBe(true);
        if (m1 !== undefined) {
            expect(m1.data.outputPortTypes[valueIndex(m1.data)]).toBe("float");
            expect(m1.data.outputPortKinds[valueIndex(m1.data)]).toBe("scalar");
        }
        expect(scalar.edges.every((edge) => edge.className?.includes("gglab-edge-kind-scalar"))).toBe(true);
        // Same node fed by float3 constants: everything flips to vector.
        const vector = documentToFlow(loaded(vectorMultiplyDocument()));
        const m2 = vector.nodes.find((node) => node.data.nodeType === "Multiply");
        expect(m2 !== undefined).toBe(true);
        if (m2 !== undefined) {
            expect(m2.data.outputPortTypes[valueIndex(m2.data)]).toBe("float3");
            expect(m2.data.outputPortKinds[valueIndex(m2.data)]).toBe("vector");
        }
        expect(vector.edges.every((edge) => edge.className?.includes("gglab-edge-kind-vector"))).toBe(true);
        // Unresolved: the crossing declared set is honestly NEUTRAL (generic),
        // not a forced vector — matching its own tooltip union.
        const lone = documentToFlow(loaded(loneMultiplyDocument()));
        const m0 = lone.nodes.find((node) => node.data.nodeType === "Multiply");
        expect(m0 !== undefined).toBe(true);
        if (m0 !== undefined) {
            expect(m0.data.inputPortKinds).toEqual(["generic", "generic"]);
            expect(m0.data.inputPortTypes).toEqual(["float/float2/float3/float4", "float/float2/float3/float4"]);
            expect(m0.data.outputPortKinds).toEqual(["generic"]);
            expect(m0.data.outputPortTypes).toEqual(["float/float2/float3/float4"]);
        }
    });

    it("per-port invariant: the socket kind equals the classification of the tooltip string", () => {
        // The exact self-contradiction guard: for every port in the seed
        // graph, re-derive the kind from the DISPLAY string alone and
        // require it to equal the carried kind — tooltip and color can
        // never disagree.
        const projection = documentToFlow(loaded(textureV2Document()));
        for (const node of projection.nodes) {
            for (let index = 0; index < node.data.inputPortKinds.length; index += 1) {
                const display = node.data.inputPortTypes[index];
                if (display !== undefined) {
                    expect(node.data.inputPortKinds[index]).toBe(portKind(display.split("/")));
                }
            }
            for (let index = 0; index < node.data.outputPortKinds.length; index += 1) {
                const display = node.data.outputPortTypes[index];
                if (display !== undefined) {
                    expect(node.data.outputPortKinds[index]).toBe(portKind(display.split("/")));
                }
            }
        }
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

    it("keeps the tightened anatomy: header divider, full-height category rail, compact port rhythm", () => {
        // The three-tier separation is structural, not just typographic:
        // a 1px divider between the identity header and the port body.
        expect(appCss).toMatch(/\.gglab-node-header[\s\S]*?border-bottom: 1px solid var\(--border\)/);
        // The category identity stripe runs the FULL height of the card
        // (left corners follow the card radius; straight right edge).
        expect(appCss).toMatch(/\.gglab-node::before[\s\S]*?top: 0;[\s\S]*?bottom: 0;[\s\S]*?border-radius: var\(--r-2\) 0 0 var\(--r-2\)/);
        // The category chip uses the kit's corner token, not a stray px.
        expect(appCss).toMatch(/\.gglab-node-category[\s\S]*?border-radius: var\(--r-1\)/);
        // The compacted port rhythm lives in the single geometry source.
        expect(FLOW_GEOMETRY.portRowHeight).toBe(24);
        expect(FLOW_GEOMETRY.rowsBottomPad).toBe(8);
    });

    it("keeps the three canvas overlays on ONE toolbar language (positions frozen)", () => {
        // Same recipe on all three: raised surface + 1px --border + --r-1.
        expect(appCss).toMatch(/\.react-flow__controls \{[\s\S]*?border: 1px solid var\(--border\);[\s\S]*?border-radius: var\(--r-1\)/);
        expect(appCss).toMatch(/\.react-flow__controls-button \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;[\s\S]*?background: var\(--panel-hi\)/);
        // Icons at the kit's 14px, hover = the kit's one-step-brighter surface.
        expect(appCss).toMatch(/\.react-flow__controls-button svg \{[\s\S]*?max-width: 14px;/);
        expect(appCss).toMatch(/\.react-flow__controls-button:hover:not\(:disabled\) \{[\s\S]*?background: var\(--border-soft\)/);
        // The minimap frame joins the same recipe (was a step darker).
        expect(appCss).toMatch(/\.react-flow__minimap \{[\s\S]*?background: var\(--panel-hi\) !important;[\s\S]*?border: 1px solid var\(--border\);[\s\S]*?border-radius: var\(--r-1\)/);
        // Corners and equal margins frozen (controls top-right, minimap
        // bottom-right) — the language unifies, the layout does not move.
        expect(appCss).toMatch(/\.react-flow__controls \{[\s\S]*?margin: 12px;/);
        expect(appCss).toMatch(/\.gglab-minimap \{[\s\S]*?margin: 12px;/);
        const viewportSource = read("../../../packages/editor-ui/src/flow/flow-viewport.tsx");
        expect(viewportSource).toContain('position="top-right"');
        expect(viewportSource).toContain('position="bottom-right"');
    });

    it("keeps the close prompt: strong veil, topmost card on token elevation, frozen Save/Don't Save/Cancel order", () => {
        // Visual language (this block's only mandate; the close state
        // machine itself is frozen behavior and stays in app.tsx).
        expect(appCss).toMatch(/\.gglab-close-prompt \{[\s\S]*?color-mix\(in srgb, var\(--bg\) 70%, transparent\)/);
        expect(appCss).toMatch(/\.gglab-close-prompt-card \{[\s\S]*?background: var\(--panel-2\);[\s\S]*?border-radius: var\(--r-2\);[\s\S]*?box-shadow: var\(--shadow-2\)/);
        expect(appCss).toMatch(/\.gglab-close-prompt-title \{[\s\S]*?font-size: var\(--type-display\);[\s\S]*?font-weight: var\(--weight-strong\)/);
        expect(appCss).toMatch(/\.gglab-close-prompt-text \{[\s\S]*?margin: 0 0 14px;/);
        // Button system: the kit (no parallel classes), Save is the ONE
        // primary action, and the owner-chosen order holds in the source.
        const appSource = read("../src/app.tsx");
        const save = appSource.indexOf('chooseCloseChoice("save")');
        const discard = appSource.indexOf('chooseCloseChoice("discard")');
        const cancel = appSource.indexOf('chooseCloseChoice("cancel")');
        expect(save).toBeGreaterThan(-1);
        expect(discard).toBeGreaterThan(save);
        expect(cancel).toBeGreaterThan(discard);
        const saveRow = appSource.slice(save - 220, save);
        expect(saveRow).toContain('variant="primary"');
        const discardRow = appSource.slice(discard - 220, discard);
        expect(discardRow).toContain('variant="secondary"');
        const cancelRow = appSource.slice(cancel - 220, cancel);
        expect(cancelRow).toContain('variant="ghost"');
    });

    // ---- connection lifecycle (first interaction slice) -------------------
    describe("connection lifecycle", () => {
        it("removes exactly the selected connection through the authoring path, preserving everything else", () => {
            const document = loaded(validV1Document()); // c1..c5
            const result = removeConnection(document, "c3");
            expect(result.applied).toBe(true);
            expect(result.refusal).toBeUndefined();
            expect(result.document).not.toBe(document); // a new document, not a mutation
            expect(result.document?.nodes).toEqual(document.nodes);
            expect(result.document?.parameters).toEqual(document.parameters);
            expect(result.document?.editorMetadata).toEqual(document.editorMetadata);
            const remaining = result.document?.connections ?? [];
            expect(remaining.map((entry) => entry.id)).toEqual(["c1", "c2", "c4", "c5"]); // order + ids untouched
            // The input document is untouched (atomic).
            expect(document.connections).toHaveLength(5);
        });

        it("refuses a stale connection id without mutating, instead of silently succeeding", () => {
            const document = loaded(validV1Document());
            const result = removeConnection(document, "c99");
            expect(result.applied).toBe(false);
            expect(result.document).toBe(document); // the unchanged input, by reference
            expect(result.refusal?.reason).toContain("c99");
            expect(document.connections).toHaveLength(5);
        });

        it("never treats selection as a document change: the same document, emphasis only", () => {
            const document = loaded(validV1Document());
            const withSelection = documentToFlow(document, null, "c2");
            const withoutSelection = documentToFlow(document, null, null);
            expect(document.connections).toHaveLength(5); // selecting never edits
            const selectedEdge = withSelection.edges.find((edge) => edge.id === "c2");
            expect(selectedEdge).toBeDefined();
            expect(selectedEdge?.selected).toBe(true);
            expect(selectedEdge?.className).toContain("gglab-edge-selected");
            // The kind class stays — selection emphasizes, it never re-colors.
            expect(selectedEdge?.className).toMatch(/gglab-edge-kind-(scalar|vector|texture|generic)/);
            // Every other edge stays unselected.
            expect(withSelection.edges.filter((edge) => edge.selected === true)).toHaveLength(1);
            expect(withSelection.edges.find((edge) => edge.id === "c5")?.selected).toBe(false);
            expect(withoutSelection.edges.every((edge) => edge.selected === false)).toBe(true);
        });

        it("keeps wires thin to read (2px stroke) but wide to press (hit width) at any zoom", () => {
            expect(EDGE_HIT_WIDTH).toBeGreaterThanOrEqual(10);
            expect(EDGE_HIT_WIDTH).toBeLessThanOrEqual(14);
            const projection = documentToFlow(loaded(validV1Document()));
            expect(projection.edges.every((edge) => edge.interactionWidth === EDGE_HIT_WIDTH)).toBe(true);
        });

        it("keeps removal possible on an invalid graph (removal does not judge validity)", () => {
            const base = loaded(validV1Document());
            // Break the graph first: a self-loop makes the document invalid.
            const broken: GraphConnection = {
                id: "c.loop",
                from: { nodeId: "n.out", portId: "BaseColor", unknownFields: {} },
                to: { nodeId: "n.out", portId: "BaseColor", unknownFields: {} },
                unknownFields: {},
            };
            const invalid = { ...base, connections: [...base.connections, broken] };
            const validation = validateShaderGraph(invalid);
            expect(validation.diagnostics.length).toBeGreaterThan(0);
            // ...and the selection → deletion path still works exactly as
            // it would on a valid graph.
            const result = removeConnection(invalid, "c.loop");
            expect(result.applied).toBe(true);
            expect(result.document?.connections).toEqual(base.connections);
        });

        it("guards graph shortcuts away from text fields via one shared predicate", () => {
            const input = document.createElement("input");
            const textarea = document.createElement("textarea");
            document.body.appendChild(input);
            document.body.appendChild(textarea);
            const editable = document.createElement("div");
            editable.setAttribute("contenteditable", "true");
            document.body.appendChild(editable);
            const plain = document.createElement("div");
            document.body.appendChild(plain);
            expect(isEditingTextTarget(input)).toBe(true);
            expect(isEditingTextTarget(textarea)).toBe(true);
            expect(isEditingTextTarget(editable)).toBe(true);
            expect(isEditingTextTarget(plain)).toBe(false);
            expect(isEditingTextTarget(document.body)).toBe(false);
            expect(isEditingTextTarget(null)).toBe(false);
            input.remove();
            textarea.remove();
            editable.remove();
            plain.remove();
        });

        it("wires the loop end to end: core-owned deletion, session selection, guarded Delete/Backspace, one-item RMB menu", () => {
            const viewport = read("../../../packages/editor-ui/src/flow/flow-viewport.tsx");
            // React Flow must not own the key-delete (it would bypass the
            // session state and the core's atomic operation).
            expect(viewport).toContain("deleteKeyCode={null}");
            expect(viewport).toContain("onEdgeClick=");
            expect(viewport).toContain("onEdgeContextMenu=");
            expect(viewport).toContain("onPaneClick=");
            const app = read("../src/app.tsx");
            // Delete/Backspace only when the shared guard says the
            // keyboard belongs to the editor.
            expect(app).toMatch(/isEditingTextTarget\(event\.target\)/);
            expect(app).toMatch(/event\.key === "Delete" \|\| event\.key === "Backspace"/);
            // The deletion always rides the core's operation through the
            // authoring path — never `edges.filter`.
            expect(app).toMatch(/applyAuthoring\(removeConnection\(document, connectionId\)\)/);
            expect(app).not.toMatch(/setEdges\(/);
            // Selection is session state; the projection receives it.
            expect(app).toMatch(/documentToFlow\(document, focus, selectedConnectionId\)/);
            expect(app).not.toMatch(/selected.*\.shadergraph/);
            // The context menu carries the ONE destructive action + the key
            // hint, on the kit's button (no parallel button classes).
            expect(app).toContain("Delete Connection");
            expect(app).toMatch(/className="gglab-kbd"[^]*?>\s*Del\s*</);
            expect(app).toContain('aria-label="Connection actions"');
            // CSS: selection = same-hue emphasis (thicker + glow), hover =
            // brightness (hue cannot change), wide hit target is in the
            // projection (not a stroked line), menu on the top chrome card.
            expect(appCss).toMatch(/\.gglab-edge-selected \.react-flow__edge-path \{[\s\S]*?stroke-width: 3;[\s\S]*?drop-shadow\(0 0 5px var\(--gglab-edge-glow\)\)/);
            expect(appCss).toMatch(/\.react-flow__edge:hover \.react-flow__edge-path \{[\s\S]*?filter: brightness\(1\.35\)/);
            expect(appCss).toMatch(/\.react-flow__edge\.gglab-edge-kind-scalar \{[\s\S]*?--gglab-edge-glow: color-mix\(in srgb, var\(--kind-scalar\) 55%, transparent\)/);
            expect(appCss).toMatch(/\.gglab-edge-menu \{[\s\S]*?background: var\(--panel-2\);[\s\S]*?box-shadow: var\(--shadow-2\)/);
        });
    });

    it("keeps both side rails on one language: library and inspector collapse to the same 48px rail", () => {
        // Grid states compose: each rail alone, and both together
        // (canvas maximization) — 48px on the collapsed side(s).
        expect(appCss).toMatch(/\.gglab-body-inspector-collapsed \{[\s\S]*?grid-template-columns: 252px minmax\(0, 1fr\) 48px;/);
        expect(appCss).toMatch(/\.gglab-body-library-collapsed\.gglab-body-inspector-collapsed \{[\s\S]*?grid-template-columns: 48px minmax\(0, 1fr\) 48px;/);
        // ONE shared rail language (renamed from the library private):
        // both sides use .gglab-side-rail / .gglab-rail-btn / .gglab-rail-text.
        expect(appCss).toMatch(/\.gglab-side-rail \{[\s\S]*?display: flex;/);
        const paletteSource = read("../../../packages/editor-ui/src/palette/node-palette.tsx");
        expect(paletteSource).toContain("gglab-side-rail");
        expect(paletteSource).not.toContain("gglab-library-rail");
        // The composition root owns BOTH rail states and the same button
        // pair (shared icons, one source in components/icons).
        const appSource = read("../src/app.tsx");
        expect(appSource).toContain("gglab-body-inspector-collapsed");
        expect(appSource).toContain('aria-label="Collapse the inspector"');
        expect(appSource).toContain('<span className="gglab-rail-text">Inspector</span>');
        expect(appSource).toContain("PanelCloseIcon");
        expect(appSource).toContain("PanelOpenIcon");
    });

    it("keeps the chrome ladder: canvas recedes, frame and raised content stay ordered, faint reads at AA", () => {
        // Elevation order (darkest → lightest): canvas < chrome frame <
        // raised content < hover surface. Canvas and frame already use
        // the lowest steps in the existing design; lock that the ladder
        // stays a single ordered scale.
        expect(appCss).toMatch(/--bg: #0f1319;[\s\S]*--panel: #151b23;[\s\S]*--panel-2: #1a222d;[\s\S]*--panel-hi: #202a37;/);
        expect(appCss).toMatch(/\.gglab-viewport[\s\S]*?background: var\(--bg\)/);
        expect(appCss).toMatch(/\.gglab-header[\s\S]*?background: var\(--panel\)/);
        expect(appCss).toMatch(/\.gglab-statusbar[\s\S]*?background: var\(--panel\)/);
        // Faint text meets AA on the raised surface (small meta text,
        // diagnostic paths, hints must stay readable).
        expect(appCss).toContain("--faint: #7b89a1");
        // Slim, surface-agnostic scrollbar (transparent inset, hover step).
        expect(appCss).toMatch(/::-webkit-scrollbar[\s\S]*?width: 8px;/);
        expect(appCss).toMatch(/::-webkit-scrollbar-thumb[\s\S]*?border: 2px solid transparent/);
        expect(appCss).toMatch(/::-webkit-scrollbar-thumb:hover[\s\S]*?background: var\(--border-hi\)/);
    });

    it("keeps diagnostics as a dense list: hairline separation and a clear code > message > meta hierarchy", () => {
        expect(appCss).toMatch(/\.gglab-diagnostics-item[\s\S]*?padding: 8px 6px/);
        expect(appCss).toMatch(/\.gglab-diagnostics-item \+ \.gglab-diagnostics-item[\s\S]*?border-top: 1px solid var\(--border-soft\)/);
        expect(appCss).toMatch(/\.gglab-diagnostics-severity[\s\S]*?color: var\(--faint\)/);
        // The severity SIGNAL stays on the tinted code (core's severity
        // string drives the class; the panel renders it).
        expect(appCss).toMatch(/\.gglab-diagnostics-severity-error \.gglab-diagnostics-code[\s\S]*?color: var\(--error\)/);
        expect(appCss).toMatch(/\.gglab-diagnostics-severity-warning \.gglab-diagnostics-code[\s\S]*?color: var\(--warn\)/);
    });

    it("port rows carry the core's type facts — resolved concrete type, else the declared set; never a UI guess", () => {
        const document = loaded(textureV2Document());
        const projection = documentToFlow(document);
        // Independent re-derivation from the core's own authorities
        // (resolver + catalog declaration + document connections): the
        // projection's display strings must EQUAL these exactly.
        const resolved = resolveGraphTypes(document);
        for (const node of projection.nodes) {
            const docNode = document.nodes.find((candidate) => candidate.id === node.id);
            const definition = docNode !== undefined ? getNodeDefinition(docNode.type) : undefined;
            if (docNode === undefined || definition === undefined) {
                continue;
            }
            for (let index = 0; index < node.data.outputPorts.length; index += 1) {
                const portId = node.data.outputPorts[index];
                if (portId === undefined) {
                    continue;
                }
                const declared = definition.outputs.find((port) => port.id === portId)?.types.join("/") ?? "";
                const expected = resolved.typeAt(node.id, portId) ?? declared;
                expect(node.data.outputPortTypes[index]).toBe(expected);
            }
            for (let index = 0; index < node.data.inputPorts.length; index += 1) {
                const portId = node.data.inputPorts[index];
                if (portId === undefined) {
                    continue;
                }
                const source = document.connections.find((connection) => connection.to.nodeId === node.id && connection.to.portId === portId)?.from;
                const sourceType = source !== undefined ? resolved.typeAt(source.nodeId, source.portId) : undefined;
                const declared = definition.inputs.find((port) => port.id === portId)?.types.join("/") ?? "";
                const expected = sourceType ?? declared;
                expect(node.data.inputPortTypes[index]).toBe(expected);
            }
        }
        // The core's own channel facts surface verbatim (SampleTexture2D:
        // RGB is float3, the B channel is float).
        const sampler = projection.nodes.find((node) => node.data.nodeType === "SampleTexture2D");
        expect(sampler !== undefined).toBe(true);
        if (sampler !== undefined) {
            const data = sampler.data;
            expect(data.outputPortTypes[data.outputPorts.indexOf("RGB")]).toBe("float3");
            expect(data.outputPortTypes[data.outputPorts.indexOf("B")]).toBe("float");
            const html = renderToString(
                <ReactFlowProvider>
                    <ShaderNode {...(sampler as unknown as Parameters<typeof ShaderNode>[0])} />
                </ReactFlowProvider>,
            );
            // No permanent type column — the names keep the row; the type
            // is on-demand in the port's hover tooltip (core string).
            expect(html).not.toContain("gglab-port-type");
            expect(html).toContain("title=\"RGB — float3\"");
            expect(html).toContain("title=\"B — float\"");
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

    it("the socket sits outside the card, tangent to the border line, at a presence size", () => {
        // Inset = half the socket + the card's 1px border: the socket is
        // entirely OUTSIDE the card and its inner edge is exactly tangent
        // to the border line — attached, not floating, and a hollow ring
        // never overlaps the border it hangs off.
        expect(FLOW_GEOMETRY.handleInset).toBe(FLOW_GEOMETRY.handleSize / 2 + 1);
        expect(FLOW_GEOMETRY.handleSize).toBeGreaterThanOrEqual(12);
        const input = handleStyle("input");
        expect(input).toMatchObject({ top: "50%", transform: "translate(-50%, -50%)", left: `-${FLOW_GEOMETRY.handleInset}px` });
        const output = handleStyle("output");
        expect(output).toMatchObject({ top: "50%", transform: "translate(50%, -50%)", right: `-${FLOW_GEOMETRY.handleInset}px` });
    });

    it("carries the socket state language in the app sheet: hollow ring unconnected, solid dot connected", () => {
        expect(appCss).toContain("--gglab-socket: var(--kind-generic)");
        expect(appCss).toContain("border: 2px solid var(--gglab-socket);");
        expect(appCss).toContain("background: transparent;");
        expect(appCss).toContain(".react-flow__handle.gglab-handle-connected {");
        expect(appCss).toContain("background: var(--gglab-socket);");
        // The geometry layer must not re-hardcode a legacy border color.
        const adapter = readFileSync(join(uiRoot, "flow/flow-adapter.ts"), "utf8");
        expect(adapter).not.toContain("2px solid #0f1319");
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

        // The bulk is ONE toggle (its name/arrow flip with the state).
        expect(within(container).getAllByRole("button", { name: /all sections/i }).length).toBe(1);

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
