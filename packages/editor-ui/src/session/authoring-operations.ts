/**
 * Authoring operations on the graph document — presentation-side data
 * construction only, and only where a frontend legitimately owns the answer
 * (stable-id derivation, document location). Every operation is atomic: a
 * REFUSAL returns the unchanged input together with a structured refusal,
 * never a halfway state; every ACCEPTED MUTATION returns a new document;
 * an ACCEPTED NO-OP (a same-endpoint reconnect, a zero-attachment port
 * disconnect) preserves the input instance — document identity, not the
 * `applied` flag, is the mutation fact (see `AuthoringResult`).
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

/**
 * The result of a core-judged authoring operation.
 *
 * There are THREE distinct outcomes, and consumers must read them as
 * three:
 *
 *   - CHANGED — `applied === true` and `document !== input` (by
 *     identity): a new document instance carrying the mutation;
 *   - ACCEPTED NO-OP — `applied === true` and `document === input`: the
 *     core accepted the operation and it was judged a no-op at this
 *     revision (a same-endpoint reconnect, a zero-attachment port
 *     disconnect), so the ORIGINAL document instance is returned
 *     unchanged;
 *   - REFUSED — `applied === false`: the input is returned unchanged
 *     together with a structured `refusal`.
 *
 * `applied` therefore means "the operation was ACCEPTED by the core" —
 * not "the document changed". Document IDENTITY is the mutation fact,
 * and the consumer decides what a change implies (history, invalidation
 * of derivative state); an accepted no-op implies neither, and a
 * derivation built on `applied` alone would be wrong.
 */
export interface AuthoringResult {
    /** The new document; the unchanged input when the core refused or accepted a no-op. */
    readonly document: ShaderGraphDocument;
    /** The operation was accepted by the core (CHANGED or ACCEPTED NO-OP). */
    readonly applied: boolean;
    readonly refusal: AuthoringRefusal | undefined;
    /** The id of the entry this operation created (`applied` only, CHANGED). */
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

/**
 * Remove a node and every connection that touches it (data integrity).
 *
 * The removal is WHOLE: the node, its connections (either end), AND its
 * placement entry in `editorMetadata.nodes` — a removed node must not
 * leave session metadata behind that would be persisted (or resurrect a
 * position if the id is ever reused). Everything else, including the
 * other nodes' placements and all retained unknown fields, is preserved.
 */
export function removeNode(document: ShaderGraphDocument, nodeId: string): AuthoringResult {
    if (document.nodes.some((node) => node.id === nodeId) === false) {
        return refused(document, `No node with id "${nodeId}".`);
    }
    const placements = document.editorMetadata.nodes;
    const documentOut: ShaderGraphDocument = {
        ...document,
        nodes: document.nodes.filter((node) => node.id !== nodeId),
        connections: document.connections.filter((connection) => {
            const from: ConnectionEnd = connection.from;
            const to: ConnectionEnd = connection.to;
            return from.nodeId !== nodeId && to.nodeId !== nodeId;
        }),
        ...(nodeId in placements ? { editorMetadata: { ...document.editorMetadata, nodes: Object.fromEntries(Object.entries(placements).filter(([id]) => id !== nodeId)) } } : {}),
    };
    return { document: documentOut, applied: true, refusal: undefined, createdId: undefined };
}

/** A constant value: one finite number, or an array of finite numbers. */
export type ConstantValue = number | readonly number[];

/**
 * The catalog-declared value shapes of the constant family (single node
 * authority: read from the definition, not invented here). float → 1
 * component, floatN → N.
 */
const CONSTANT_COMPONENT_COUNT: Record<string, number> = { float: 1, float2: 2, float3: 3, float4: 4 };

/**
 * Set a constant node's value — the only node family whose value lives
 * in the document. (Parameter values are runtime-owned: they enter
 * through the generated-function signature and deliberately never exist
 * in the document, so there is no "set parameter value" to build.)
 *
 * Judgment is catalog-driven: the node must be a KNOWN constant with a
 * "value" property, and the submitted value must match the catalog
 * shape exactly — a finite number, or exactly N finite numbers for
 * floatN. Nothing is widened, truncated, or default-filled; the
 * submitted value is stored as-submitted (or refused).
 *
 * The three outcomes, one contract:
 *   - a valid but EQUAL value → an ACCEPTED NO-OP: the SAME instance
 *     comes back (identity is the mutation fact, so it records no
 *     history and churns no preview);
 *   - a different valid value → a MUTATION: a new instance, the node's
 *     other properties and everything else preserved;
 *   - anything else (unknown id, non-constant node, wrong shape) → a
 *     REFUSAL: the unchanged instance plus a structured reason.
 */
export function setConstantValue(document: ShaderGraphDocument, nodeId: string, value: ConstantValue): AuthoringResult {
    const node = document.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) {
        return refused(document, `No node with id "${nodeId}".`);
    }
    const definition = getNodeDefinition(node.type);
    const spec = definition !== undefined && definition.category === "constant" ? definition.properties.find((property) => property.name === "value") : undefined;
    const expected = spec !== undefined ? CONSTANT_COMPONENT_COUNT[spec.type] : undefined;
    if (definition === undefined || definition.category !== "constant" || spec === undefined || expected === undefined) {
        return refused(document, `Node "${nodeId}" (${node.type}) is not a catalog constant with a value property; only constant nodes own their document values.`);
    }
    const valid =
        expected === 1
            ? typeof value === "number" && Number.isFinite(value)
            : Array.isArray(value) === true && value.length === expected && value.every((component) => typeof component === "number" && Number.isFinite(component) === true);
    if (valid === false) {
        return refused(document, `Node "${nodeId}" (${node.type}) expects ${expected === 1 ? "a finite number" : `an array of exactly ${expected} finite numbers`} for its value; the submitted value was not accepted (nothing was changed).`);
    }
    const current = node.properties["value"];
    const same =
        expected === 1
            ? typeof current === "number" && Number.isFinite(current) === true && Object.is(current, value)
            : Array.isArray(current) === true && Array.isArray(value) === true && current.length === expected && current.every((component, index) => Object.is(component, value[index]));
    if (same === true) {
        // ACCEPTED NO-OP — the SAME instance: identity is the mutation
        // fact, and an equal value is not a mutation.
        return { document, applied: true, refusal: undefined, createdId: undefined };
    }
    const stored: number | number[] = expected === 1 ? (value as number) : [...(value as readonly number[])];
    return {
        document: {
            ...document,
            nodes: document.nodes.map((candidate) => (candidate.id === nodeId ? { ...candidate, properties: { ...candidate.properties, value: stored } } : candidate)),
        },
        applied: true,
        refusal: undefined,
        createdId: undefined,
    };
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
 * Disconnect the connections attached to ONE side of a node port — the
 * incoming of an input, the fan-out of an output. The port is passed as
 * the core's full three-part identity (node + port + SIDE): the catalog
 * ships same-named input/output ports (Saturate, OneMinus), so the side
 * is part of identity, not convenience. The UI knows which handle was
 * clicked and passes it through; the core owns the strict semantics
 * (node must exist, the port must exist on THAT side, zero attachments
 * is an honest no-op of the SAME document); the wrapper keeps it on the
 * authoring-result path like every other operation.
 */
export function removeConnectionsAtPort(
    document: ShaderGraphDocument,
    port: { readonly nodeId: string; readonly portId: string; readonly side: "input" | "output" },
): AuthoringResult {
    const result = removeConnectionsAtPortCore(document, port);
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
