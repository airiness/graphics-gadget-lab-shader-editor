/**
 * The single position-patch helper for `editorMetadata.nodes[*]`.
 *
 * Placement is presentation/session state: patching a node's position must
 * PRESERVE the rest of its `NodeEditorState` — `unknownFields` today, any
 * future presentation metadata tomorrow. Every write path (drag placement,
 * auto layout, drag-drop authoring, the authoring operations) goes through
 * this one helper so a position update can never drop metadata it does not
 * own.
 */
import type { NodeEditorState, ShaderGraphDocument } from "@gglab/shader-graph-core";

export function withNodePosition(
    document: ShaderGraphDocument,
    nodeId: string,
    position: { x: number; y: number },
): ShaderGraphDocument {
    const previous = document.editorMetadata.nodes[nodeId];
    // A no-op placement (the node already sits there — a zero-movement
    // drag stop, a repeated auto-layout, ...) returns the INPUT instance:
    // nothing changed, so nothing dirties and no history step is
    // fabricated for it.
    if (
        previous !== undefined &&
        previous.position !== undefined &&
        previous.position.x === position.x &&
        previous.position.y === position.y
    ) {
        return document;
    }
    const state: NodeEditorState =
        previous === undefined ? { position, unknownFields: {} } : { ...previous, position };
    return {
        ...document,
        editorMetadata: { ...document.editorMetadata, nodes: { ...document.editorMetadata.nodes, [nodeId]: state } },
    };
}
