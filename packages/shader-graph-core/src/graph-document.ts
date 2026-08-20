/**
 * ShaderGraphDocument — the persisted graph model.
 *
 * The document is pure data: JSON-serializable, no live object graph, no
 * instance identity. That is the precondition the CLI frontend's JSON
 * transport and transactional editing rely on — the GUI and the CLI serialize
 * the same document through this same model, and all semantics stay in this
 * core.
 *
 * Load behavior:
 * - `schemaVersion` outside the supported range is rejected before anything
 *   else is interpreted.
 * - Structural violations (missing required fields, wrong types, unstable or
 *   duplicated ids, unresolved node references) are errors; the result is
 *   not-ok.
 * - Unknown but retained data degrades explicitly: unknown fields are kept
 *   for lossless round-trip, and nodes whose type or version is unknown to
 *   the caller-supplied catalog warn while remaining fully preserved.
 */
import type { ParseResult, ShaderGraphDiagnostic } from "./diagnostics.js";
import { DiagnosticCode } from "./diagnostics.js";
import { hasField, isJsonNumber, isJsonRecord, isJsonString, jsonKind } from "./json-value.js";
import type { JsonRecord, JsonValue } from "./json-value.js";
import { errorAt, requireInteger, requireString, takeArray, takeField, takeObject, warnAt } from "./parse-helpers.js";

export interface SchemaVersionRange {
    readonly minimum: number;
    readonly maximum: number;
}

/** The range of `schemaVersion` values this reader supports. */
export const SUPPORTED_SCHEMA_VERSION_RANGE: SchemaVersionRange = {
    minimum: 1,
    maximum: 1,
};

export interface NodeTypeSupport {
    readonly minimumVersion: number;
    readonly maximumVersion: number;
}

/**
 * Node type catalog keyed by node type name. It is caller-supplied; the core
 * supplies it from its own node definition module when one exists. An empty
 * (or absent) catalog means every node type is explicitly unknown: nodes are
 * preserved and flagged with warnings, never silently substituted.
 */
export type NodeTypeCatalog = Readonly<Record<string, NodeTypeSupport>>;

export interface ParseDocumentOptions {
    readonly nodeTypeCatalog?: NodeTypeCatalog;
    readonly supportedSchemaVersionRange?: SchemaVersionRange;
}

export interface ShaderGraphDocument {
    readonly schemaVersion: number;
    readonly graphId: string;
    /** The profile the graph requests (for example "gglab.surface"). */
    readonly profile: string;
    readonly profileVersion: number;
    readonly parameters: readonly GraphParameter[];
    readonly nodes: readonly GraphNode[];
    readonly connections: readonly GraphConnection[];
    readonly editorMetadata: GraphEditorMetadata;
    /** Retained top-level fields this reader does not understand. */
    readonly unknownFields: Readonly<Record<string, JsonValue>>;
}

export interface GraphParameter {
    readonly id: string;
    /** Human-facing display label. Separate from the stable id; renaming it changes no semantics. */
    readonly name: string;
    /** Parameter class name from the surface profile descriptor (for example "ScalarParameter"). */
    readonly class: string;
    readonly unknownFields: Readonly<Record<string, JsonValue>>;
}

export interface GraphNode {
    readonly id: string;
    readonly type: string;
    readonly version: number;
    /** Human-facing display label; renaming it alone changes no semantics and no generated symbols. */
    readonly label?: string;
    /** Semantic properties as JSON values (for example constant values). */
    readonly properties: Readonly<Record<string, JsonValue>>;
    readonly unknownFields: Readonly<Record<string, JsonValue>>;
}

export interface GraphConnection {
    readonly id: string;
    readonly from: ConnectionEnd;
    readonly to: ConnectionEnd;
    readonly unknownFields: Readonly<Record<string, JsonValue>>;
}

export interface ConnectionEnd {
    readonly nodeId: string;
    readonly portId: string;
    readonly unknownFields: Readonly<Record<string, JsonValue>>;
}

