/**
 * Port-aware graph type resolution (architecture §11) — the core's single
 * type authority. A pure forward pass over a parsed `ShaderGraphDocument`
 * resolving every node's every *output port* to one concrete graph value
 * type, keyed by (nodeId, portId).
 *
 * `resolveGraphTypes` is a pure function over one caller-supplied data
 * input: the parsed document (plus an optional scope). It needs no
 * descriptor and no emission context — parameter types come from the
 * document's authored `valueType` (exactly one concrete type per graph
 * parameter), node kinds from the core node catalog, and operation results
 * from the core's conservative result rules (§11.2: identical operands keep
 * the type; a scalar operand widens to the vector operand; nothing else is
 * implicitly convertible). The emitter, the CLI, and the UI all ask this
 * one service for port types; none of them re-derives them.
 *
 * The resolver is standalone authority, not a calculator with preconditions:
 *
 * - Concrete input constraints: for every connection feeding a declared
 *   input port, the source's concrete type must be one of the types the
 *   port declares — operation inputs, the texture sampler's
 *   texture/uv inputs, and the output node's required outputs alike. A
 *   violation is a TYPE_MISMATCH at the consuming node; it is never
 *   silently left unresolved, never patched over, and never the
 *   validation stage's job (validation checks the allowed-set
 *   intersection between the two ports' definitions, which is coarser).
 * - Resolution scope: by default the whole document (authoring consumers
 *   want types for every node on the canvas). A scope (`nodeIds`)
 *   restricts resolution to the induced subgraph — the live slice for
 *   compilation — so dead authoring content (trial nodes, disconnected
 *   experiments) can carry type failures without blocking emission. One
 *   implementation, two domains: semantic universe vs compiled live slice.
 * - Semantic version respect: a node whose version is outside its
 *   definition's supported range carries no resolved types (it may be a
 *   future semantic this core does not implement); the core does not guess
 *   that it behaves like the nearest supported version. Validation owns
 *   the diagnostic for such versions; the resolver simply refuses to
 *   grant them v1 semantics, and consumers treat them as unresolvable.
 *
 * Resolution is not emittability: a port resolves to a type even when a
 * later emission gate refuses to lower its node. v1 defers texture
 * sampling (frozen contract gap on the generated sampler spelling), and
 * `SampleTexture2D`'s six channel ports nonetheless resolve — RGBA to
 * float4, RGB to float3, R/G/B/A to float — exactly as the connection's
 * `from.portId` names them.
 *
 * Forward order: deterministic topological order (Kahn's algorithm, ties
 * broken by stable node id, never document array position), so incidentally
 * reordered equivalent graphs resolve identically. A cycle within the
 * resolved domain yields ok:false with CYCLE_DETECTED at "$" and no
 * partial resolution.
 *
 * Diagnostics are type-resolution failures only: an input whose concrete
 * type is outside its port's declaration, or an operation whose inputs
 * cannot be typed under the result rules — both TYPE_MISMATCH at the node.
 * Structural concerns (unknown node kinds, unresolved parameter references,
 * missing required inputs, unconnected ports) belong to validation and are
 * not re-diagnosed here; those nodes are simply left unresolved.
 *
 * `values` is in resolution order, therefore deterministic for identical
 * input and scope.
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
    /** True when no resolution rule failed within the resolved domain. */
    readonly ok: boolean;
    /** Structured type-resolution failures (see module rules). */
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    /** Resolved (node, port, type) triples in deterministic resolution order. */
    readonly values: readonly ResolvedGraphValue[];
    /** The resolved concrete type of one output port, or undefined when unresolvable. */
    readonly typeAt: (nodeId: string, portId: string) => GraphType | undefined;
}

export interface GraphTypeResolutionOptions {
    /**
     * Restrict resolution to these node ids (the induced subgraph). Emission
     * resolves the live slice so that dead authoring content can carry type
     * failures without blocking compilation; omit for whole-document
     * resolution, which authoring consumers use for the whole canvas.
     */
    readonly nodeIds?: ReadonlySet<string>;
}

/** Convenience lookup kept next to the service it belongs to. */
export function resolvedTypeAt(resolved: ResolvedGraphTypes, nodeId: string, portId: string): GraphType | undefined {
    return resolved.typeAt(nodeId, portId);
}

