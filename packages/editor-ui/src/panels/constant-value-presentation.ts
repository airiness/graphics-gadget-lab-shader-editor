import { getNodeDefinition, type GraphType } from "@gglab/shader-graph-core";

export const CONSTANT_COMPONENT_LABELS: Readonly<Partial<Record<GraphType, readonly string[]>>> = {
    float: ["Value"], float2: ["X", "Y"], float3: ["X", "Y", "Z"], float4: ["X", "Y", "Z", "W"],
};

/** Includes room for draft validation without moving sockets or nearby nodes. */
export function inlineConstantHeight(nodeType: string): number {
    const definition = getNodeDefinition(nodeType);
    const property = definition?.category === "constant" ? definition.properties.find(p => p.name === "value") : undefined;
    const labels = property === undefined ? undefined : CONSTANT_COMPONENT_LABELS[property.type];
    return labels === undefined ? 0 : labels.length > 2 ? 144 : 96;
}