export interface NodeEditorState {
    readonly position?: { readonly x: number; readonly y: number };
    /** Presentation-side forward-compatible fields, retained silently: metadata never affects semantics. */
    readonly unknownFields: Readonly<Record<string, JsonValue>>;
}

export interface GraphEditorMetadata {
    /** Presentation state keyed by node id; never affects generated HLSL. */
    readonly nodes: Readonly<Record<string, NodeEditorState>>;
    readonly unknownFields: Readonly<Record<string, JsonValue>>;
}

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * A stable graph-local id: non-empty ASCII, no whitespace or path characters,
 * 1..128 characters. Ids must never be pointer-derived or UI-index-derived.
 */
export function isStableGraphId(value: string): boolean {
    return STABLE_ID_PATTERN.test(value);
}

const TOP_LEVEL_FIELDS: readonly string[] = [
    "schemaVersion",
    "graphId",
    "profile",
    "profileVersion",
    "parameters",
    "nodes",
    "connections",
    "editorMetadata",
];

/**
 * Parses a `.shadergraph` document from JSON text supplied by the caller.
 * The core does no file IO: loading the document bytes is the caller's job.
 */
export function parseShaderGraphDocument(rawJson: string, options: ParseDocumentOptions = {}): ParseResult<ShaderGraphDocument> {
    let root: unknown;
    try {
        root = JSON.parse(rawJson);
    } catch {
        return { ok: false, value: null, diagnostics: [errorAt("$", DiagnosticCode.InvalidJson, "Input is not valid JSON.")] };
    }

    if (!isJsonRecord(root)) {
        return { ok: false, value: null, diagnostics: [errorAt("$", DiagnosticCode.UnexpectedType, `The document root must be a JSON object, got ${jsonKind(root)}.`)] };
    }

    if (takeField(root, "schemaVersion") === undefined) {
        return { ok: false, value: null, diagnostics: [errorAt("$.schemaVersion", DiagnosticCode.MissingRequiredField, `Required field "schemaVersion" is missing.`)] };
    }
    const schemaVersionValue = root["schemaVersion"] as JsonValue;
    if (typeof schemaVersionValue !== "number" || !Number.isInteger(schemaVersionValue)) {
        return { ok: false, value: null, diagnostics: [errorAt("$.schemaVersion", DiagnosticCode.UnexpectedType, `Expected an integer schema version, got ${jsonKind(schemaVersionValue)}.`)] };
    }
    const schemaVersion = schemaVersionValue;
    const versionRange = options.supportedSchemaVersionRange ?? SUPPORTED_SCHEMA_VERSION_RANGE;
    if (schemaVersion < versionRange.minimum || schemaVersion > versionRange.maximum) {
        return {
            ok: false,
            value: null,
            diagnostics: [
                errorAt(
                    "$.schemaVersion",
                    DiagnosticCode.UnsupportedSchemaVersion,
                    `Schema version ${schemaVersion} is outside the supported range ${versionRange.minimum}..${versionRange.maximum}; this reader must not reinterpret documents it does not support.`,
                ),
            ],
        };
    }

    const diagnostics: ShaderGraphDiagnostic[] = [];
    const unknownFields: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(root)) {
        if (TOP_LEVEL_FIELDS.includes(key)) {
            continue;
        }
        unknownFields[key] = root[key] as JsonValue;
        diagnostics.push(warnAt(`$.${key}`, DiagnosticCode.UnexpectedField, `Field "${key}" is not part of the supported document shape; it is retained for lossless round-trip.`));
    }

    const graphId = requireString(root, "graphId", "$", diagnostics);
    if (graphId !== undefined && !isStableGraphId(graphId)) {
        diagnostics.push(errorAt("$.graphId", DiagnosticCode.InvalidStableId, `"${graphId}" is not a stable id: ids must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}.`));
    }
    const profile = requireString(root, "profile", "$", diagnostics);
    const profileVersion = requireInteger(root, "profileVersion", "$", diagnostics);

    const parameters = parseParameters(takeArray(root, "parameters", "$", diagnostics), diagnostics);
    const nodes = parseNodes(takeArray(root, "nodes", "$", diagnostics), diagnostics);
    const connections = parseConnections(takeArray(root, "connections", "$", diagnostics), diagnostics);
    const editorMetadata = parseEditorMetadata(takeObject(root, "editorMetadata", "$", diagnostics), diagnostics);

    checkUniqueIds(parameters, nodes, connections, diagnostics);
    checkNodeReferences(connections, nodes, diagnostics);
    checkNodeTypeCatalog(nodes, options.nodeTypeCatalog ?? {}, diagnostics);
    checkEditorMetadataReferences(editorMetadata, nodes, diagnostics);

    const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
    if (graphId === undefined || profile === undefined || profileVersion === undefined || hasErrors) {
        return { ok: false, value: null, diagnostics };
    }

    return {
        ok: true,
        value: {
            schemaVersion,
            graphId,
            profile,
            profileVersion,
            parameters,
            nodes,
            connections,
            editorMetadata,
            unknownFields,
        },
        diagnostics,
    };
}

