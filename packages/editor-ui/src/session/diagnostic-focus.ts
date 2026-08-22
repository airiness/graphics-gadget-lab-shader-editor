/**
 * Diagnostic → canvas navigation. The target is resolved against the
 * document from the diagnostic's structured `dataPath` anchors
 * (`$.nodes[K]`, `$.connections[K]` — authoritative, never parsed from
 * message prose), then translated to stable node/connection ids.
 *
 * Port narrowing is applied only when catalog-verified: a quoted token in
 * the message becomes a highlighted port only if it is a real port id of
 * that node in the core's node catalog — never otherwise. Anchors without
 * a canvas target (e.g. profile-level `"$"`, `$.parameters[K]`) resolve to
 * `null`: the panel still shows the diagnostic; the canvas is simply not
 * where it lives.
 */
import { getNodeDefinition, type ShaderGraphDiagnostic, type ShaderGraphDocument } from "@gglab/shader-graph-core";
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
        return nodeFocus(document, node.id, diagnostic.message);
    }
    const connectionMatch = /^\$\.connections\[(\d+)\](?:\.|$)/.exec(dataPath);
    if (connectionMatch !== null) {
        const index = Number(connectionMatch[1]);
        const connection = document.connections[index];
        if (connection === undefined) {
            return null;
        }
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

/** Highlight one node; narrow to its catalog port(s) when the message names one verifiably. */
function nodeFocus(document: ShaderGraphDocument, nodeId: string, message: string): CanvasFocus {
    const node = document.nodes.find((candidate) => candidate.id === nodeId);
    const portIds: string[] = [];
    if (node !== undefined) {
        const definition = getNodeDefinition(node.type);
        if (definition !== undefined) {
            const catalogPortIds = new Set<string>([...definition.inputs.map((port) => port.id), ...definition.outputs.map((port) => port.id)]);
            for (const match of message.matchAll(/"([^"]+)"/g)) {
                const token = match[1];
                if (token !== undefined && catalogPortIds.has(token)) {
                    portIds.push(token);
                }
            }
        }
    }
    return { nodeHighlights: [{ nodeId, portIds }], connectionHighlights: [] };
}
