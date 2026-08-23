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
import { getNodeDefinition, resolveGraphTypes, type GraphType } from "@gglab/shader-graph-core";
import { FLOW_GEOMETRY, handleTop } from "./flow-geometry.js";

export { FLOW_GEOMETRY, portCenterY, portRowCount, portRowTop, handleTop, nodeCardHeight, flowGeometryCssVars } from "./flow-geometry.js";
export type { FlowGeometry } from "./flow-geometry.js";

export const FLOW_NODE_TYPE = "gglab" as const;

/**
 * Grid placement for unauthored nodes — presentation math only. Kept as a
 * compatibility surface over the single FLOW_GEOMETRY source of truth
 * (flow-geometry.ts), which also owns the card/handle math.
 */
export const FLOW_LAYOUT = {
    startX: FLOW_GEOMETRY.grid.startX,
    startY: FLOW_GEOMETRY.grid.startY,
    columnWidth: FLOW_GEOMETRY.grid.columnWidth,
    rowHeight: FLOW_GEOMETRY.grid.rowHeight,
    columns: FLOW_GEOMETRY.grid.columns,
    headerHeight: FLOW_GEOMETRY.headerHeight,
    portRowHeight: FLOW_GEOMETRY.portRowHeight,
    handleSize: FLOW_GEOMETRY.handleSize,
    nodeWidth: FLOW_GEOMETRY.nodeWidth,
} as const;

/** Vertical top offset that centers a port row's Handle (single geometry source). */
export function portTop(index: number): number {
    return handleTop(index);
}

/**
 * Inline style for a port's Handle, positioned RELATIVE TO ITS OWN PORT
 * ROW (the row cell is `position: relative`): `top: 50%` + the centering
 * transform dead-centers the socket on the row, and the left/right inset
 * places the socket OUTSIDE the card with its inner edge exactly
 * tangent to the card border line (inset = half the socket + the card's
 * 1px border) — attached, never floating, and a hollow ring never
 * overlaps the border. Size and inset come from the single geometry
 * source, so the socket center still sits exactly on the shared
 * `portCenterY` axis and xyflow's measured edge anchor terminates on
 * the socket center. The socket's color and connection state (hollow
 * ring / solid dot) are CSS-owned — see the app sheet; geometry lives
 * here.
 */
export function handleStyle(side: "input" | "output"): Record<string, string> {
    const g = FLOW_GEOMETRY;
    return {
        top: "50%",
        transform: side === "input" ? "translate(-50%, -50%)" : "translate(50%, -50%)",
        width: `${g.handleSize}px`,
        height: `${g.handleSize}px`,
        minWidth: `${g.handleSize}px`,
        minHeight: `${g.handleSize}px`,
        ...(side === "input" ? { left: `${-g.handleInset}px` } : { right: `${-g.handleInset}px` }),
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
    /**
     * Per-port DISPLAY type strings, aligned with the port arrays above.
     * The values are core-owned facts, never UI guesses: an unresolved or
     * unconnected port shows the catalog's DECLARED type set for that
     * port (its `NodePortDefinition.types`); a connection-resolved port
     * shows the core type resolver's concrete type (output ports via
     * `resolveGraphTypes().typeAt`, input ports via the connection's
     * source, which is document data). `undefined` = no catalog fact
     * available (unknown node type) — the row shows no type.
     */
    readonly inputPortTypes: readonly (string | undefined)[];
    readonly outputPortTypes: readonly (string | undefined)[];
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

/**
 * Per-port display type strings — presentation formatting over core
 * facts ONLY: the concrete type (core type resolver, via its own
 * `typeAt`) wins; otherwise the catalog's DECLARED type set for that
 * port (`NodePortDefinition.types`). Nothing here is keyed on the port
 * id — the UI never guesses a port's type.
 */
function displayPortTypes(
    ports: readonly { readonly id: string }[],
    declared: readonly { readonly id: string; readonly types: readonly string[] }[],
    concreteTypeAt: (portId: string) => string | undefined,
): (string | undefined)[] {
    return ports.map((port) => concreteTypeAt(port.id) ?? declared.find((entry) => entry.id === port.id)?.types.join("/"));
}

export function documentToFlow(document: ShaderGraphDocument, focus: CanvasFocus | null = null): {
    readonly nodes: readonly ShaderFlowNode[];
    readonly edges: readonly Edge[];
} {
    // The core type resolver (document scope = authoring scope) is the
    // single concrete-type authority for the display projection.
    const resolvedTypes = resolveGraphTypes(document);
    const nodes: ShaderFlowNode[] = document.nodes.map((node, index) => {
        const definition = getNodeDefinition(node.type);
        const highlight = focus?.nodeHighlights.find((entry) => entry.nodeId === node.id);
        const { inputKinds, outputKinds } = kindsFor(definition);
        // Input ports take their concrete type from the connection's
        // source (document data) as resolved by the core resolver.
        const inputConcrete = (portId: string): string | undefined => {
            const source = document.connections.find((connection) => connection.to.nodeId === node.id && connection.to.portId === portId)?.from;
            return source !== undefined ? resolvedTypes.typeAt(source.nodeId, source.portId) : undefined;
        };
        const data: ShaderNodeData = {
            label: node.label ?? definition?.displayName ?? node.type,
            nodeType: node.type,
            inputPorts: definition?.inputs.map((port) => port.id) ?? [],
            outputPorts: definition?.outputs.map((port) => port.id) ?? [],
            inputPortKinds: inputKinds,
            outputPortKinds: outputKinds,
            inputPortTypes: displayPortTypes(definition?.inputs ?? [], definition?.inputs ?? [], inputConcrete),
            outputPortTypes: displayPortTypes(
                definition?.outputs ?? [],
                definition?.outputs ?? [],
                (portId) => resolvedTypes.typeAt(node.id, portId),
            ),
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
