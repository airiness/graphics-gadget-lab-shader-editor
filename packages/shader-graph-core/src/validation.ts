/**
 * Graph validation (architecture §13, initial validations).
 *
 * `validateShaderGraph` is a pure function over a parsed
 * `ShaderGraphDocument`. It produces structured authoring diagnostics, never
 * asserts: warnings leave `ok` true, any error sets it false.
 *
 * Rules (the §13 initial list):
 *
 *   UnknownNodeType        node type not defined by this core            (warning)
 *   UnsupportedNodeVersion node version outside the definition's range   (warning)
 *                          code value: UNKNOWN_NODE_VERSION, shared with
 *                          the parse layer
 *   UnknownPort            connection endpoint references a port the
 *                          node definition does not declare              (error)
 *   InvalidConnection      connection starts at an input port or ends at
 *                          an output port (wrong side of a port)         (error)
 *   MissingRequiredInput   required input port without an incoming
 *                          connection                                    (error)
 *   DuplicateConnection    an input port receives more than one incoming
 *                          connection (§11.3: one incoming semantic
 *                          connection per input port)                    (error)
 *   TypeMismatch           connection endpoints share no compatible type
 *                          (conservative: identity only, §11.2)          (error)
 *   CycleDetected          node-level directed cycle; the graph must be a DAG (error)
 *   MissingOutput          a document declaring a supported profile
 *                          contains no output node for that profile      (error)
 *   UnknownProfileFeature  document requests a profile/version this core
 *                          does not implement                            (error)
 *
 * Interpretation notes (recorded for review):
 * - "Duplicate/invalid connection" in the document is one list item; the core
 *   exposes it as two stable codes, one per rule, because the stable-code
 *   policy forbids folding distinct rules together.
 * - Unused/dead outputs are not a validation diagnostic: §13 places
 *   reachability/dead-node elimination in the compilation pipeline, not in
 *   initial validations.
 * - Nodes whose type is unknown are skipped for port, type, and cardinality
 *   checks (they are already warned above); parse-level unresolved node
 *   references are likewise not re-reported.
 * - Parameter-class vocabulary is descriptor-owned data; cross-checking a
 *   document's parameter classes against a parsed descriptor arrives with
 *   descriptor-aware tooling (the CLI validate surface), not here.
 */
import type { ShaderGraphDiagnostic } from "./diagnostics.js";
import { DiagnosticCode } from "./diagnostics.js";
import type { ShaderGraphDocument } from "./graph-document.js";
import { errorAt, warnAt } from "./parse-helpers.js";
import { getNodeDefinition } from "./node-definitions.js";
import type { NodeDefinition, NodePortDefinition } from "./node-definitions.js";
import { isImplicitlyConvertible } from "./graph-types.js";

export interface ProfileKnowledge {
    readonly profileId: string;
    readonly profileVersion: number;
    /** The node type that delivers the profile's required outputs. */
    readonly outputNodeType: string;
}

/** The profiles this core's node definitions implement (architecture §12). */
export const SUPPORTED_PROFILES: readonly ProfileKnowledge[] = [
    { profileId: "gglab.surface", profileVersion: 1, outputNodeType: "SurfaceOutput" },
];

export interface ValidationReport {
    readonly ok: boolean;
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
}

function describeTypes(types: readonly string[]): string {
    return "[ " + types.join(", ") + " ]";
}

