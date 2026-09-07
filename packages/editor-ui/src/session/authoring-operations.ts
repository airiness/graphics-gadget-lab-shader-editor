/** GUI adapters over the core edit contract. Only drag payloads and initial
 * canvas placement are owned here. History and selection stay in the app. */
import { applyGraphEdit, isGraphType, type GraphEditCommand, type GraphEditResult, type GraphType, type ShaderGraphDocument, type ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import { withNodePosition } from "./node-position.js";
export type { ConstantValue } from "@gglab/shader-graph-core";
import type { ConstantValue } from "@gglab/shader-graph-core";

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
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
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

function project(result: GraphEditResult): AuthoringResult {
    return {
        document: result.document,
        applied: result.status !== "refused",
        refusal: result.status === "refused" ? { reason: result.diagnostics[0]?.message ?? "The graph edit was refused.", diagnostics: result.diagnostics } : undefined,
        createdId: result.createdId,
    };
}

/** Placement joins a successful creation in the same GUI transaction; a
 * refusal never writes metadata and a no-op never manufactures history. */
function createAt(document: ShaderGraphDocument, command: GraphEditCommand, position?: { x: number; y: number }): AuthoringResult {
    const result = applyGraphEdit(document, command);
    if (result.status !== "changed" || result.createdId === undefined || position === undefined) return project(result);
    return project({ ...result, document: withNodePosition(result.document, result.createdId, position) });
}

export function addNode(document: ShaderGraphDocument, type: string, options: { parameterId?: string; position?: { x: number; y: number } } = {}): AuthoringResult {
    return createAt(document, { kind: "add-node", nodeType: type, ...(options.parameterId === undefined ? {} : { parameterId: options.parameterId }) }, options.position);
}
export function removeNode(document: ShaderGraphDocument, nodeId: string): AuthoringResult {
    return project(applyGraphEdit(document, { kind: "remove-node", nodeId }));
}
export function setConstantValue(document: ShaderGraphDocument, nodeId: string, value: ConstantValue): AuthoringResult {
    return project(applyGraphEdit(document, { kind: "set-constant-value", nodeId, value }));
}
export function addConnection(document: ShaderGraphDocument, from: { nodeId: string; portId: string }, to: { nodeId: string; portId: string }): AuthoringResult {
    return project(applyGraphEdit(document, { kind: "add-connection", from, to }));
}
export interface ParameterRequest {
    readonly name: string;
    readonly class: string;
    readonly valueType: GraphType;
}
export function addParameter(document: ShaderGraphDocument, request: ParameterRequest, options: { position?: { x: number; y: number } } = {}): AuthoringResult {
    return createAt(document, { kind: "add-parameter", ...request }, options.position);
}
export function removeConnection(document: ShaderGraphDocument, connectionId: string): AuthoringResult {
    return project(applyGraphEdit(document, { kind: "remove-connection", connectionId }));
}
export function removeConnectionsAtPort(document: ShaderGraphDocument, port: { readonly nodeId: string; readonly portId: string; readonly side: "input" | "output" }): AuthoringResult {
    return project(applyGraphEdit(document, { kind: "disconnect-port", ...port }));
}
export function reconnectConnection(document: ShaderGraphDocument, connectionId: string, change: { readonly side: "from" | "to"; readonly nodeId: string; readonly portId: string }): AuthoringResult {
    return project(applyGraphEdit(document, { kind: "reconnect-connection", connectionId, ...change }));
}
