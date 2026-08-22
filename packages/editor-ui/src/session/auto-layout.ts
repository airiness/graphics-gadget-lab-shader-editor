/**
 * One-click full-graph auto layout (presentation/session convenience only).
 *
 * This computes node POSITIONS for the persisted `editorMetadata.nodes[*].position`
 * (UI session state) from the document's nodes + connections. It reads the
 * graph structure (core-owned) and the node catalog (for card sizes), but it
 * defines no graph semantics and writes nothing semantic: the same document
 * with a different position map is byte-identical as far as validation,
 * conformance, and emission are concerned. The composition root applies the
 * map to `editorMetadata` and re-asks the core for its verdicts.
 *
 * Layout engine: dagre (LR). Deterministic for a given document + catalog.
 */
import dagre from "@dagrejs/dagre";
import { getNodeDefinition, type ShaderGraphDocument } from "@gglab/shader-graph-core";
import { FLOW_GEOMETRY, nodeCardHeight, portRowCount } from "../flow/flow-geometry.js";

export interface AutoLayoutResult {
    /** Stable node id → card top-left position (canvas coordinates). */
    readonly positions: Record<string, { x: number; y: number }>;
    readonly nodeCount: number;
}

/** Card footprint for a node type (from the catalog + geometry), for sizing. */
function nodeSize(nodeType: string): { width: number; height: number } {
    const definition = getNodeDefinition(nodeType);
    const rows = definition === undefined ? 1 : portRowCount(definition.inputs.length, definition.outputs.length);
    return { width: FLOW_GEOMETRY.nodeWidth, height: nodeCardHeight(rows, FLOW_GEOMETRY) };
}

/**
 * Compute a full-graph auto layout. Edges that reference an unknown node or
 * loop to themselves are ignored for layout (dagre needs known endpoints);
 * such diagnostics remain the core's job, not the layout's.
 */
export function autoLayout(document: ShaderGraphDocument): AutoLayoutResult {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: "LR", ranksep: FLOW_GEOMETRY.grid.columnWidth - FLOW_GEOMETRY.nodeWidth, nodesep: 60, marginx: FLOW_GEOMETRY.grid.startX, marginy: FLOW_GEOMETRY.grid.startY });
    g.setDefaultEdgeLabel(() => ({}));

    for (const node of document.nodes) {
        const { width, height } = nodeSize(node.type);
        g.setNode(node.id, { width, height });
    }

    const nodeIds = new Set(document.nodes.map((node) => node.id));
    for (const connection of document.connections) {
        const { from, to } = connection;
        if (from.nodeId === to.nodeId) {
            continue;
        }
        if (nodeIds.has(from.nodeId) && nodeIds.has(to.nodeId)) {
            g.setEdge(from.nodeId, to.nodeId, {}, connection.id);
        }
    }

    dagre.layout(g);

    const positions: Record<string, { x: number; y: number }> = {};
    for (const node of document.nodes) {
        const placed = g.node(node.id);
        if (placed === undefined) {
            continue;
        }
        // dagre returns the center; the canvas card position is top-left.
        positions[node.id] = {
            x: Math.round(placed.x - (placed.width ?? FLOW_GEOMETRY.nodeWidth) / 2),
            y: Math.round(placed.y - (placed.height ?? FLOW_GEOMETRY.headerHeight) / 2),
        };
    }

    return { positions, nodeCount: document.nodes.length };
}