export function resolveGraphTypes(document: ShaderGraphDocument, options?: GraphTypeResolutionOptions): ResolvedGraphTypes {
    const nodes = document.nodes;
    const connections = document.connections;

    const inScope = (id: string): boolean => options?.nodeIds === undefined || options.nodeIds.has(id);
    const scopedNodes = nodes.filter((node) => inScope(node.id));
    const nodeIdSet = new Set<string>(nodes.map((node) => node.id));
    const nodeById = new Map<string, GraphNode>(nodes.map((node) => [node.id, node]));
    const nodeIndexById = new Map<string, number>(nodes.map((node, index) => [node.id, index]));
    const parametersById = new Map(document.parameters.map((parameter) => [parameter.id, parameter]));

    const diagnostics: ShaderGraphDiagnostic[] = [];

    // Deterministic forward order over the resolved domain (the whole
    // document by default; the live subgraph when emission scopes it).
    // The topology service orders the live subgraph for the pipeline; type
    // resolution is a property of the graph the consumer chose to resolve.
    const outgoing = new Map<string, Set<string>>();
    for (const node of scopedNodes) {
        outgoing.set(node.id, new Set<string>());
    }
    for (const connection of connections) {
        if (!inScope(connection.from.nodeId) || !inScope(connection.to.nodeId) || !nodeIdSet.has(connection.from.nodeId) || !nodeIdSet.has(connection.to.nodeId)) {
            continue; // out of domain, or unresolved endpoints (parse layer).
        }
        const edge = outgoing.get(connection.from.nodeId);
        if (edge !== undefined) {
            edge.add(connection.to.nodeId);
        }
    }
    const inDegree = new Map<string, number>(scopedNodes.map((node) => [node.id, 0]));
    for (const targets of outgoing.values()) {
        for (const target of targets) {
            inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
        }
    }
    const remaining = new Set<string>(scopedNodes.map((node) => node.id));
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
    // reference: the source node plus the exact output port it uses (no
    // implicit default port). The source's concrete type must be one the
    // port declares — the resolver's concrete input constraint, applied
    // uniformly to every declared input (operations, the texture sampler,
    // required outputs alike).
    const inputTypeOf = (node: GraphNode, portId: string): GraphType | undefined => {
        const connection = connections.find((candidate) => candidate.to.nodeId === node.id && candidate.to.portId === portId);
        if (connection === undefined) {
            return undefined; // unconnected input: validation owns that.
        }
        const sourceType = typeAt(connection.from.nodeId, connection.from.portId);
        if (sourceType === undefined) {
            return undefined; // unresolvable source: the consumer's rule decides.
        }
        const targetPort = getNodeDefinition(node.type)?.inputs.find((port) => port.id === portId);
        if (targetPort !== undefined && !targetPort.types.includes(sourceType)) {
            failNode(node, `input "${portId}" accepts only ${targetPort.types.map((type) => `"${type}"`).join(" / ")}, but the connected source provides "${sourceType}"`);
            return undefined;
        }
        return sourceType;
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
        const definition = getNodeDefinition(node.type);
        if (definition === undefined) {
            return; // unknown kind: validation owns its diagnostic.
        }
        // A node version the core does not implement carries no resolved
        // types: the core does not guess that a future semantic behaves
        // like the nearest supported version (validation owns the
        // diagnostic; consumers below this service see an unresolvable
        // source).
        if (node.version < definition.versionRange.minimumVersion || node.version > definition.versionRange.maximumVersion) {
            return;
        }
        switch (node.type) {
            case "Float":
            case "Float2":
            case "Float3":
            case "Float4":
            case "UV0": {
                // Fixed by the node definition's single-typed output port.
                const port = definition.outputs.find((entry) => entry.id === "value");
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
                // resolves and passes the input constraint. Unresolved
                // operands fail where consumed.
                const type = inputTypeOf(node, "value");
                if (type !== undefined) {
                    setPort(node, "value", type);
                }
                return;
            }
            case "Normalize": {
                const type = inputTypeOf(node, "value");
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
                const a = inputTypeOf(node, "a");
                const b = inputTypeOf(node, "b");
                if (a === undefined || b === undefined) {
                    if (!diagnosed.has(node.id)) {
                        failNode(node, "an input's output type could not be resolved");
                    }
                    return;
                }
                const type = combineBinary(node, a, b);
                if (type !== undefined) {
                    setPort(node, "value", type);
                }
                return;
            }
            case "Lerp": {
                const t = inputTypeOf(node, "t");
                if (t !== "float") {
                    if (!diagnosed.has(node.id)) {
                        failNode(node, 'the "t" input must be a float');
                    }
                    return;
                }
                const a = inputTypeOf(node, "a");
                const b = inputTypeOf(node, "b");
                if (a === undefined || b === undefined) {
                    if (!diagnosed.has(node.id)) {
                        failNode(node, "an input's output type could not be resolved");
                    }
                    return;
                }
                const type = combineBinary(node, a, b);
                if (type !== undefined) {
                    setPort(node, "value", type);
                }
                return;
            }
            case "Dot": {
                const a = inputTypeOf(node, "a");
                const b = inputTypeOf(node, "b");
                if (a === undefined || b === undefined || a !== b || a === "float") {
                    failNode(node, `Dot requires both inputs to be the same vector size (float2/float3/float4), got ${a ?? "unresolved"} and ${b ?? "unresolved"}`);
                    return;
                }
                setPort(node, "value", "float");
                return;
            }
            case "SampleTexture2D": {
                // Both inputs must resolve and pass the input constraint
                // (texture: Texture2D, uv: float2, fixed by the
                // definition); the channel ports then resolve individually.
                if (inputTypeOf(node, "texture") !== undefined && inputTypeOf(node, "uv") !== undefined) {
                    setPort(node, "RGBA", "float4");
                    setPort(node, "RGB", "float3");
                    setPort(node, "R", "float");
                    setPort(node, "G", "float");
                    setPort(node, "B", "float");
                    setPort(node, "A", "float");
                }
                return;
            }
            case "SurfaceOutput": {
                // No output ports, but every required output is a declared
                // input: its concrete source type is checked against the
                // declared domain by inputTypeOf (a wrong-typed required
                // output is a structured type failure, not a silently
                // unresolvable edge).
                for (const input of definition.inputs) {
                    inputTypeOf(node, input.id);
                }
                return;
            }
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
