/**
 * Structural compilation pipeline (architecture §13, stages: find output
 * roots → reachability / dead-node elimination → cycle detection →
 * deterministic topological order).
 *
 * `resolveGraphTopology` is a pure function over a parsed
 * `ShaderGraphDocument`. It answers one question: in which order does the
 * live subgraph execute? It is the structural precondition for HLSL
 * emission; emission and source maps are the next stage, not this one.
 *
 * Rules:
 *
 * - Output roots are the nodes whose node definition places them in the
 *   "output" category (for `gglab.surface` v1: SurfaceOutput). Roots are
 *   always live.
 * - A node is live when an output root depends on it through the
 *   connection network (reverse walk along connections).
 * - Dead nodes are eliminated from the topological order and reported as
 *   data (`deadNodeIds`), not as a diagnostic: §13 places reachability /
 *   dead-node elimination in the compilation pipeline, and the initial
 *   validation list defines no dead-node diagnostic. Frontends decide how
 *   to present them.
 * - The topological order is deterministic and deliberately independent of
 *   incidental node/connection creation or serialization order: Kahn's
 *   algorithm with ties broken by stable node id (the semantic identity),
 *   never by document array position. Equivalently connected graphs in
 *   different array order resolve to the identical order.
 * - The stage operates on the live subgraph. A cycle among live nodes
 *   yields `ok: false` with a CYCLE_DETECTED diagnostic and no partial
 *   order. Cycles confined to dead nodes do not block the order. Global
 *   acyclicity of the whole document is the validation stage's rule
 *   (same code, broader scope).
 * - Connections whose endpoints do not name a node in this document are
 *   ignored here; the parse layer owns unresolved references.
 * - A node whose type is unknown to the core is never an output root, but
 *   it participates in reachability like any other node.
 * - No roots in the document is a degenerate but well-defined result:
 *   `ok: true`, everything dead, empty order. The authoring diagnostic for
 *   a profile missing its output node is validation's MissingOutput.
 */
import type { ShaderGraphDiagnostic } from "./diagnostics.js";
import { DiagnosticCode } from "./diagnostics.js";
import type { ShaderGraphDocument } from "./graph-document.js";
import { errorAt } from "./parse-helpers.js";
import { getNodeDefinition } from "./node-definitions.js";

export interface GraphTopology {
    readonly ok: boolean;
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    /** Output-root node ids, ordered by stable node id. */
    readonly outputRootIds: readonly string[];
    /** Node ids not reachable from any output root, ordered by node id. */
    readonly deadNodeIds: readonly string[];
    /**
     * Deterministic topological order of the live subgraph: sources first,
     * output roots last. Empty when the live subgraph contains a cycle.
     */
    readonly executionOrder: readonly string[];
}

export function resolveGraphTopology(document: ShaderGraphDocument): GraphTopology {
    const nodes = document.nodes;
    const connections = document.connections;

    const nodeIdSet = new Set<string>(nodes.map((node) => node.id));

    // Output roots: nodes in the "output" category of their node definition.
    const outputRootIds = nodes
        .filter((node) => getNodeDefinition(node.type)?.category === "output")
        .map((node) => node.id)
        .sort();

    // Node-level edges, deduplicated per node pair; unresolved endpoints are
    // ignored (parse layer).
    const outgoing = new Map<string, Set<string>>();
    for (const node of nodes) {
        outgoing.set(node.id, new Set<string>());
    }
    for (const connection of connections) {
        const from = connection.from.nodeId;
        const to = connection.to.nodeId;
        if (!nodeIdSet.has(from) || !nodeIdSet.has(to)) {
            continue;
        }
        const edge = outgoing.get(from);
        if (edge !== undefined) {
            edge.add(to);
        }
    }

    // Reverse adjacency: target -> sources.
    const sourcesOf = new Map<string, Set<string>>();
    for (const node of nodes) {
        sourcesOf.set(node.id, new Set<string>());
    }
    for (const [source, targets] of outgoing) {
        for (const target of targets) {
            const set = sourcesOf.get(target);
            if (set !== undefined) {
                set.add(source);
            }
        }
    }

    // Reverse walk from the roots: a source is live when a live target
    // receives from it through any connection.
    const live = new Set<string>(outputRootIds);
    const walk: string[] = [...outputRootIds];
    while (walk.length > 0) {
        const current = walk.pop();
        if (current === undefined) {
            continue;
        }
        const sources = sourcesOf.get(current);
        if (sources === undefined) {
            continue;
        }
        for (const source of sources) {
            if (!live.has(source)) {
                live.add(source);
                walk.push(source);
            }
        }
    }
    const deadNodeIds = nodes
        .map((node) => node.id)
        .filter((id) => !live.has(id))
        .sort();

    // Live subgraph: in-degrees over distinct (source, target) pairs.
    const liveIds = nodes.map((node) => node.id).filter((id) => live.has(id));
    const inDegree = new Map<string, number>(liveIds.map((id) => [id, 0]));
    for (const source of liveIds) {
        const edge = outgoing.get(source);
        if (edge === undefined) {
            continue;
        }
        for (const target of edge) {
            if (!live.has(target)) {
                continue;
            }
            const degree = inDegree.get(target);
            if (degree !== undefined) {
                inDegree.set(target, degree + 1);
            }
        }
    }

    // Kahn's algorithm; ties broken by stable node id, never by document
    // position, so incidental serialization order cannot perturb the result.
    const remaining = new Set<string>(liveIds);
    const executionOrder: string[] = [];
    for (;;) {
        let next: string | undefined;
        remaining.forEach((id) => {
            if (inDegree.get(id) === 0 && (next === undefined || id < next)) {
                next = id;
            }
        });
        const choice = next;
        if (choice === undefined) {
            break;
        }
        remaining.delete(choice);
        executionOrder.push(choice);
        const edge = outgoing.get(choice);
        if (edge !== undefined) {
            for (const target of edge) {
                const degree = inDegree.get(target);
                if (degree !== undefined) {
                    inDegree.set(target, degree - 1);
                }
            }
        }
    }

    if (remaining.size > 0) {
        const cycleNodes = [...remaining].sort();
        const diagnostics: ShaderGraphDiagnostic[] = [
            errorAt(
                "$",
                DiagnosticCode.CycleDetected,
                `Cycle detected among live nodes (${cycleNodes.join(", ")}); no deterministic topological order exists.`,
            ),
        ];
        return { ok: false, diagnostics, outputRootIds, deadNodeIds, executionOrder: [] };
    }

    return { ok: true, diagnostics: [], outputRootIds, deadNodeIds, executionOrder };
}
