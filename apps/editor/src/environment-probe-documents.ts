// Core-authored, in-memory final-location probes; never user documents or native evidence by themselves.
import { parseShaderGraphDocument } from "@gglab/shader-graph-core";
function baseDocument(): Record<string, unknown> {
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

function textureDocument(): Record<string, unknown> {
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

export function createEnvironmentProbeDocument(profileVersion: 1 | 2) {
    const parsed = parseShaderGraphDocument(JSON.stringify(profileVersion === 1 ? baseDocument() : textureDocument()));
    if (!parsed.ok || !parsed.value) throw new Error(JSON.stringify(parsed.diagnostics)); return parsed.value;
}

