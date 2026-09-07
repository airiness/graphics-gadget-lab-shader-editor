/** Atomic graph edits. Incomplete graphs remain authorable: edits enforce
 * operation preconditions; validation, conformance and emission keep their
 * existing jobs. No history, UI placement, filesystem or native compilation. */
import { DiagnosticCode as Code, type ShaderGraphDiagnostic } from "./diagnostics.js";
import { isStableGraphId, removeConnection, removeConnectionsAtPort, reconnectConnection, serializeShaderGraphDocument, type ShaderGraphDocument } from "./graph-document.js";
import { createNode, getNodeDefinition } from "./node-definitions.js";
import { checkProfileDescriptorCompatibility } from "./profile-descriptor-compatibility.js";
import { checkProfileConformance } from "./profile-conformance.js";
import type { SurfaceProfileDescriptor } from "./surface-profile-descriptor.js";
import { readGraphEditCommand, type GraphEditCommand } from "./graph-edit-commands.js";

export interface GraphEditResult {
    readonly status: "changed" | "unchanged" | "refused";
    readonly document: ShaderGraphDocument;
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    readonly createdId: string | undefined;
}
export interface GraphEditContext { readonly descriptor?: SurfaceProfileDescriptor }

function accepted(before: ShaderGraphDocument, document: ShaderGraphDocument, createdId?: string): GraphEditResult {
    return { status: before === document ? "unchanged" : "changed", document, diagnostics: [], createdId };
}
function refused(document: ShaderGraphDocument, code: string, dataPath: string, message: string): GraphEditResult {
    return { status: "refused", document, diagnostics: [{ code, severity: "error", dataPath, message }], createdId: undefined };
}
function fromService(document: ShaderGraphDocument, result: { readonly ok: boolean; readonly document: ShaderGraphDocument | null; readonly diagnostics: readonly ShaderGraphDiagnostic[] }): GraphEditResult {
    return result.ok && result.document !== null ? { ...accepted(document, result.document), diagnostics: result.diagnostics } : { status: "refused", document, diagnostics: result.diagnostics, createdId: undefined };
}
function nextId(prefix: string, entries: readonly { readonly id: string }[]): string {
    const taken = new Set(entries.map((entry) => entry.id));
    let index = 1;
    while (taken.has(`${prefix}${index}`)) index++;
    return `${prefix}${index}`;
}
function idRefusal(document: ShaderGraphDocument, id: string, entries: readonly { readonly id: string }[], path: string, duplicateCode: string): GraphEditResult | null {
    if (!isStableGraphId(id)) return refused(document, Code.InvalidStableId, path, `"${id}" is not a stable graph identity.`);
    return entries.some((entry) => entry.id === id) ? refused(document, duplicateCode, path, `Identity "${id}" already exists.`) : null;
}