function checkUniqueIds(
    parameters: readonly GraphParameter[],
    nodes: readonly GraphNode[],
    connections: readonly GraphConnection[],
    diagnostics: ShaderGraphDiagnostic[],
): void {
    const seenParameters = new Set<string>();
    parameters.forEach((parameter, index) => {
        if (seenParameters.has(parameter.id)) {
            diagnostics.push(errorAt(`$.parameters[${index}].id`, DiagnosticCode.DuplicateParameterId, `Parameter id "${parameter.id}" is duplicated; ids must be unique within a document.`));
        }
        seenParameters.add(parameter.id);
    });
    const seenNodes = new Set<string>();
    nodes.forEach((node, index) => {
        if (seenNodes.has(node.id)) {
            diagnostics.push(errorAt(`$.nodes[${index}].id`, DiagnosticCode.DuplicateNodeId, `Node id "${node.id}" is duplicated; ids must be unique within a document.`));
        }
        seenNodes.add(node.id);
    });
    const seenConnections = new Set<string>();
    connections.forEach((connection, index) => {
        if (seenConnections.has(connection.id)) {
            diagnostics.push(errorAt(`$.connections[${index}].id`, DiagnosticCode.DuplicateConnectionId, `Connection id "${connection.id}" is duplicated; ids must be unique within a document.`));
        }
        seenConnections.add(connection.id);
    });
}

function checkNodeReferences(connections: readonly GraphConnection[], nodes: readonly GraphNode[], diagnostics: ShaderGraphDiagnostic[]): void {
    const nodeIds = new Set(nodes.map((node) => node.id));
    connections.forEach((connection, index) => {
        for (const end of ["from", "to"] as const) {
            const nodeId = connection[end].nodeId;
            if (!nodeIds.has(nodeId)) {
                diagnostics.push(errorAt(`$.connections[${index}].${end}.nodeId`, DiagnosticCode.UnresolvedNodeReference, `Connection "${connection.id}" references unknown node "${nodeId}".`));
            }
        }
    });
}

function checkNodeTypeCatalog(nodes: readonly GraphNode[], catalog: NodeTypeCatalog, diagnostics: ShaderGraphDiagnostic[]): void {
    nodes.forEach((node, index) => {
        const support: NodeTypeSupport | undefined = catalog[node.type];
        if (support === undefined) {
            diagnostics.push(
                warnAt(`$.nodes[${index}].type`, DiagnosticCode.UnknownNodeType, `Node type "${node.type}" is not in the supported node type catalog; the node is preserved and must not be lowered by this consumer.`),
            );
        } else if (node.version < support.minimumVersion || node.version > support.maximumVersion) {
            diagnostics.push(
                warnAt(`$.nodes[${index}].version`, DiagnosticCode.UnknownNodeVersion, `Node "${node.id}" has version ${node.version}, outside the supported range ${support.minimumVersion}..${support.maximumVersion}; the node is preserved.`),
            );
        }
    });
}

