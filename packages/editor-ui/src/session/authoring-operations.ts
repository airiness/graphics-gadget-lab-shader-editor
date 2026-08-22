/**
 * Authoring operations on the graph document — presentation-side data
 * construction only, and only where a frontend legitimately owns the answer
 * (stable-id derivation, document location). Every operation returns a new
 * document (or a structured refusal) and is atomic: a refusal returns the
 * unchanged input, never a halfway state.
 *
 * What this module does NOT own (each has exactly one authority):
 *   - node version + creation-time property defaults → the core's
 *     `createNode` (node catalog). The GUI never says "a new Float is 0";
 *     the catalog says so, and a future CLI asks the same service.
 *   - validity of anything produced → the core's services (validation,
 *     port-level types, conformance). Operations build data; they do not
 *     pre-judge it.
 */
import type {
    ConnectionEnd,
    GraphConnection,
    GraphNode,
    GraphParameter,
    GraphType,
    ShaderGraphDocument,
} from "@gglab/shader-graph-core";
import { createNode, getNodeDefinition } from "@gglab/shader-graph-core";

export interface AuthoringRefusal {
    readonly reason: string;
}

export interface AuthoringResult {
    /** The new document — or the unchanged input when `applied` is false. */
    readonly document: ShaderGraphDocument;
    readonly applied: boolean;
    readonly refusal: AuthoringRefusal | undefined;
    /** The id of the entry this operation created (`applied` only). */
    readonly createdId: string | undefined;
}

/** Next free stable id in a `prefix<k>` namespace against the existing ids. */
function nextStableId(prefix: string, takenIds: ReadonlySet<string>): string {
    let candidate = 1;
    while (takenIds.has(`${prefix}${candidate}`)) {
        candidate += 1;
    }
    return `${prefix}${candidate}`;
}

function takenNodeIds(document: ShaderGraphDocument): Set<string> {
    return new Set(document.nodes.map((node) => node.id));
}
function takenConnectionIds(document: ShaderGraphDocument): Set<string> {
    return new Set(document.connections.map((connection) => connection.id));
}
function takenParameterIds(document: ShaderGraphDocument): Set<string> {
    return new Set(document.parameters.map((parameter) => parameter.id));
}

function refusalReason(diagnostics: readonly { message: string }[]): string {
    const first = diagnostics[0];
    return first !== undefined ? first.message : "The core's node catalog could not create this node entry.";
}

/**
 * Add a node of a type from the core's catalog. Version and creation-time
 * property values come from the core's `createNode` — the single authority
 * for node-creation semantics (shared with a future CLI; the GUI owns none).
 * For a parameter node (one that names a document parameter), the parameter
 * must already exist — it is created first via `addParameter`; adding a
 * parameter node without `parameterId` is a structured refusal, never a
 * silent placeholder.
 */
export function addNode(
    document: ShaderGraphDocument,
    type: string,
    options: { parameterId?: string; position?: { x: number; y: number } } = {},
): AuthoringResult {
    const definition = getNodeDefinition(type);
    const creation = createNode(type);
    if (definition === undefined || creation.ok === false) {
        return refused(document, definition === undefined ? `No node catalog entry for type "${type}".` : refusalReason(creation.diagnostics));
    }
    const requiresParameter = definition.referenceProperties.some((reference) => reference.name === "parameterId");
    if (requiresParameter && options.parameterId === undefined) {
        return refused(document, `Node type "${type}" names a document parameter; create the graph parameter first (Add Parameter).`);
    }
    const node: GraphNode = {
        id: nextStableId("n", takenNodeIds(document)),
        type,
        version: creation.nodeVersion,
        properties: {
            ...(requiresParameter && options.parameterId !== undefined ? { parameterId: options.parameterId } : {}),
            ...creation.properties,
        },
        unknownFields: {},
    };
    const nodes = [...document.nodes, node];
    const editorMetadata =
        options.position !== undefined
            ? { ...document.editorMetadata, nodes: { ...document.editorMetadata.nodes, [node.id]: { position: options.position, unknownFields: {} } } }
            : document.editorMetadata;
    return {
        document: { ...document, nodes, editorMetadata },
        applied: true,
        refusal: undefined,
        createdId: node.id,
    };
}

