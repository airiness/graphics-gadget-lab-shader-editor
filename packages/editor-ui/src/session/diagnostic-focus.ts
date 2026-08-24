/**
 * Diagnostic → canvas navigation — strict mode (structured data only).
 *
 * The target is resolved from the diagnostic's structured `dataPath`
 * anchors against the document; the endpoint ports of a connection
 * anchor come from the `GraphConnection` entry itself. Nothing here is
 * read from the human-readable `message`: message prose is a display
 * surface, not a contract, and machine behavior must not depend on it.
 *
 * Therefore:
 *   - `$.nodes[K]`    → highlight the node (port-level precision for
 *     node-anchored diagnostics waits for a structured diagnostic target;
 *     inventing it by parsing prose would just move the brittleness);
 *   - `$.connections[K]` → highlight the edge and its two endpoint ports
 *     (both are facts already present in structured data);
 *   - anchors with no canvas home (`"$"`, `$.parameters[K]`) → `null`
 *     (an explicit no-target, never a fake one).
 */
import type { ShaderGraphDiagnostic, ShaderGraphDocument } from "@gglab/shader-graph-core";
import type { CanvasFocus } from "../flow/flow-adapter.js";

export function diagnosticFocus(document: ShaderGraphDocument, diagnostic: ShaderGraphDiagnostic): CanvasFocus | null {
    const dataPath = diagnostic.dataPath;
    if (typeof dataPath !== "string" || dataPath.length === 0) {
        return null;
    }
    const nodeMatch = /^\$\.nodes\[(\d+)\](?:\.|$)/.exec(dataPath);
    if (nodeMatch !== null) {
        const index = Number(nodeMatch[1]);
        const node = document.nodes[index];
        if (node === undefined) {
            return null;
        }
        // Node anchor: the node itself. A port name is not structured
        // data on this path, and must not be mined from the message.
        return { nodeHighlights: [{ nodeId: node.id, portIds: [] }], connectionHighlights: [] };
    }
    const connectionMatch = /^\$\.connections\[(\d+)\](?:\.|$)/.exec(dataPath);
    if (connectionMatch !== null) {
        const index = Number(connectionMatch[1]);
        const connection = document.connections[index];
        if (connection === undefined) {
            return null;
        }
        // Connection anchor: edge + endpoints, all read from the
        // structured connection entry.
        return {
            nodeHighlights: [
                { nodeId: connection.from.nodeId, portIds: [connection.from.portId] },
                { nodeId: connection.to.nodeId, portIds: [connection.to.portId] },
            ],
            connectionHighlights: [connection.id],
        };
    }
    return null;
}