function checkEditorMetadataReferences(editorMetadata: GraphEditorMetadata, nodes: readonly GraphNode[], diagnostics: ShaderGraphDiagnostic[]): void {
    const nodeIds = new Set(nodes.map((node) => node.id));
    for (const nodeId of Object.keys(editorMetadata.nodes)) {
        if (!nodeIds.has(nodeId)) {
            diagnostics.push(warnAt(`$.editorMetadata.nodes.${nodeId}`, DiagnosticCode.UnresolvedNodeReference, `Editor metadata references unknown node "${nodeId}".`));
        }
    }
}

function parseParameters(raw: readonly JsonValue[] | undefined, diagnostics: ShaderGraphDiagnostic[]): GraphParameter[] {
    const result: GraphParameter[] = [];
    if (raw === undefined) {
        return result;
    }
    raw.forEach((item, index) => {
        const path = `$.parameters[${index}]`;
        if (!isJsonRecord(item)) {
            diagnostics.push(errorAt(path, DiagnosticCode.UnexpectedType, `Expected a JSON object, got ${jsonKind(item)}.`));
            return;
        }
        const id = requireString(item, "id", path, diagnostics);
        const name = requireString(item, "name", path, diagnostics);
        const cls = requireString(item, "class", path, diagnostics);
        assertStableId(id, `${path}.id`, diagnostics);
        const unknown: { [key: string]: JsonValue } = {};
        collectUnknownFields(item, ["id", "name", "class"], path, diagnostics, unknown);
        if (id === undefined || name === undefined || cls === undefined) {
            return;
        }
        result.push({ id, name, class: cls, unknownFields: unknown });
    });
    return result;
}

function parseNodes(raw: readonly JsonValue[] | undefined, diagnostics: ShaderGraphDiagnostic[]): GraphNode[] {
    const result: GraphNode[] = [];
    if (raw === undefined) {
        return result;
    }
    raw.forEach((item, index) => {
        const path = `$.nodes[${index}]`;
        if (!isJsonRecord(item)) {
            diagnostics.push(errorAt(path, DiagnosticCode.UnexpectedType, `Expected a JSON object, got ${jsonKind(item)}.`));
            return;
        }
        const id = requireString(item, "id", path, diagnostics);
        const type = requireString(item, "type", path, diagnostics);
        const version = requireInteger(item, "version", path, diagnostics);
        assertStableId(id, `${path}.id`, diagnostics);

        let label: string | undefined;
        if (hasField(item, "label")) {
            const rawLabel = takeField(item, "label");
            if (isJsonString(rawLabel) && rawLabel.length > 0) {
                label = rawLabel;
            } else {
                diagnostics.push(errorAt(`${path}.label`, DiagnosticCode.UnexpectedType, `Expected "label" to be a non-empty string, got ${jsonKind(rawLabel)}.`));
            }
        }

        const propertiesRaw = takeObject(item, "properties", path, diagnostics);
        const unknown: { [key: string]: JsonValue } = {};
        collectUnknownFields(item, ["id", "type", "version", "label", "properties"], path, diagnostics, unknown);

        if (id === undefined || type === undefined || version === undefined || propertiesRaw === undefined) {
            return;
        }
        result.push({
            id,
            type,
            version,
            ...(label !== undefined ? { label } : {}),
            properties: propertiesRaw,
            unknownFields: unknown,
        });
    });
    return result;
}

function parseConnections(raw: readonly JsonValue[] | undefined, diagnostics: ShaderGraphDiagnostic[]): GraphConnection[] {
    const result: GraphConnection[] = [];
    if (raw === undefined) {
        return result;
    }
    raw.forEach((item, index) => {
        const path = `$.connections[${index}]`;
        if (!isJsonRecord(item)) {
            diagnostics.push(errorAt(path, DiagnosticCode.UnexpectedType, `Expected a JSON object, got ${jsonKind(item)}.`));
            return;
        }
        const id = requireString(item, "id", path, diagnostics);
        assertStableId(id, `${path}.id`, diagnostics);
        const from = parseConnectionEnd(takeObject(item, "from", path, diagnostics), `${path}.from`, diagnostics);
        const to = parseConnectionEnd(takeObject(item, "to", path, diagnostics), `${path}.to`, diagnostics);
        const unknown: { [key: string]: JsonValue } = {};
        collectUnknownFields(item, ["id", "from", "to"], path, diagnostics, unknown);
        if (id === undefined || from === undefined || to === undefined) {
            return;
        }
        result.push({ id, from, to, unknownFields: unknown });
    });
    return result;
}

