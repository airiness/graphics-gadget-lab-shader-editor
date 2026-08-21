/**
 * Port-aware graph type resolution (architecture §11) — the core's single
 * type authority. A pure forward pass over a parsed `ShaderGraphDocument`
 * resolving every node's every *output port* to one concrete graph value
 * type, keyed by (nodeId, portId).
 *
 * `resolveGraphTypes` is a pure function over one caller-supplied data
 * input: the parsed document. It needs no descriptor and no emission
 * context — parameter types come from the document's authored `valueType`
 * (the 2A invariant: exactly one concrete type per graph parameter), node
 * kinds from the core node catalog, and operation results from the core's
 * conservative result rules (§11.2: identical operands keep the type; a
 * scalar operand widens to the vector operand; nothing else is implicitly
 * convertible). The emitter, the CLI, and the UI all ask this one service
 * for port types; none of them re-derives them.
 *
 * Resolution is not emittability: a port resolves to a type even when a
 * later emission gate refuses to lower its node. v1 defers texture
 * sampling (frozen contract gap on the generated sampler spelling), and
 * `SampleTexture2D`'s six channel ports nonetheless resolve — RGBA to
 * float4, RGB to float3, R/G/B/A to float — exactly as the connection's
 * `from.portId` names them.
 *
 * Rules:
 *
 * - Forward only: a node's output types depend only on the types of the
 *   nodes feeding it. Resolution follows a deterministic whole-document
 *   topological order (Kahn's algorithm, ties broken by stable node id,
 *   never document array position), so incidentally reordered equivalent
 *   graphs resolve identically.
 * - Source nodes carry a fixed type: constants and `UV0` from their node
 *   definition's single-typed output port; parameter nodes
 *   (`ScalarParameter`, `VectorParameter`, `Texture2DParameter`) from the
 *   referenced parameter entry's authored `valueType`.
 * - `SampleTexture2D` resolves when both inputs resolve to the port types
 *   their definition requires (`Texture2D`, `float2`); its six output
 *   ports then resolve individually.
 * - Diagnostics are type-resolution failures only: an operation whose
 *   inputs cannot be typed under the result rules (TYPE_MISMATCH at the
 *   node), or a document cycle that prevents any deterministic forward
 *   order (CYCLE_DETECTED at "$"). Structural concerns — unknown node
 *   kinds, unresolved parameter references, missing required inputs,
 *   connection port/type validity — belong to validation and are not
 *   re-diagnosed here; those nodes are simply left unresolved.
 * - `values` is in resolution order, therefore deterministic for identical
 *   input.
 */
import type { ShaderGraphDiagnostic } from "./diagnostics.js";
import { DiagnosticCode } from "./diagnostics.js";
import { errorAt } from "./parse-helpers.js";
import type { GraphNode, ShaderGraphDocument } from "./graph-document.js";
import { isGraphType } from "./graph-types.js";
import type { GraphType } from "./graph-types.js";
import { getNodeDefinition } from "./node-definitions.js";

/** A graph value: one output port of one node (port-level identity). */
export interface GraphValueRef {
    readonly nodeId: string;
    readonly portId: string;
}

/** One resolved graph value: the port plus its concrete value type. */
export interface ResolvedGraphValue extends GraphValueRef {
    readonly type: GraphType;
}

export interface ResolvedGraphTypes {
    /** True when every resolvable node resolved and no rule failed. */
    readonly ok: boolean;
    /** Structured type-resolution failures (see module rules). */
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    /** Resolved (node, port, type) triples in deterministic resolution order. */
    readonly values: readonly ResolvedGraphValue[];
    /** The resolved concrete type of one output port, or undefined when unresolvable. */
    readonly typeAt: (nodeId: string, portId: string) => GraphType | undefined;
}

/** Convenience lookup kept next to the service it belongs to. */
export function resolvedTypeAt(resolved: ResolvedGraphTypes, nodeId: string, portId: string): GraphType | undefined {
    return resolved.typeAt(nodeId, portId);
}