export function applyGraphEdit(document: ShaderGraphDocument, command: GraphEditCommand, context: GraphEditContext = {}): GraphEditResult {
    // Typed callers and serialized callers enter the same strict command boundary.
    const parsed = readGraphEditCommand(command);
    if (!parsed.ok) return { status: "refused", document, diagnostics: parsed.diagnostics, createdId: undefined };
    switch (command.kind) {
        case "add-node": {
            const creation = createNode(command.nodeType);
            const definition = getNodeDefinition(command.nodeType);
            if (!creation.ok || definition === undefined) return { status: "refused", document, diagnostics: creation.diagnostics, createdId: undefined };
            const parameterReference = definition.referenceProperties.some((property) => property.name === "parameterId");
            if (parameterReference && !document.parameters.some((parameter) => parameter.id === command.parameterId)) {
                return refused(document, Code.UnresolvedParameterReference, "$.parameters", "The node requires an existing parameter identity.");
            }
            if (!parameterReference && command.parameterId !== undefined) return refused(document, Code.InvalidNodeProperty, "$.nodes", "This node does not accept a parameter reference.");
            const id = command.nodeId ?? nextId("n", document.nodes);
            const invalid = idRefusal(document, id, document.nodes, "$.nodes", Code.DuplicateNodeId);
            if (invalid !== null) return invalid;
            return accepted(document, { ...document, nodes: [...document.nodes, {
                id, type: command.nodeType, version: creation.nodeVersion,
                properties: { ...creation.properties, ...(parameterReference ? { parameterId: command.parameterId! } : {}) }, unknownFields: {},
            }] }, id);
        }
        case "remove-node": {
            if (!document.nodes.some((node) => node.id === command.nodeId)) return refused(document, Code.UnresolvedNodeReference, "$.nodes", `No node with id "${command.nodeId}".`);
            // Removal also prunes retained metadata for that identity. Placement
            // creation remains frontend-owned, but deletion must be whole.
            return accepted(document, { ...document,
                nodes: document.nodes.filter((node) => node.id !== command.nodeId),
                connections: document.connections.filter((connection) => connection.from.nodeId !== command.nodeId && connection.to.nodeId !== command.nodeId),
                ...(Object.hasOwn(document.editorMetadata.nodes, command.nodeId) ? { editorMetadata: { ...document.editorMetadata, nodes: Object.fromEntries(Object.entries(document.editorMetadata.nodes).filter(([id]) => id !== command.nodeId)) } } : {}),
            });
        }
        case "set-constant-value": {
            const index = document.nodes.findIndex((node) => node.id === command.nodeId);
            const node = document.nodes[index];
            if (node === undefined) return refused(document, Code.UnresolvedNodeReference, "$.nodes", `No node with id "${command.nodeId}".`);
            const definition = getNodeDefinition(node.type);
            const path = `$.nodes[${index}].properties.value`;
            if (definition === undefined) return refused(document, Code.UnknownNodeType, `$.nodes[${index}].type`, "Unknown nodes cannot be edited as constants.");
            if (node.version < definition.versionRange.minimumVersion || node.version > definition.versionRange.maximumVersion) return refused(document, Code.UnknownNodeVersion, `$.nodes[${index}].version`, "Unsupported node versions cannot be reinterpreted for editing.");
            const property = definition.category === "constant" ? definition.properties.find((candidate) => candidate.name === "value") : undefined;
            const dimensions: Readonly<Record<string, number>> = { float: 1, float2: 2, float3: 3, float4: 4 };
            const count = property === undefined ? undefined : dimensions[property.type];
            if (count === undefined) return refused(document, Code.InvalidNodeProperty, path, "Only catalog constant nodes own editable document values.");
            const value = command.value;
            if (!(count === 1 ? typeof value === "number" && Number.isFinite(value) : Array.isArray(value) && value.length === count && value.every((component) => typeof component === "number" && Number.isFinite(component)))) return refused(document, Code.InvalidNodeProperty, path, `The constant requires exactly ${count} finite numeric component(s).`);
            const old = node.properties["value"];
            if (Object.is(old, value) || (Array.isArray(old) && Array.isArray(value) && old.length === value.length && old.every((component, i) => Object.is(component, value[i])))) return accepted(document, document);
            return accepted(document, { ...document, nodes: document.nodes.map((candidate) => candidate !== node ? candidate : { ...node, properties: { ...node.properties, value: typeof value === "number" ? value : [...value] } }) });
        }
        case "add-parameter": {
            // The existing ordinary parameter families use the class as their
            // node type. The catalog must actually declare a parameter reference.
            const definition = getNodeDefinition(command.class);
            const creation = createNode(command.class);
            if (!creation.ok || !definition?.referenceProperties.some((property) => property.name === "parameterId")) return refused(document, Code.UnsupportedParameterClass, "$.parameters", `Parameter class "${command.class}" has no catalog parameter node.`);
            const parameterId = command.parameterId ?? nextId("p", document.parameters);
            const nodeId = command.nodeId ?? nextId("n", document.nodes);
            const invalid = idRefusal(document, parameterId, document.parameters, "$.parameters", Code.DuplicateParameterId) ?? idRefusal(document, nodeId, document.nodes, "$.nodes", Code.DuplicateNodeId);
            if (invalid !== null) return invalid;
            return accepted(document, { ...document,
                parameters: [...document.parameters, { id: parameterId, name: command.name, class: command.class, valueType: command.valueType, unknownFields: {} }],
                nodes: [...document.nodes, { id: nodeId, type: command.class, version: creation.nodeVersion, properties: { ...creation.properties, parameterId }, unknownFields: {} }],
            }, nodeId);
        }
        case "rename-parameter": {
            const index = document.parameters.findIndex((parameter) => parameter.id === command.parameterId);
            const parameter = document.parameters[index];
            if (parameter === undefined) return refused(document, Code.UnresolvedParameterReference, "$.parameters", `No parameter with id "${command.parameterId}".`);
            return accepted(document, parameter.name === command.name ? document : { ...document, parameters: document.parameters.map((entry) => entry === parameter ? { ...entry, name: command.name } : entry) });
        }
        case "add-connection": {
            if (![command.from, command.to].every((end) => document.nodes.some((node) => node.id === end.nodeId))) return refused(document, Code.UnresolvedNodeReference, "$.connections", "A connection end names a node that is not present in the document.");
            const id = command.connectionId ?? nextId("c", document.connections);
            const invalid = idRefusal(document, id, document.connections, "$.connections", Code.DuplicateConnectionId);
            if (invalid !== null) return invalid;
            return accepted(document, { ...document, connections: [...document.connections, { id, from: { ...command.from, unknownFields: {} }, to: { ...command.to, unknownFields: {} }, unknownFields: {} }] }, id);
        }
        case "remove-connection": return fromService(document, removeConnection(document, command.connectionId));
        case "disconnect-port": return fromService(document, removeConnectionsAtPort(document, command));
        case "reconnect-connection": return fromService(document, reconnectConnection(document, command.connectionId, command));
        case "set-profile": {
            const descriptor = context.descriptor;
            if (descriptor === undefined || descriptor.profileId !== command.profile || descriptor.profileVersion !== command.profileVersion) return refused(document, Code.ProfileMismatch, "$.profile", "Explicit profile selection requires a matching descriptor.");
            const next = { ...document, profile: command.profile, profileVersion: command.profileVersion };
            const diagnostics = [...checkProfileDescriptorCompatibility(next, descriptor).diagnostics, ...checkProfileConformance(next, descriptor).diagnostics];
            if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { status: "refused", document, diagnostics, createdId: undefined };
            return { ...accepted(document, document.profile === next.profile && document.profileVersion === next.profileVersion ? document : next), diagnostics };
        }
    }
}

