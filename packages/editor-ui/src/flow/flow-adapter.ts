/**
 * Document → React Flow view (one-way projection; React Flow is the
 * presentation/interaction adapter, never the model or a semantic authority).
 *
 * Ports are the true UI unit of a shader graph: every port — name,
 * direction, and order — comes from the core's node catalog; this module's
 * only job is layout (deterministic rows, handle offsets, grid slots).
 * Unknown node types are still rendered (as explicit "unknown" cards)
 * exactly the way the core's reader preserves them: never silently dropped.
 *
 * Focus: a `CanvasFocus` (from diagnostic navigation) marks which nodes
 * and connections to highlight — the target itself is resolved by
 * `focusFromDiagnostic` against the document; this module only renders it.
 * Canvas positions come from `editorMetadata` (session state); nodes
 * without an authored slot get a deterministic grid position from document
 * order — save/load round trips keep stable layouts, and placement never
 * changes generated HLSL (core invariant).
 */
import type { Edge, Node } from "@xyflow/react";
import { getNodeDefinition, type ShaderGraphDocument } from "@gglab/shader-graph-core";

export const FLOW_NODE_TYPE = "gglab" as const;

/** Port/node layout constants — presentation math only (not semantics). */
export const FLOW_LAYOUT = {
    startX: 60,
    startY: 60,
    columnWidth: 340,
    rowHeight: 220,
    columns: 3,
    /** Node card header height (title, type, flag line). */
    headerHeight: 48,
    /** One port row. */
    portRowHeight: 26,
    /** Handle dot size (must match the CSS). */
    handleSize: 10,
    nodeWidth: 190,
} as const;

/** Vertical center of port row `index` inside the node card (top offset for its Handle). */
export function portTop(index: number): number {
    return FLOW_LAYOUT.headerHeight + index * FLOW_LAYOUT.portRowHeight + (FLOW_LAYOUT.portRowHeight - FLOW_LAYOUT.handleSize) / 2;
}

/** Inline style that pins a React Flow Handle dot to its port row. */
export function handleStyle(side: "input" | "output", rowIndex: number): Record<string, string | number> {
    const size = FLOW_LAYOUT.handleSize;
    return {
        top: portTop(rowIndex),
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        border: "2px solid #10141a",
        borderRadius: "50%",
        background: "#8b98a8",
        ...(side === "input" ? { left: -6 } : { right: -6 }),
    };
}

/** Diagnostic navigation target: what the canvas should highlight. */
export interface CanvasFocus {
    /** Nodes to ring; `portIds` (a subset of that node's catalog ports) to glow. */
    readonly nodeHighlights: readonly { readonly nodeId: string; readonly portIds: readonly string[] }[];
    /** Connection ids to highlight (endpoints included in nodeHighlights). */
    readonly connectionHighlights: readonly string[];
}

export type ShaderNodeData = {
    readonly label: string;
    readonly nodeType: string;
    readonly inputPorts: readonly string[];
    readonly outputPorts: readonly string[];
    readonly knownToCatalog: boolean;
    readonly focused: boolean;
    readonly focusedPorts: readonly string[];
};

export type ShaderFlowNode = Node<ShaderNodeData, typeof FLOW_NODE_TYPE>;

function gridPosition(documentIndex: number): { x: number; y: number } {
    const column = documentIndex % FLOW_LAYOUT.columns;
    const row = Math.floor(documentIndex / FLOW_LAYOUT.columns);
    return { x: FLOW_LAYOUT.startX + column * FLOW_LAYOUT.columnWidth, y: FLOW_LAYOUT.startY + row * FLOW_LAYOUT.rowHeight };
}

export function documentToFlow(document: ShaderGraphDocument, focus: CanvasFocus | null = null): {
    readonly nodes: readonly ShaderFlowNode[];
    readonly edges: readonly Edge[];
} {
    const nodes: ShaderFlowNode[] = document.nodes.map((node, index) => {
        const definition = getNodeDefinition(node.type);
        const highlight = focus?.nodeHighlights.find((entry) => entry.nodeId === node.id);
        const data: ShaderNodeData = {
            label: node.label ?? definition?.displayName ?? node.type,
            nodeType: node.type,
            inputPorts: definition?.inputs.map((port) => port.id) ?? [],
            outputPorts: definition?.outputs.map((port) => port.id) ?? [],
            knownToCatalog: definition !== undefined,
            focused: highlight !== undefined,
            focusedPorts: highlight?.portIds ?? [],
        };
        const authored = document.editorMetadata.nodes[node.id]?.position;
        return {
            id: node.id,
            type: FLOW_NODE_TYPE,
            position: authored !== undefined ? { ...authored } : gridPosition(index),
            data,
            selected: highlight !== undefined,
        };
    });
    const edges: Edge[] = document.connections.map((connection) => {
        const focused = focus?.connectionHighlights.includes(connection.id) ?? false;
        return {
            id: connection.id,
            source: connection.from.nodeId,
            target: connection.to.nodeId,
            sourceHandle: connection.from.portId,
            targetHandle: connection.to.portId,
            ...(focused ? { className: "gglab-edge-focus" } : {}),
        };
    });
    return { nodes, edges };
}

/** Authored canvas positions of one node (session state, never semantics). */
export function authoredPosition(document: ShaderGraphDocument, nodeId: string): { x: number; y: number } | undefined {
    return document.editorMetadata.nodes[nodeId]?.position;
}
