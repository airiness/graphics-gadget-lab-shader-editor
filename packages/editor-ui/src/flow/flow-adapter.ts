/**
 * Document → React Flow view. Pure, deterministic, and strictly one-way:
 * the core's graph document is the persisted model, React Flow's
 * nodes/edges are a presentation projection of it. This module never
 * mutates the document and never invents ports, types, or validity — ports
 * come from the core's node catalog (the single node/port/type authority),
 * and unknown node types are still rendered (as explicit "unknown" cards)
 * exactly the way the core's reader preserves them: never silently dropped.
 *
 * Layout: a node without an authored canvas position (editorMetadata)
 * receives a deterministic grid slot from its document order — so
 * save/load round trips keep stable, reproducible layouts, and canvas
 * placement never changes generated HLSL (core invariant).
 */
import type { Edge, Node } from "@reactflow/core";
import { getNodeDefinition, type ShaderGraphDocument } from "@gglab/shader-graph-core";

export const FLOW_NODE_TYPE = "gglab";

export interface ShaderNodeData {
    readonly label: string;
    readonly nodeType: string;
    readonly inputPorts: readonly string[];
    readonly outputPorts: readonly string[];
    readonly knownToCatalog: boolean;
}

export type ShaderFlowNode = Node<ShaderNodeData, typeof FLOW_NODE_TYPE>;

const GRID = { startX: 60, startY: 60, columnWidth: 300, rowHeight: 200, columns: 3 };

function gridPosition(documentIndex: number): { x: number; y: number } {
    const column = documentIndex % GRID.columns;
    const row = Math.floor(documentIndex / GRID.columns);
    return { x: GRID.startX + column * GRID.columnWidth, y: GRID.startY + row * GRID.rowHeight };
}

export function documentToFlow(document: ShaderGraphDocument): {
    readonly nodes: readonly ShaderFlowNode[];
    readonly edges: readonly Edge[];
} {
    const nodes: ShaderFlowNode[] = document.nodes.map((node, index) => {
        const definition = getNodeDefinition(node.type);
        const data: ShaderNodeData = {
            label: node.label ?? definition?.displayName ?? node.type,
            nodeType: node.type,
            inputPorts: definition?.inputs.map((port) => port.id) ?? [],
            outputPorts: definition?.outputs.map((port) => port.id) ?? [],
            knownToCatalog: definition !== undefined,
        };
        const authored = document.editorMetadata.nodes[node.id]?.position;
        return {
            id: node.id,
            type: FLOW_NODE_TYPE,
            position: authored !== undefined ? { ...authored } : gridPosition(index),
            data,
            selected: false,
        };
    });
    const edges: Edge[] = document.connections.map((connection) => ({
        id: connection.id,
        source: connection.from.nodeId,
        target: connection.to.nodeId,
        sourceHandle: connection.from.portId,
        targetHandle: connection.to.portId,
    }));
    return { nodes, edges };
}

/** Authored canvas positions of one node (session state, never semantics). */
export function authoredPosition(document: ShaderGraphDocument, nodeId: string): { x: number; y: number } | undefined {
    return document.editorMetadata.nodes[nodeId]?.position;
}