export interface GraphEditBatchResult extends Omit<GraphEditResult, "createdId"> {
    readonly createdIds: readonly (string | null)[];
    readonly failedCommandIndex: number | null;
}

/** A refused command rolls back the entire batch, including metadata and IDs.
 * Intermediate incomplete graphs are allowed, just as in interactive editing. */
export function applyGraphEdits(document: ShaderGraphDocument, commands: readonly GraphEditCommand[], context: GraphEditContext = {}): GraphEditBatchResult {
    let current = document;
    const createdIds: (string | null)[] = [];
    const diagnostics: ShaderGraphDiagnostic[] = [];
    for (const [index, command] of commands.entries()) {
        const result = applyGraphEdit(current, command, context);
        if (result.status === "refused") return { status: "refused", document, diagnostics: [...result.diagnostics, { code: Code.EditTransactionRefused, severity: "error", dataPath: `$.commands[${index}]`, message: "This command refused the transaction; no edits were applied." }], createdIds: [], failedCommandIndex: index };
        current = result.document;
        createdIds.push(result.createdId ?? null);
        diagnostics.push(...result.diagnostics);
    }
    if (current !== document && serializeShaderGraphDocument(current) === serializeShaderGraphDocument(document)) current = document;
    return { status: current === document ? "unchanged" : "changed", document: current, diagnostics, createdIds, failedCommandIndex: null };
}
