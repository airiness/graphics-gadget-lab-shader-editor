/**
 * Authoring operations on the graph document — presentation-side data
 * construction only. Every operation returns a new document (or a
 * structured refusal); it never pre-judges validity. Semantic authority stays
 * in the headless core: the composition root re-asks the core's services
 * (validation, port-level type resolution, conformance) after each
 * operation, and structured diagnostics are what the user sees. An
 * operation can therefore "do the thing"; whether the thing is legal is
 * always the core's call, reported in the core's stable codes.
 *
 * Stable ids are derived deterministically from the document's existing
 * ids (the next free numeric suffix in the node/connection/parameter
 * namespaces), never from pointers, array indices, or time — ids must stay
 * stable across save/load re-serialization (core rule).
 */
import type {
    ConnectionEnd,
    GraphConnection,
    GraphNode,
    GraphParameter,
    GraphType,
    JsonValue,
    ShaderGraphDocument,
} from "@gglab/shader-graph-core";
import { getNodeDefinition } from "@gglab/shader-graph-core";

export interface AuthoringRefusal {
    readonly reason: string;
}

export interface AuthoringResult {
    /** The new document, or the unchanged input on refusal. */
    readonly document: ShaderGraphDocument;
    readonly applied: boolean;
    readonly refusal: AuthoringRefusal | undefined;
    /** The id of the entry this operation created (applied only). */
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

/**
 * Add a node of a type from the core's node catalog. For a parameter node
 * (one that names a document parameter), the parameter must already exist —
 * it is created first via `addParameter`; adding a parameter node without
 * `parameterId` is a structured refusal, never a silent placeholder.
 */
export function addNode(
    document: ShaderGraphDocument,
    type: string,
    options: { parameterId?: string; position?: { x: number; y: number } } = {},
): AuthoringResult {
    const definition = getNodeDefinition(type);
    if (definition === undefined) {
        return refused(document, `No node catalog entry for type "${type}".`);
    }
    const requiresParameter = definition.referenceProperties.some((reference) => reference.name === "parameterId");
    if (requiresParameter && options.parameterId === undefined) {
        return refused(document, `Node type "${type}" names a document parameter; create the graph parameter first (Add Parameter).`);
    }
    const node: GraphNode = {
        id: nextStableId("n", takenNodeIds(document)),
        type,
        version: definition.versionRange.minimumVersion,
        properties: {
            ...(requiresParameter && options.parameterId !== undefined ? { parameterId: options.parameterId } : {}),
            ...defaultProperties(definition.properties),
        },
        unknownFields: {},
    };
    const nodes = [...document.nodes, node];
    const editorMetadata =
        options.position !== undefined
            ? { ...document.editorMetadata, nodes: { ...document.editorMetadata.nodes, [node.id]: { position: options.position, unknownFields: {} } } }
            : document.editorMetadata;
    return {
        document: { ...document, nodes, editorMetadata: { ...editorMetadata } },
        applied: true,
        refusal: undefined,
        createdId: node.id,
    };
}

/** Numeric property defaults for newly added nodes (0 / [0, 0, ...]). */
function defaultProperties(properties: readonly { name: string; type: string; required: boolean }[]): { [name: string]: JsonValue } {
    const propertiesOut: { [name: string]: JsonValue } = {};
    for (const property of properties) {
        if (!property.required) {
            continue;
        }
        if (property.type === "float") {
            propertiesOut[property.name] = 0;
        } else if (property.type === "float2") {
            propertiesOut[property.name] = [0, 0];
        } else if (property.type === "float3") {
            propertiesOut[property.name] = [0, 0, 0];
        } else if (property.type === "float4") {
            propertiesOut[property.name] = [0, 0, 0, 0];
        }
        // Non-numeric required properties are left to explicit authoring;
        // the core's validation will name them if they remain absent.
    }
    return propertiesOut;
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
 * it), so the canvas immediately shows what the parameter stands for.
 * The (class, valueType) pairing is not judged here — the core's
 * conformance service checks it against the loaded descriptor.
 */
export function addParameter(document: ShaderGraphDocument, request: ParameterRequest): AuthoringResult {
    const parameterId = nextStableId("p", takenParameterIds(document));
    const parameter: GraphParameter = {
        id: parameterId,
        name: request.name,
        class: request.class,
        valueType: request.valueType,
        unknownFields: {},
    };
    const parameterDocument: ShaderGraphDocument = { ...document, parameters: [...document.parameters, parameter] };
    return addNode(parameterDocument, nodeTypeForParameterClass(request.class), { parameterId });
}

/** The parameter node type that carries each parameter class. */
function nodeTypeForParameterClass(parameterClass: string): string {
    if (parameterClass === "ScalarParameter") {
        return "ScalarParameter";
    }
    if (parameterClass === "VectorParameter") {
        return "VectorParameter";
    }
    if (parameterClass === "Texture2DParameter") {
        return "Texture2DParameter";
    }
    return parameterClass;
}

function refused(document: ShaderGraphDocument, reason: string): AuthoringResult {
    return { document, applied: false, refusal: { reason }, createdId: undefined };
}
