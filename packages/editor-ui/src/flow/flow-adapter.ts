/**
 * Document → React Flow view (one-way projection; React Flow is the
 * presentation/interaction adapter, never the model or a semantic
 * authority).
 *
 * Ports are the true UI unit of a shader graph: every port — name,
 * position, and order — comes from the core's node catalog; this module's
 * only job is layout (rows + offsets) and stable presentation facts taken
 * verbatim from the catalog (each port's data category, the node's
 * category). There is no UI-side registry: unknown node types render as
 * explicit "unknown" cards, never silently dropped.
 *
 * Focus: a `CanvasFocus` (from diagnostic navigation) marks which nodes
 * and connections to highlight — the target is resolved by
 * `diagnosticFocus` against the document; this module only renders it.
 * Canvas positions come from `editorMetadata` (session state); nodes
 * without an authored slot get a deterministic grid position from document
 * order. Placement never changes generated HLSL (core invariant).
 */
import type { Edge, Node } from "@xyflow/react";
import type { ShaderGraphDocument } from "@gglab/shader-graph-core";
import { getNodeDefinition, type GraphType } from "@gglab/shader-graph-core";

export const FLOW_NODE_TYPE = "gglab" as const;

/** Port/node layout constants — presentation math only (not semantics). */
export const FLOW_LAYOUT = {
    startX: 60,
    startY: 60,
    columnWidth: 340,
    rowHeight: 236,
    columns: 3,
    /** Node card header height (title, type, category, optional flag). */
    headerHeight: 56,
    /** One port row. */
    portRowHeight: 26,
    /** Handle dot size (must match the CSS). */
    handleSize: 10,
    nodeWidth: 200,
} as const;

/** Vertical top offset for a port row's Handle. */
export function portTop(index: number): number {
    return FLOW_LAYOUT.headerHeight + index * FLOW_LAYOUT.portRowHeight + (FLOW_LAYOUT.portRowHeight - FLOW_LAYOUT.handleSize) / 2;
}

/** Inline style pinning a Handle dot to its port row (left/right set per side). */
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
        ...(side === "input" ? { left: -7 } : { right: -7 }),
    };
}

/**
 * A port's data category, taken from the core catalog's own type list.
 * Presentation only: the UI colors by category; the vocabulary (which
 * types exist) is core-owned. `generic` covers anything unmapped so no
 * port is silently forced into a wrong family.
 */
export type PortKind = "scalar" | "vector" | "texture" | "generic";

export function portKind(types: readonly GraphType[]): PortKind {
    if (types.includes("Texture2D")) {
        return "texture";
    }
    if (types.includes("float2") || types.includes("float3") || types.includes("float4")) {
        return "vector";
    }
    if (types.includes("float")) {
        return "scalar";
    }
    return "generic";
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
    readonly inputPortKinds: readonly PortKind[];
    readonly outputPortKinds: readonly PortKind[];
    readonly nodeCategory: string | undefined;
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

function kindsFor(definition: ReturnType<typeof getNodeDefinition>): { inputKinds: PortKind[]; outputKinds: PortKind[] } {
    if (definition === undefined) {
        return { inputKinds: [], outputKinds: [] };
    }
    return {
        inputKinds: definition.inputs.map((port) => portKind(port.types)),
        outputKinds: definition.outputs.map((port) => portKind(port.types)),
    };
}

export function documentToFlow(document: ShaderGraphDocument, focus: CanvasFocus | null = null): {
    readonly nodes: readonly ShaderFlowNode[];
    readonly edges: readonly Edge[];
} {
    const nodes: ShaderFlowNode[] = document.nodes.map((node, index) => {
        const definition = getNodeDefinition(node.type);
        const highlight = focus?.nodeHighlights.find((entry) => entry.nodeId === node.id);
        const { inputKinds, outputKinds } = kindsFor(definition);
        const data: ShaderNodeData = {
            label: node.label ?? definition?.displayName ?? node.type,
            nodeType: node.type,
            inputPorts: definition?.inputs.map((port) => port.id) ?? [],
            outputPorts: definition?.outputs.map((port) => port.id) ?? [],
            inputPortKinds: inputKinds,
            outputPortKinds: outputKinds,
            nodeCategory: definition?.category,
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
        // Edge data category comes from the source (producer) port's type — the
        // same core fact the source handle is colored from.
        const kind = edgeKind(document, connection.from.nodeId, connection.from.portId);
        return {
            id: connection.id,
            source: connection.from.nodeId,
            target: connection.to.nodeId,
            sourceHandle: connection.from.portId,
            targetHandle: connection.to.portId,
            data: { kind },
            className: `gglab-edge gglab-edge-kind-${kind}${focused ? " gglab-edge-focus" : ""}`,
        };
    });
    return { nodes, edges };
}

function edgeKind(document: ShaderGraphDocument, nodeId: string, portId: string): PortKind {
    const node = document.nodes.find((candidate) => candidate.id === nodeId);
    const definition = node !== undefined ? getNodeDefinition(node.type) : undefined;
    const port = definition?.outputs.find((candidate) => candidate.id === portId);
    return port !== undefined ? portKind(port.types) : "generic";
}

/** Authored canvas positions of one node (session state, never semantics). */
export function authoredPosition(document: ShaderGraphDocument, nodeId: string): { x: number; y: number } | undefined {
    return document.editorMetadata.nodes[nodeId]?.position;
}