function parseConnectionEnd(raw: JsonRecord | undefined, path: string, diagnostics: ShaderGraphDiagnostic[]): ConnectionEnd | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const nodeId = requireString(raw, "nodeId", path, diagnostics);
    const portId = requireString(raw, "portId", path, diagnostics);
    const unknown: { [key: string]: JsonValue } = {};
    collectUnknownFields(raw, ["nodeId", "portId"], path, diagnostics, unknown);
    if (nodeId === undefined || portId === undefined) {
        return undefined;
    }
    return { nodeId, portId, unknownFields: unknown };
}

function parseEditorMetadata(raw: JsonRecord | undefined, diagnostics: ShaderGraphDiagnostic[]): GraphEditorMetadata {
    const nodesMap: { [key: string]: NodeEditorState } = {};
    const unknown: { [key: string]: JsonValue } = {};
    if (raw === undefined) {
        return { nodes: nodesMap, unknownFields: unknown };
    }
    for (const key of Object.keys(raw)) {
        if (key !== "nodes") {
            // Presentation-side metadata: retained silently. It never affects
            // semantics, so no diagnostic is produced here.
            unknown[key] = raw[key] as JsonValue;
        }
    }
    if (!hasField(raw, "nodes")) {
        return { nodes: nodesMap, unknownFields: unknown };
    }
    const nodesRaw = takeField(raw, "nodes");
    if (!isJsonRecord(nodesRaw)) {
        diagnostics.push(errorAt("$.editorMetadata.nodes", DiagnosticCode.UnexpectedType, `Expected "nodes" to be a JSON object, got ${jsonKind(nodesRaw)}.`));
        return { nodes: nodesMap, unknownFields: unknown };
    }
    for (const nodeId of Object.keys(nodesRaw)) {
        const statePath = `$.editorMetadata.nodes.${nodeId}`;
        const stateRaw = nodesRaw[nodeId] as JsonValue;
        if (!isJsonRecord(stateRaw)) {
            diagnostics.push(errorAt(statePath, DiagnosticCode.UnexpectedType, `Expected node editor state to be a JSON object, got ${jsonKind(stateRaw)}.`));
            continue;
        }
        let position: { readonly x: number; readonly y: number } | undefined;
        if (hasField(stateRaw, "position")) {
            const positionRaw = takeField(stateRaw, "position");
            if (isJsonRecord(positionRaw)) {
                const x = positionRaw["x"];
                const y = positionRaw["y"];
                if (isJsonNumber(x) && isJsonNumber(y)) {
                    position = { x, y };
                }
            }
            if (position === undefined) {
                diagnostics.push(errorAt(`${statePath}.position`, DiagnosticCode.UnexpectedType, `Expected "position" to be an object with numeric "x" and "y", got ${jsonKind(positionRaw)}.`));
            }
        }
        const stateUnknown: { [key: string]: JsonValue } = {};
        for (const key of Object.keys(stateRaw)) {
            if (key !== "position") {
                stateUnknown[key] = stateRaw[key] as JsonValue;
            }
        }
        nodesMap[nodeId] = {
            unknownFields: stateUnknown,
            ...(position !== undefined ? { position } : {}),
        };
    }
    return { nodes: nodesMap, unknownFields: unknown };
}

function assertStableId(id: string | undefined, dataPath: string, diagnostics: ShaderGraphDiagnostic[]): void {
    if (id !== undefined && !isStableGraphId(id)) {
        diagnostics.push(errorAt(dataPath, DiagnosticCode.InvalidStableId, `"${id}" is not a stable id: ids must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}.`));
    }
}