/** Remove a node and every connection that touches it (data integrity). */
export function removeNode(document: ShaderGraphDocument, nodeId: string): AuthoringResult {
    if (document.nodes.some((node) => node.id === nodeId) === false) {
        return refused(document, `No node with id "${nodeId}".`);
    }
    const documentOut: ShaderGraphDocument = {
        ...document,
        nodes: document.nodes.filter((node) => node.id !== nodeId),
        connections: document.connections.filter((connection) => {
            const from: ConnectionEnd = connection.from;
            const to: ConnectionEnd = connection.to;
            return from.nodeId !== nodeId && to.nodeId !== nodeId;
        }),
    };
    return { document: documentOut, applied: true, refusal: undefined, createdId: undefined };
}

/**
 * Add a connection (from a node's output port to another node's input
 * port). Duplicate/invalid/cyclic cases are not judged here: the document
 * is extended and the core's services report them structurally.
 */
export function addConnection(
    document: ShaderGraphDocument,
    from: { nodeId: string; portId: string },
    to: { nodeId: string; portId: string },
): AuthoringResult {
    const nodeIds = takenNodeIds(document);
    if (nodeIds.has(from.nodeId) === false || nodeIds.has(to.nodeId) === false) {
        return refused(document, "A connection end names a node that is not present in the document.");
    }
    const connection: GraphConnection = {
        id: nextStableId("c", takenConnectionIds(document)),
        from: { nodeId: from.nodeId, portId: from.portId, unknownFields: {} },
        to: { nodeId: to.nodeId, portId: to.portId, unknownFields: {} },
        unknownFields: {},
    };
    return {
        document: { ...document, connections: [...document.connections, connection] },
        applied: true,
        refusal: undefined,
        createdId: connection.id,
    };
}

export interface ParameterRequest {
    readonly name: string;
    readonly class: string;
    /** The parameter's concrete graph value type from the core's type vocabulary. */
    readonly valueType: GraphType;
}

/**
 * Add a graph parameter (document entry + the parameter node that names
 * it). Atomic: the core's `createNode` for the node type is asked BEFORE
 * the parameter entry is attached, so a refusal (e.g. a class whose node
 * type is not in the catalog) returns the unchanged input — never a
 * parameter entry with no node.
 *
 * The (class, valueType) pairing is not judged here either — it is supplied
 * by the caller from the descriptor's own vocabulary, and the core's
 * conformance service checks it against the loaded descriptor.
 */
export function addParameter(document: ShaderGraphDocument, request: ParameterRequest): AuthoringResult {
    const nodeType = nodeTypeForParameterClass(request.class);
    const creation = createNode(nodeType);
    if (creation.ok === false) {
        return refused(
            document,
            `Parameter class "${request.class}" cannot be authored: ${refusalReason(creation.diagnostics)}`,
        );
    }
    const parameter: GraphParameter = {
        id: nextStableId("p", takenParameterIds(document)),
        name: request.name,
        class: request.class,
        valueType: request.valueType,
        unknownFields: {},
    };
    const node: GraphNode = {
        id: nextStableId("n", takenNodeIds(document)),
        type: nodeType,
        version: creation.nodeVersion,
        properties: {
            parameterId: parameter.id,
            ...creation.properties,
        },
        unknownFields: {},
    };
    return {
        document: { ...document, parameters: [...document.parameters, parameter], nodes: [...document.nodes, node] },
        applied: true,
        refusal: undefined,
        createdId: node.id,
    };
}

/**
 * The parameter node type that carries a parameter class. In the surface
 * profile the node type name matches the class name ("ScalarParameter"
 * class is authored by the "ScalarParameter" node); `createNode` — the
 * core's authority — still validates that the type exists and says what a
 * new entry carries, so a mismatch degrades to a structured refusal.
 */
function nodeTypeForParameterClass(parameterClass: string): string {
    return parameterClass;
}

function refused(document: ShaderGraphDocument, reason: string): AuthoringResult {
    return { document, applied: false, refusal: { reason }, createdId: undefined };
}