export function validateShaderGraph(document: ShaderGraphDocument): ValidationReport {
    const diagnostics: ShaderGraphDiagnostic[] = [];
    const nodes = document.nodes;
    const connections = document.connections;

    const nodeIndexById = new Map<string, number>();
    nodes.forEach((node, index) => {
        nodeIndexById.set(node.id, index);
    });
    const nodeIdByIndex = nodes.map((node) => node.id);
    const definitionByNode: (NodeDefinition | undefined)[] = nodes.map((node) => getNodeDefinition(node.type));

    // Node type and version against the core's built-in definitions.
    nodes.forEach((node, index) => {
        const definition = definitionByNode[index];
        if (definition === undefined) {
            diagnostics.push(
                warnAt(
                    `$.nodes[${index}].type`,
                    DiagnosticCode.UnknownNodeType,
                    `Node "${node.id}" has type "${node.type}", which is not defined by this core; the node is preserved.`,
                ),
            );
            return;
        }
        if (node.version < definition.versionRange.minimumVersion || node.version > definition.versionRange.maximumVersion) {
            diagnostics.push(
                warnAt(
                    `$.nodes[${index}].version`,
                    DiagnosticCode.UnknownNodeVersion,
                    `Node "${node.id}" has version ${node.version}, outside the supported range ${definition.versionRange.minimumVersion}..${definition.versionRange.maximumVersion}.`,
                ),
            );
        }
    });

    // Input port cardinality and required inputs, per node.
    nodes.forEach((node, nodeIndex) => {
        const definition = definitionByNode[nodeIndex];
        if (definition === undefined) {
            return;
        }
        for (const port of definition.inputs) {
            const incoming: number[] = [];
            connections.forEach((connection, connectionIndex) => {
                if (connection.to.nodeId === node.id && connection.to.portId === port.id) {
                    incoming.push(connectionIndex);
                }
            });
            if (incoming.length === 0) {
                if (port.required) {
                    diagnostics.push(
                        errorAt(
                            `$.nodes[${nodeIndex}]`,
                            DiagnosticCode.MissingRequiredInput,
                            `Node "${node.id}" (${node.type}) has required input "${port.id}" without an incoming connection.`,
                        ),
                    );
                }
                continue;
            }
            for (let i = 1; i < incoming.length; i++) {
                const connectionIndex = incoming[i];
                if (connectionIndex === undefined) {
                    continue;
                }
                diagnostics.push(
                    errorAt(
                        `$.connections[${connectionIndex}]`,
                        DiagnosticCode.DuplicateConnection,
                        `Input "${node.id}.${port.id}" receives more than one incoming connection; each input port accepts exactly one.`,
                    ),
                );
            }
        }
    });

    // Reference properties must name a document entry (graph parameter).
    const parameterIds = new Set(document.parameters.map((parameter) => parameter.id));
    nodes.forEach((node, nodeIndex) => {
        const definition = definitionByNode[nodeIndex];
        if (definition === undefined) {
            return;
        }
        for (const reference of definition.referenceProperties) {
            const value = node.properties[reference.name];
            if (typeof value !== "string" || value.length === 0) {
                if (reference.required) {
                    diagnostics.push(
                        errorAt(
                            `$.nodes[${nodeIndex}]`,
                            DiagnosticCode.UnresolvedParameterReference,
                            `Node "${node.id}" (${node.type}) has no valid "${reference.name}" reference to a graph parameter.`,
                        ),
                    );
                }
                continue;
            }
            if (!parameterIds.has(value)) {
                diagnostics.push(
                    errorAt(
                        `$.nodes[${nodeIndex}]`,
                        DiagnosticCode.UnresolvedParameterReference,
                        `Node "${node.id}" (${node.type}) references unknown graph parameter "${value}".`,
                    ),
                );
                continue;
            }
            if (reference.target === "parameter") {
                // v1 invariant: a parameter-declaring node's type name is
                // the parameter class it declares; a mismatch means the
                // node and the document entry cannot both be correct.
                const parameter = document.parameters.find((entry) => entry.id === value);
                if (parameter !== undefined && parameter.class !== node.type) {
                    diagnostics.push(
                        errorAt(
                            `$.nodes[${nodeIndex}]`,
                            DiagnosticCode.ParameterClassMismatch,
                            `Node "${node.id}" (${node.type}) references graph parameter "${value}", which is declared with class "${parameter.class}".`,
                        ),
                    );
                }
            }
        }
    });

    // Connection endpoints (port existence, side) and endpoint type pairing.
    connections.forEach((connection, connectionIndex) => {
        const fromIndex = nodeIndexById.get(connection.from.nodeId);
        const toIndex = nodeIndexById.get(connection.to.nodeId);
        if (fromIndex === undefined || toIndex === undefined) {
            return; // unresolved node references: parse layer
        }
        const fromDefinition = definitionByNode[fromIndex];
        const toDefinition = definitionByNode[toIndex];
        if (fromDefinition === undefined || toDefinition === undefined) {
            return; // unknown node types: already warned above
        }

        const sourcePort: NodePortDefinition | undefined = fromDefinition.outputs.find((port) => port.id === connection.from.portId);
        if (sourcePort === undefined) {
            const wrongSide = fromDefinition.inputs.some((port) => port.id === connection.from.portId);
            diagnostics.push(
                wrongSide
                    ? errorAt(
                          `$.connections[${connectionIndex}].from`,
                          DiagnosticCode.InvalidConnection,
                          `Connection "${connection.id}" starts at input port "${connection.from.portId}" of node "${connection.from.nodeId}"; a connection must start at an output port.`,
                      )
                    : errorAt(
                          `$.connections[${connectionIndex}].from`,
                          DiagnosticCode.UnknownPort,
                          `Connection "${connection.id}" references unknown output port "${connection.from.portId}" of node "${connection.from.nodeId}".`,
                      ),
            );
        }

        const targetPort: NodePortDefinition | undefined = toDefinition.inputs.find((port) => port.id === connection.to.portId);
        if (targetPort === undefined && sourcePort !== undefined) {
            const wrongSide = toDefinition.outputs.some((port) => port.id === connection.to.portId);
            diagnostics.push(
                wrongSide
                    ? errorAt(
                          `$.connections[${connectionIndex}].to`,
                          DiagnosticCode.InvalidConnection,
                          `Connection "${connection.id}" ends at output port "${connection.to.portId}" of node "${connection.to.nodeId}"; a connection must end at an input port.`,
                      )
                    : errorAt(
                          `$.connections[${connectionIndex}].to`,
                          DiagnosticCode.UnknownPort,
                          `Connection "${connection.id}" references unknown input port "${connection.to.portId}" of node "${connection.to.nodeId}".`,
                      ),
            );
        }

        if (sourcePort !== undefined && targetPort !== undefined) {
            const compatible = sourcePort.types.some((sourceType) =>
                targetPort.types.some((targetType) => isImplicitlyConvertible(sourceType, targetType)),
            );
            if (!compatible) {
                diagnostics.push(
                    errorAt(
                        `$.connections[${connectionIndex}]`,
                        DiagnosticCode.TypeMismatch,
                        `Connection "${connection.id}" is incompatible: source types ${describeTypes(sourcePort.types)} cannot flow into target types ${describeTypes(targetPort.types)} (implicit conversion is identity-only).`,
                    ),
                );
            }
        }
    });

    // Node-level cycle detection: the validated graph must be a DAG.
    const adjacency: number[][] = nodes.map(() => []);
    connections.forEach((connection) => {
        const fromIndex = nodeIndexById.get(connection.from.nodeId);
        const toIndex = nodeIndexById.get(connection.to.nodeId);
        if (fromIndex === undefined || toIndex === undefined) {
            return;
        }
        const edge = adjacency[fromIndex];
        if (edge !== undefined) {
            edge.push(toIndex);
        }
    });

    const state: ("unvisited" | "visiting" | "done")[] = nodes.map(() => "unvisited");
    const stack: number[] = [];
    const visit = (index: number): void => {
        const ownState = state[index];
        if (ownState === undefined || ownState !== "unvisited") {
            return;
        }
        state[index] = "visiting";
        stack.push(index);
        const edges = adjacency[index];
        if (edges !== undefined) {
            for (const next of edges) {
                const nextState = state[next];
                if (nextState === "visiting") {
                    const cycleStart = stack.indexOf(next);
                    const cycle = cycleStart === -1 ? [next] : stack.slice(cycleStart);
                    const anchor = cycle[0];
                    const cycleIds = cycle.map((member) => nodeIdAt(nodeIdByIndex, member));
                    const headId = nodeIdAt(nodeIdByIndex, next);
                    diagnostics.push(
                        errorAt(
                            anchor === undefined ? "$" : `$.nodes[${anchor}]`,
                            DiagnosticCode.CycleDetected,
                            `Cycle detected: ${[...cycleIds, headId].join(" -> ")}; the graph must be acyclic.`,
                        ),
                    );
                    continue;
                }
                if (nextState === "unvisited") {
                    visit(next);
                }
            }
        }
        stack.pop();
        state[index] = "done";
    };
    for (let i = 0; i < nodes.length; i++) {
        visit(i);
    }

    // Profile identity and required output presence.
    const profile = SUPPORTED_PROFILES.find((candidate) => candidate.profileId === document.profile && candidate.profileVersion === document.profileVersion);
    if (profile === undefined) {
        diagnostics.push(
            errorAt(
                "$",
                DiagnosticCode.UnknownProfileFeature,
                `The document requests profile "${document.profile}" version ${document.profileVersion}; this core implements ${SUPPORTED_PROFILES.map((candidate) => `"${candidate.profileId}" version ${candidate.profileVersion}`).join(" or ")} only.`,
            ),
        );
    } else if (!nodes.some((node) => node.type === profile.outputNodeType)) {
        diagnostics.push(
            errorAt(
                "$",
                DiagnosticCode.MissingOutput,
                `The document declares profile "${profile.profileId}" but contains no "${profile.outputNodeType}" node to deliver its required outputs.`,
            ),
        );
    }

    const ok = !diagnostics.some((diagnostic) => diagnostic.severity === "error");
    return { ok, diagnostics };
}

function nodeIdAt(ids: readonly string[], index: number): string {
    const id = ids[index];
    return id === undefined ? `#${index}` : id;
}