function collectUnknownFields(record: JsonRecord, allowed: readonly string[], path: string, diagnostics: ShaderGraphDiagnostic[], target: { [key: string]: JsonValue }): void {
    for (const key of Object.keys(record)) {
        if (allowed.includes(key)) {
            continue;
        }
        target[key] = record[key] as JsonValue;
        diagnostics.push(warnAt(`${path}.${key}`, DiagnosticCode.UnexpectedField, `Field "${key}" is not part of the supported document shape; it is retained for lossless round-trip.`));
    }
}

function canonicalizeJsonValue(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        return value.map(canonicalizeJsonValue);
    }
    if (isJsonRecord(value)) {
        const out: { [key: string]: JsonValue } = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = canonicalizeJsonValue(value[key] as JsonValue);
        }
        return out;
    }
    return value;
}

function appendUnknownFields(target: { [key: string]: JsonValue }, unknownFields: Readonly<Record<string, JsonValue>>): void {
    for (const key of Object.keys(unknownFields).sort()) {
        const value = unknownFields[key];
        if (value !== undefined) {
            target[key] = canonicalizeJsonValue(value);
        }
    }
}

/**
 * Deterministic canonical serialization of a parsed document:
 * fixed field order, sorted retained-field keys, 2-space indent, trailing
 * newline. Serializing the same parsed document always yields the same
 * bytes, which is what makes CLI JSON output and round-trip checks
 * mechanically verifiable.
 */
export function serializeShaderGraphDocument(document: ShaderGraphDocument): string {
    const root: { [key: string]: JsonValue } = {};
    root["schemaVersion"] = document.schemaVersion;
    root["graphId"] = document.graphId;
    root["profile"] = document.profile;
    root["profileVersion"] = document.profileVersion;
    root["parameters"] = document.parameters.map((parameter) => {
        const record: { [key: string]: JsonValue } = {};
        record["id"] = parameter.id;
        record["name"] = parameter.name;
        record["class"] = parameter.class;
        appendUnknownFields(record, parameter.unknownFields);
        return record;
    });
    root["nodes"] = document.nodes.map((node) => {
        const record: { [key: string]: JsonValue } = {};
        record["id"] = node.id;
        record["type"] = node.type;
        record["version"] = node.version;
        if (node.label !== undefined) {
            record["label"] = node.label;
        }
        record["properties"] = canonicalizeJsonValue(node.properties);
        appendUnknownFields(record, node.unknownFields);
        return record;
    });
    root["connections"] = document.connections.map((connection) => {
        const record: { [key: string]: JsonValue } = {};
        record["id"] = connection.id;
        record["from"] = connectionEndValue(connection.from);
        record["to"] = connectionEndValue(connection.to);
        appendUnknownFields(record, connection.unknownFields);
        return record;
    });

    const editorNodes: { [key: string]: JsonValue } = {};
    for (const nodeId of Object.keys(document.editorMetadata.nodes).sort()) {
        const state = document.editorMetadata.nodes[nodeId];
        if (state === undefined) {
            continue;
        }
        const record: { [key: string]: JsonValue } = {};
        if (state.position !== undefined) {
            record["position"] = { x: state.position.x, y: state.position.y };
        }
        appendUnknownFields(record, state.unknownFields);
        editorNodes[nodeId] = record;
    }
    const editorMetadata: { [key: string]: JsonValue } = {};
    editorMetadata["nodes"] = editorNodes;
    appendUnknownFields(editorMetadata, document.editorMetadata.unknownFields);
    root["editorMetadata"] = editorMetadata;

    appendUnknownFields(root, document.unknownFields);

    return JSON.stringify(root, null, 2) + "\n";
}

function connectionEndValue(end: ConnectionEnd): JsonValue {
    const record: { [key: string]: JsonValue } = {};
    record["nodeId"] = end.nodeId;
    record["portId"] = end.portId;
    appendUnknownFields(record, end.unknownFields);
    return record;
}
