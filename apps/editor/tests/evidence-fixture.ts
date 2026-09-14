import { emitHlsl, parseSurfaceProfileDescriptor, type ShaderGraphDocument } from "@gglab/shader-graph-core";
import { canonicalV1Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v1.js";
export const graph: ShaderGraphDocument = {
    schemaVersion: 1, graphId: "same-graph", profile: "gglab.surface", profileVersion: 1,
    parameters: [{ id: "p.tint", name: "p.tint", class: "VectorParameter", valueType: "float3", unknownFields: {} }, { id: "p.metal", name: "p.metal", class: "ScalarParameter", valueType: "float", unknownFields: {} }], connections: [
        ...["Metallic", "Roughness", "Opacity"].map(portId => ({ id: portId, from: { nodeId: "value", portId: "value", unknownFields: {} }, to: { nodeId: "output", portId, unknownFields: {} }, unknownFields: {} })),
        ...["BaseColor", "Emissive"].map(portId => ({ id: portId, from: { nodeId: "color", portId: "value", unknownFields: {} }, to: { nodeId: "output", portId, unknownFields: {} }, unknownFields: {} })),
    ],
    nodes: [{ id: "color", type: "Float3", version: 1, properties: { value: [1, 1, 1] }, unknownFields: {} }, { id: "value", type: "Float", version: 1, properties: { value: 1 }, unknownFields: {} }, { id: "output", type: "SurfaceOutput", version: 1, properties: {}, unknownFields: {} }],
    editorMetadata: { nodes: {}, unknownFields: {} }, unknownFields: {},
};
export const descriptor = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV1Fixture)).value!;
export const emission = emitHlsl(graph, descriptor);
export const source = emission.sourceMap!.generatedSourceIdentity;
