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
import {
    createNode,
    getNodeDefinition,
    isGraphType,
    removeConnection as removeConnectionCore,
    removeConnectionsAtPort as removeConnectionsAtPortCore,
    reconnectConnection as reconnectConnectionCore,
} from "@gglab/shader-graph-core";
import { withNodePosition } from "./node-position.js";

/**
 * The transient palette → canvas drag payload (UI state only; serialized
 * for the HTML5 dataTransfer). React Flow supplies the drop coordinate;
 * the core's authoring operations decide whether the creation holds.
 *
 * The parameter `valueType` is a `GraphType` at the TYPE level: the
 * decode path validates it with the core's own `isGraphType` runtime
 * authority, so a decoded payload is already legal — no downstream cast
 * can re-introduce an untrusted string.
 */
export type AuthoringDropPayload =
    | { readonly kind: "node"; readonly nodeType: string }
    | { readonly kind: "parameter"; readonly parameterClass: string; readonly valueType: GraphType };

/** MIME type for the authoring drag payload (presentation-owned vocabulary). */
export const AUTHORING_DROP_MIME = "application/x-gglab-authoring";

export function encodeAuthoringDrop(payload: AuthoringDropPayload): string {
    return JSON.stringify(payload);
}

/** Decode + guard a drag payload against the core's authorities: unknown
 * shapes are `null` (never a silent reinterpretation), and a parameter
 * `valueType` outside the core's GraphType vocabulary is `null` — the
 * runtime string boundary is closed here, once.
 */
export function decodeAuthoringDrop(raw: string): AuthoringDropPayload | null {
    if (raw === "") {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (candidate.kind === "node" && typeof candidate.nodeType === "string" && candidate.nodeType !== "") {
        return { kind: "node", nodeType: candidate.nodeType };
    }
    if (
        candidate.kind === "parameter" &&
        typeof candidate.parameterClass === "string" &&
        candidate.parameterClass !== "" &&
        typeof candidate.valueType === "string" &&
        isGraphType(candidate.valueType)
    ) {
        return { kind: "parameter", parameterClass: candidate.parameterClass, valueType: candidate.valueType };
    }
    return null;
}

/**
 * Resolve a drop's client point to a canvas coordinate using the flow
 * instance's own transform. Returns `null` when the instance is not
 * ready (or cannot transform): a drop with no coordinate is a NO-OP —
 * never a silent creation at (0, 0).
 */
export function resolveDropCoordinate(
    instance: { screenToFlowPosition?: (point: { x: number; y: number }) => { x: number; y: number } } | null,
    client: { x: number; y: number },
): { x: number; y: number } | null {
    if (instance === null || typeof instance.screenToFlowPosition !== "function") {
        return null;
    }
    const point = instance.screenToFlowPosition(client);
    if (typeof point.x !== "number" || typeof point.y !== "number") {
        return null;
    }
    return { x: Math.round(point.x), y: Math.round(point.y) };
}

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
    const placed =
        options.position !== undefined ? withNodePosition(document, node.id, options.position) : document;
    return {
        document: { ...placed, nodes },
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
 *
 * `options.position` (optional) seeds the new parameter node's initial
 * placement in the SAME atomic operation (palette/canvas drop coordinate) —
 * still session state, still refused-together with everything else on a
 * rejection (the unchanged input is returned whole).
 */
export function addParameter(
    document: ShaderGraphDocument,
    request: ParameterRequest,
    options: { position?: { x: number; y: number } } = {},
): AuthoringResult {
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
    const withEntries = { ...document, parameters: [...document.parameters, parameter], nodes: [...document.nodes, node] };
    const placed = options.position !== undefined ? withNodePosition(withEntries, node.id, options.position) : withEntries;
    return {
        document: placed,
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

/**
 * Remove one connection by its stable id — the Core owns the removal
 * semantics (strict existence, structural preservation, no validity
 * judgment); this wrapper keeps it on the SAME authoring-result path as
 * every other operation, so a removal flows through the app exactly like
 * a creation: applied → new document (dirty), refused → unchanged input
 * + a note (a stale selection is exposed, never swallowed). The UI never
 * splices the flow edges itself.
 */
export function removeConnection(document: ShaderGraphDocument, connectionId: string): AuthoringResult {
    const result = removeConnectionCore(document, connectionId);
    if (result.ok === false || result.document === null) {
        const reason = result.diagnostics[0]?.message ?? "The connection could not be removed at this revision.";
        return { document, applied: false, refusal: { reason }, createdId: undefined };
    }
    return { document: result.document, applied: true, refusal: undefined, createdId: undefined };
}

/**
 * Disconnect EVERY connection attached to one node port (both sides —
 * the fan-out of an output, the incoming of an input). The core owns the
 * strict semantics (node must exist, known-type ports must exist, zero
 * attachments is an honest no-op of the SAME document); the wrapper
 * keeps it on the authoring-result path like every other operation.
 */
export function removeConnectionsAtPort(
    document: ShaderGraphDocument,
    nodeId: string,
    portId: string,
): AuthoringResult {
    const result = removeConnectionsAtPortCore(document, nodeId, portId);
    if (result.ok === false || result.document === null) {
        const reason = result.diagnostics[0]?.message ?? "The port disconnect was not applied at this revision.";
        return { document, applied: false, refusal: { reason }, createdId: undefined };
    }
    return { document: result.document, applied: true, refusal: undefined, createdId: undefined };
}

/**
 * Move exactly ONE endpoint of the named connection (the core's atomic
 * form of reconnect: same id, same unknownFields, other endpoint
 * untouched). This is the ONLY sanctioned way the UI moves an endpoint —
 * never "remove + add" (that would split one undo identity into two and
 * rewrite the connection's stable id).
 */
export function reconnectConnection(
    document: ShaderGraphDocument,
    connectionId: string,
    change: { readonly side: "from" | "to"; readonly nodeId: string; readonly portId: string },
): AuthoringResult {
    const result = reconnectConnectionCore(document, connectionId, change);
    if (result.ok === false || result.document === null) {
        const reason = result.diagnostics[0]?.message ?? "The reconnect was not applied at this revision.";
        return { document, applied: false, refusal: { reason }, createdId: undefined };
    }
    return { document: result.document, applied: true, refusal: undefined, createdId: undefined };
}

function refused(document: ShaderGraphDocument, reason: string): AuthoringResult {
    return { document, applied: false, refusal: { reason }, createdId: undefined };
}