export function resolveGraphTypes(document: ShaderGraphDocument): ResolvedGraphTypes {
    const nodes = document.nodes;
    const connections = document.connections;

    const nodeIdSet = new Set<string>(nodes.map((node) => node.id));
    const nodeById = new Map<string, GraphNode>(nodes.map((node) => [node.id, node]));
    const nodeIndexById = new Map<string, number>(nodes.map((node, index) => [node.id, index]));
    const parametersById = new Map(document.parameters.map((parameter) => [parameter.id, parameter]));

    const diagnostics: ShaderGraphDiagnostic[] = [];

    // Deterministic forward order over the *whole* document (the topology
    // service orders the live subgraph for emission; type resolution is a
    // property of the entire graph, dead regions included).
    const outgoing = new Map<string, Set<string>>();
    for (const node of nodes) {
        outgoing.set(node.id, new Set<string>());
    }
    for (const connection of connections) {
        if (!nodeIdSet.has(connection.from.nodeId) || !nodeIdSet.has(connection.to.nodeId)) {
            continue; // unresolved endpoints: the parse layer owns that.
        }
        const edge = outgoing.get(connection.from.nodeId);
        if (edge !== undefined) {
            edge.add(connection.to.nodeId);
        }
    }
    const inDegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
    for (const targets of outgoing.values()) {
        for (const target of targets) {
            inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
        }
    }
    const remaining = new Set<string>(nodes.map((node) => node.id));
    const order: string[] = [];
    for (;;) {
        let next: string | undefined;
        remaining.forEach((id) => {
            if ((inDegree.get(id) ?? 1) === 0 && (next === undefined || id < next)) {
                next = id;
            }
        });
        if (next === undefined) {
            break;
        }
        remaining.delete(next);
        order.push(next);
        for (const target of outgoing.get(next) ?? []) {
            inDegree.set(target, (inDegree.get(target) ?? 1) - 1);
        }
    }
    if (remaining.size > 0) {
        const cycleNodes = [...remaining].sort();
        return {
            ok: false,
            diagnostics: [
                errorAt(
                    "$",
                    DiagnosticCode.CycleDetected,
                    `Cycle detected among nodes (${cycleNodes.join(", ")}); no deterministic forward type resolution exists.`,
                ),
            ],
            values: [],
            typeAt: () => undefined,
        };
    }

    const values: ResolvedGraphValue[] = [];
    const typeByNodePort = new Map<string, GraphType>();
    const diagnosed = new Set<string>();

    const nodePathOf = (node: GraphNode): string => `$.nodes[${nodeIndexById.get(node.id) ?? 0}]`;
    const failNode = (node: GraphNode, message: string): void => {
        if (diagnosed.has(node.id)) {
            return;
        }
        diagnosed.add(node.id);
        diagnostics.push(errorAt(nodePathOf(node), DiagnosticCode.TypeMismatch, `Node "${node.id}" (${node.type}): ${message}`));
    };
    const setPort = (node: GraphNode, portId: string, type: GraphType): void => {
        typeByNodePort.set(`${node.id}\u0000${portId}`, type);
        values.push({ nodeId: node.id, portId, type });
    };
    const typeAt = (nodeId: string, portId: string): GraphType | undefined => typeByNodePort.get(`${nodeId}\u0000${portId}`);

    // The single connection feeding (node, port), as a *port-level* value
    // reference: the source node plus the exact output port it uses.
    const inputTypeOf = (nodeId: string, portId: string): GraphType | undefined => {
        const connection = connections.find((candidate) => candidate.to.nodeId === nodeId && candidate.to.portId === portId);
        if (connection === undefined) {
            return undefined;
        }
        return typeAt(connection.from.nodeId, connection.from.portId);
    };

    // Conservative binary result rule (§11.2): identical operands keep the
    // type; a scalar operand widens to the vector operand; distinct vector
    // sizes are not implicitly convertible.
    const combineBinary = (node: GraphNode, a: GraphType, b: GraphType): GraphType | undefined => {
        if (a === b) {
            return a;
        }
        if (a === "float") {
            return b;
        }
        if (b === "float") {
            return a;
        }
        failNode(node, `operands of distinct vector sizes (${a} and ${b}) are not implicitly convertible`);
        return undefined;
    };

    const resolveNode = (node: GraphNode): void => {
        switch (node.type) {
            case "Float":
            case "Float2":
            case "Float3":
            case "Float4":
            case "UV0": {
                // Fixed by the node definition's single-typed output port.
                const port = getNodeDefinition(node.type)?.outputs.find((entry) => entry.id === "value");
                const type = port?.types[0];
                if (type !== undefined && isGraphType(type)) {
                    setPort(node, "value", type);
                }
                return;
            }
            case "ScalarParameter":
            case "VectorParameter":
            case "Texture2DParameter": {
                // Authored on the parameter entry; never inferred. A missing
                // or dangling reference is validation's diagnostic.
                const referenceId = node.properties["parameterId"];
                const entry = typeof referenceId === "string" ? parametersById.get(referenceId) : undefined;
                if (entry !== undefined) {
                    setPort(node, "value", entry.valueType);
                }
                return;
            }
            case "Saturate":
            case "OneMinus": {
                // Value-preserving unary: the type of the operand, when it
                // resolves. Unresolved operands fail where consumed.
                const type = inputTypeOf(node.id, "value");
                if (type !== undefined) {
                    setPort(node, "value", type);
                }
                return;
            }
            case "Normalize": {
                const type = inputTypeOf(node.id, "value");
                if (type === undefined) {
                    return;
                }
                if (type === "float") {
                    failNode(node, "Normalize requires a vector input (float2/float3/float4), not a scalar float");
                    return;
                }
                setPort(node, "value", type);
                return;
            }
            case "Add":
            case "Subtract":
            case "Multiply":
            case "Divide":
            case "Min":
            case "Max": {
                const a = inputTypeOf(node.id, "a");
                const b = inputTypeOf(node.id, "b");
                if (a === undefined || b === undefined) {
                    failNode(node, "an input's output type could not be resolved");
                    return;
                }
                const type = combineBinary(node, a, b);
                if (type !== undefined) {
                    setPort(node, "value", type);
                }
                return;
            }
            case "Lerp": {
                const t = inputTypeOf(node.id, "t");
                if (t !== "float") {
                    failNode(node, 'the "t" input must be a float');
                    return;
                }
                const a = inputTypeOf(node.id, "a");
                const b = inputTypeOf(node.id, "b");
                if (a === undefined || b === undefined) {
                    failNode(node, "an input's output type could not be resolved");
                    return;
                }
                const type = combineBinary(node, a, b);
                if (type !== undefined) {
                    setPort(node, "value", type);
                }
                return;
            }
            case "Dot": {
                const a = inputTypeOf(node.id, "a");
                const b = inputTypeOf(node.id, "b");
                if (a === undefined || b === undefined || a !== b || a === "float") {
                    failNode(node, `Dot requires both inputs to be the same vector size (float2/float3/float4), got ${a ?? "unresolved"} and ${b ?? "unresolved"}`);
                    return;
                }
                setPort(node, "value", "float");
                return;
            }
            case "SampleTexture2D": {
                // Both inputs must resolve to the types the definition
                // requires; channel ports then resolve individually.
                if (inputTypeOf(node.id, "texture") === "Texture2D" && inputTypeOf(node.id, "uv") === "float2") {
                    setPort(node, "RGBA", "float4");
                    setPort(node, "RGB", "float3");
                    setPort(node, "R", "float");
                    setPort(node, "G", "float");
                    setPort(node, "B", "float");
                    setPort(node, "A", "float");
                }
                return;
            }
            case "SurfaceOutput":
                return; // no output ports
            default:
                return; // unknown kind: validation owns its diagnostic.
        }
    };

    for (const nodeId of order) {
        const node = nodeById.get(nodeId);
        if (node !== undefined) {
            resolveNode(node);
        }
    }

    return { ok: diagnostics.length === 0, diagnostics, values, typeAt };
}
