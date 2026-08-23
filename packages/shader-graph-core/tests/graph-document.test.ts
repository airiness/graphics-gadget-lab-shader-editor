import { describe, expect, it } from "vitest";
import {
    DiagnosticCode,
    parseShaderGraphDocument,
    removeConnection,
    removeConnectionsAtPort,
    reconnectConnection,
    serializeShaderGraphDocument,
    validateShaderGraph,
} from "../src/index.js";
import type { ParseResult, ShaderGraphDocument } from "../src/index.js";

function baseDocument(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        graphId: "graph.test-surface",
        profile: "gglab.surface",
        profileVersion: 1,
        parameters: [
            { id: "param.baseTint", name: "Base Tint", class: "VectorParameter", valueType: "float3" },
        ],
        nodes: [
            { id: "node.constant", type: "Float", version: 1, label: "Half", properties: { value: 0.5 } },
            { id: "node.output", type: "SurfaceOutput", version: 1, properties: {} },
        ],
        connections: [
            {
                id: "conn.01",
                from: { nodeId: "node.constant", portId: "value" },
                to: { nodeId: "node.output", portId: "BaseColor" },
            },
        ],
        editorMetadata: {
            nodes: { "node.constant": { position: { x: 120, y: 80 } } },
        },
    };
}

const baseJson = JSON.stringify(baseDocument());

function parseVariant(mutate: (document: Record<string, unknown>) => void): ParseResult<ShaderGraphDocument> {
    const document: Record<string, unknown> = JSON.parse(baseJson);
    mutate(document);
    return parseShaderGraphDocument(JSON.stringify(document));
}

function expectParsed(value: ShaderGraphDocument | null): ShaderGraphDocument {
    if (value === null) {
        throw new Error("expected a parsed document");
    }
    return value;
}

function expectElement<T>(elements: readonly T[], index: number): T {
    const element = elements[index];
    if (element === undefined) {
        throw new Error(`expected array element ${index}`);
    }
    return element;
}

describe("parseShaderGraphDocument", () => {
    it("loads a valid document against the core's built-in node catalog without warnings", () => {
        const result = parseShaderGraphDocument(baseJson);
        expect(result.ok).toBe(true);
        const document = expectParsed(result.value);
        expect(document.schemaVersion).toBe(1);
        expect(document.graphId).toBe("graph.test-surface");
        expect(document.profile).toBe("gglab.surface");
        expect(document.parameters).toHaveLength(1);
        expect(document.nodes).toHaveLength(2);
        expect(document.connections).toHaveLength(1);
        expect(document.editorMetadata.nodes["node.constant"]?.position).toEqual({ x: 120, y: 80 });
        // Default catalog: the core's own node definitions; both node types
        // are known, so parsing produces no diagnostics at all.
        expect(result.diagnostics).toEqual([]);
    });

    it("requires a concrete valueType on every parameter entry", () => {
        const result = parseVariant((document) => {
            const parameters = document["parameters"] as Record<string, unknown>[];
            delete expectElement(parameters, 0)["valueType"];
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: DiagnosticCode.MissingRequiredField,
                severity: "error",
                dataPath: "$.parameters[0].valueType",
            }),
        );
    });

    it("rejects a valueType outside the core value vocabulary", () => {
        // "float5" is simply not a graph type; "bool" is deferred and is not
        // part of the v1 value domain either — both are explicit errors.
        for (const invalid of ["float5", "bool"]) {
            const result = parseVariant((document) => {
                const parameters = document["parameters"] as Record<string, unknown>[];
                expectElement(parameters, 0)["valueType"] = invalid;
            });
            expect(result.ok).toBe(false);
            expect(result.diagnostics).toContainEqual(
                expect.objectContaining({
                    code: DiagnosticCode.InvalidParameterValueType,
                    severity: "error",
                    dataPath: "$.parameters[0].valueType",
                }),
            );
        }
    });

    it("removes exactly the named connection while preserving everything else", () => {
        const document = expectParsed(parseShaderGraphDocument(baseJson).value);
        const result = removeConnection(document, "conn.01");
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        const next = result.document;
        expect(next).not.toBeNull();
        expect(next?.connections).toEqual([]);
        // Structural preservation: everything outside the removed entry is
        // identical, and the input document is untouched (atomic).
        expect(next?.nodes).toEqual(document.nodes);
        expect(next?.parameters).toEqual(document.parameters);
        expect(next?.editorMetadata).toEqual(document.editorMetadata);
        expect(next?.graphId).toBe(document.graphId);
        expect(next?.profile).toBe(document.profile);
        expect(document.connections).toHaveLength(1);
    });

    it("fails with a structured CONNECTION_NOT_FOUND and returns no document for a stale id", () => {
        const document = expectParsed(parseShaderGraphDocument(baseJson).value);
        const result = removeConnection(document, "conn.does-not-exist");
        expect(result.ok).toBe(false);
        expect(result.document).toBeNull();
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toEqual(
            expect.objectContaining({
                code: DiagnosticCode.ConnectionNotFound,
                severity: "error",
                dataPath: "$.connections",
            }),
        );
        // No change, by construction: the caller keeps exactly the input.
        expect(document.connections).toHaveLength(1);
    });

    it("removes cleanly even when the removal leaves the graph invalid", () => {
        // Drop the only feed of the output's required BaseColor input. The
        // result is a graph with an unsatisfied required input — the graph's
        // OWN diagnosis afterwards. The core's removal must not depend on
        // that validity (a user repairing a bad graph can still disconnect).
        const document = expectParsed(parseShaderGraphDocument(baseJson).value);
        const result = removeConnection(document, "conn.01");
        expect(result.ok).toBe(true);
        if (result.document === null) {
            throw new Error("expected a removed document");
        }
        const next = result.document;
        expect(next.connections).toEqual([]);
        const validation = validateShaderGraph(next);
        expect(validation.diagnostics.some((diagnostic) => diagnostic.code === DiagnosticCode.MissingRequiredInput)).toBe(true);
    });

    it("marks every node type explicitly unknown under an explicit empty catalog", () => {
        const result = parseShaderGraphDocument(baseJson, { nodeTypeCatalog: {} });
        expect(result.ok).toBe(true);
        expect(result.value).not.toBeNull();
        // Explicit empty catalog: every node type degrades (warning) while
        // remaining fully loadable and preserved.
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnknownNodeType, severity: "warning", dataPath: "$.nodes[0].type" }),
            expect.objectContaining({ code: DiagnosticCode.UnknownNodeType, severity: "warning", dataPath: "$.nodes[1].type" }),
        ]);
    });

    it("uses the caller-supplied node type catalog for type and version checks", () => {
        const nodeTypeCatalog = {
            Float: { minimumVersion: 1, maximumVersion: 1 },
            SurfaceOutput: { minimumVersion: 1, maximumVersion: 2 },
        };
        const result = parseShaderGraphDocument(baseJson, { nodeTypeCatalog });
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);

        const nodes = (JSON.parse(baseJson) as Record<string, unknown>)["nodes"] as Record<string, unknown>[];
        expectElement(nodes, 1)["version"] = 3;
        const bumped = parseShaderGraphDocument(JSON.stringify({ ...baseDocument(), nodes }), { nodeTypeCatalog });
        expect(bumped.ok).toBe(true);
        expect(bumped.diagnostics).toEqual([
            expect.objectContaining({
                code: DiagnosticCode.UnknownNodeVersion,
                severity: "warning",
                dataPath: "$.nodes[1].version",
            }),
        ]);
    });

    it("round-trips byte-stably: parse → serialize → parse → serialize", () => {
        const first = parseShaderGraphDocument(baseJson);
        const firstDocument = expectParsed(first.value);
        const bytes1 = serializeShaderGraphDocument(firstDocument);

        const second = parseShaderGraphDocument(bytes1);
        expect(second.ok).toBe(true);
        const secondDocument = expectParsed(second.value);
        expect(serializeShaderGraphDocument(secondDocument)).toBe(bytes1);
        expect(secondDocument).toEqual(firstDocument);
    });

    it("serializes canonical bytes independent of input key order", () => {
        const reference = parseShaderGraphDocument(baseJson);
        const referenceBytes = serializeShaderGraphDocument(expectParsed(reference.value));

        const shuffled: Record<string, unknown> = {
            editorMetadata: baseDocument()["editorMetadata"],
            connections: baseDocument()["connections"],
            nodes: baseDocument()["nodes"],
            parameters: baseDocument()["parameters"],
            profileVersion: 1,
            profile: "gglab.surface",
            graphId: "graph.test-surface",
            schemaVersion: 1,
        };
        const shuffledResult = parseShaderGraphDocument(JSON.stringify(shuffled));
        expect(shuffledResult.ok).toBe(true);
        expect(serializeShaderGraphDocument(expectParsed(shuffledResult.value))).toBe(referenceBytes);
    });

    it("retains unknown top-level fields for lossless round-trip and warns", () => {
        const result = parseVariant((document) => {
            document["experimental"] = { nested: [1, { zkey: "z", akey: "a" }] };
        });
        expect(result.ok).toBe(true);
        const document = expectParsed(result.value);
        expect(document.unknownFields).toEqual({ experimental: { nested: [1, { zkey: "z", akey: "a" }] } });
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnexpectedField, severity: "warning", dataPath: "$.experimental" }),
        );

        const bytes = serializeShaderGraphDocument(document);
        const roundTripped = parseShaderGraphDocument(bytes);
        expect(roundTripped.ok).toBe(true);
        expect(expectParsed(roundTripped.value).unknownFields).toEqual({ experimental: { nested: [1, { zkey: "z", akey: "a" }] } });
        // Retained nested objects are canonicalized to sorted keys on write.
        expect(bytes).toContain(`"akey": "a"`);
    });

    it("retains unknown node fields for lossless round-trip and warns", () => {
        const result = parseVariant((document) => {
            const nodes = document["nodes"] as Record<string, unknown>[];
            expectElement(nodes, 0)["futureTintMode"] = "linear";
        });
        expect(result.ok).toBe(true);
        const node = expectParsed(result.value).nodes[0];
        expect(node?.unknownFields).toEqual({ futureTintMode: "linear" });
        expect(node?.id).toBe("node.constant");
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnexpectedField, severity: "warning", dataPath: "$.nodes[0].futureTintMode" }),
        );
    });

    it("retains unknown fields at every level through a full lossless round-trip", () => {
        const result = parseVariant((document) => {
            document["futureTooling"] = { layout: { zed: 3, alpha: 1 } };
            const parameters = document["parameters"] as Record<string, unknown>[];
            expectElement(parameters, 0)["hint"] = "tint";
            const nodes = document["nodes"] as Record<string, unknown>[];
            expectElement(nodes, 0)["customCurve"] = [1, { zed: 1, alpha: 2 }];
            const connections = document["connections"] as Record<string, unknown>[];
            expectElement(connections, 0)["priority"] = 7;
            (expectElement(connections, 0)["from"] as Record<string, unknown>)["lane"] = 2;
            (document["editorMetadata"] as Record<string, unknown>)["viewport"] = { zoom: 1.5 };
            ((document["editorMetadata"] as Record<string, unknown>)["nodes"] as Record<string, Record<string, unknown>>)["node.constant"]!["focusDepth"] = 4;
        });
        expect(result.ok).toBe(true);
        const document = expectParsed(result.value);
        // Retained at its own level — not re-nested, not dropped.
        expect(document.unknownFields).toEqual({ futureTooling: { layout: { alpha: 1, zed: 3 } } });
        expect(document.parameters[0]?.unknownFields).toEqual({ hint: "tint" });
        expect(document.nodes[0]?.unknownFields).toEqual({ customCurve: [1, { alpha: 2, zed: 1 }] });
        expect(document.connections[0]?.unknownFields).toEqual({ priority: 7 });
        expect(document.connections[0]?.from.unknownFields).toEqual({ lane: 2 });
        expect(document.editorMetadata.unknownFields).toEqual({ viewport: { zoom: 1.5 } });
        expect(document.editorMetadata.nodes["node.constant"]?.unknownFields).toEqual({ focusDepth: 4 });

        // The full round trip is structurally identical AND byte-stable —
        // the canonical write emits retained fields as siblings (sorted),
        // never as a nested "unknownFields" bookkeeping key.
        const bytes1 = serializeShaderGraphDocument(document);
        expect(bytes1).not.toContain('"unknownFields"');
        const second = parseShaderGraphDocument(bytes1);
        expect(second.ok).toBe(true);
        expect(expectParsed(second.value)).toEqual(document);
        expect(serializeShaderGraphDocument(expectParsed(second.value))).toBe(bytes1);
    });

    it("rejects an unsupported schema version before interpreting anything", () => {
        const result = parseVariant((document) => {
            document["schemaVersion"] = 2;
        });
        expect(result.ok).toBe(false);
        expect(result.value).toBeNull();
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.UnsupportedSchemaVersion, severity: "error", dataPath: "$.schemaVersion" }),
        ]);
    });

    it("collects missing, mistyped, and malformed-structure diagnostics together", () => {
        const result = parseVariant((document) => {
            delete document["profileVersion"];
            document["nodes"] = "nope";
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.MissingRequiredField, severity: "error", dataPath: "$.profileVersion" }),
        );
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnexpectedType, severity: "error", dataPath: "$.nodes" }),
        );
    });

    it("rejects unstable ids", () => {
        const result = parseVariant((document) => {
            const nodes = document["nodes"] as Record<string, unknown>[];
            expectElement(nodes, 0)["id"] = "bad id/!";
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.InvalidStableId, severity: "error", dataPath: "$.nodes[0].id" }),
        );
    });

    it("rejects duplicate node, parameter, and connection ids", () => {
        const result = parseVariant((document) => {
            const nodes = document["nodes"] as Record<string, unknown>[];
            const parameters = document["parameters"] as Record<string, unknown>[];
            const connections = document["connections"] as Record<string, unknown>[];
            expectElement(nodes, 1)["id"] = expectElement(nodes, 0)["id"];
            parameters["push"]({ id: "param.baseTint", name: "Dup", class: "ScalarParameter", valueType: "float" });
            connections["push"]({
                id: "conn.01",
                from: { nodeId: "node.constant", portId: "value" },
                to: { nodeId: "node.output", portId: "roughness" },
            });
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.DuplicateNodeId, severity: "error" }),
        );
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.DuplicateParameterId, severity: "error" }),
        );
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.DuplicateConnectionId, severity: "error" }),
        );
    });

    it("rejects connections that reference unknown nodes", () => {
        const result = parseVariant((document) => {
            const connections = document["connections"] as Record<string, unknown>[];
            (expectElement(connections, 0)["to"] as Record<string, unknown>)["nodeId"] = "node.missing";
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: DiagnosticCode.UnresolvedNodeReference,
                severity: "error",
                dataPath: "$.connections[0].to.nodeId",
            }),
        );
    });

    it("warns when editor metadata references a node that does not exist", () => {
        const result = parseVariant((document) => {
            const metadata = document["editorMetadata"] as Record<string, unknown>;
            const states = metadata["nodes"] as Record<string, unknown>;
            states["node.ghost"] = { position: { x: 1, y: 2 } };
        });
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: DiagnosticCode.UnresolvedNodeReference,
                severity: "warning",
                dataPath: "$.editorMetadata.nodes.node.ghost",
            }),
        );
    });

    it("reports malformed JSON input", () => {
        const result = parseShaderGraphDocument("{ not json");
        expect(result.ok).toBe(false);
        expect(result.value).toBeNull();
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: DiagnosticCode.InvalidJson, severity: "error", dataPath: "$" }),
        ]);
    });
});

describe("removeConnectionsAtPort", () => {
    function portTestDocument(): ShaderGraphDocument {
        const record = baseDocument();
        const connections = record["connections"] as Record<string, unknown>[];
        // Two attachments ON the output's BaseColor input (incoming from
        // the Float), plus one unrelated wire on Roughness.
        connections.push({
            id: "conn.02",
            from: { nodeId: "node.output", portId: "Roughness" },
            to: { nodeId: "node.output", portId: "Metallic" },
        });
        return expectParsed(parseShaderGraphDocument(JSON.stringify(record)).value);
    }

    it("removes EVERYTHING attached to the port, in either direction, and preserves the rest", () => {
        const document = portTestDocument();
        // Both the incoming (conn.01 ends on BaseColor) and the other-side
        // attachment of conn.02 touch "node.output/BaseColor"? No — conn.02
        // starts at Roughness. BaseColor only holds conn.01's target end.
        const onBaseColor = removeConnectionsAtPort(document, "node.output", "BaseColor");
        expect(onBaseColor.ok).toBe(true);
        expect(onBaseColor.removed).toBe(1);
        if (onBaseColor.document === null) {
            throw new Error("expected a document");
        }
        expect(onBaseColor.document.connections.map((entry) => entry.id)).toEqual(["conn.02"]);
        expect(onBaseColor.document.nodes).toEqual(document.nodes);
        expect(onBaseColor.document.parameters).toEqual(document.parameters);
        expect(onBaseColor.document.editorMetadata).toEqual(document.editorMetadata);
        // A second attempt at the same port is now the honest zero case:
        const again = removeConnectionsAtPort(document, "node.output", "BaseColor");
        expect(again.ok).toBe(true);
        expect(again.removed).toBe(1); // against the ORIGINAL input instance
    });

    it("removes the fan-out of a producer in one atomic operation", () => {
        const record = baseDocument();
        // float3 value out → two output inputs: a real fan-out on "value".
        const connections = record["connections"] as Record<string, unknown>[];
        connections.unshift({
            id: "conn.00",
            from: { nodeId: "node.constant", portId: "value" },
            to: { nodeId: "node.output", portId: "Roughness" },
        });
        const document = expectParsed(parseShaderGraphDocument(JSON.stringify(record)).value);
        expect(document.connections.map((entry) => entry.id)).toEqual(["conn.00", "conn.01"]);
        const result = removeConnectionsAtPort(document, "node.constant", "value");
        expect(result.ok).toBe(true);
        expect(result.removed).toBe(2);
        if (result.document === null) {
            throw new Error("expected a document");
        }
        expect(result.document.connections).toEqual([]);
        // ...and the input document stayed untouched (atomic).
        expect(document.connections).toHaveLength(2);
    });

    it("fails with an UNRESOLVED_NODE_REFERENCE for a node that does not exist", () => {
        const document = portTestDocument();
        const result = removeConnectionsAtPort(document, "node.nowhere", "BaseColor");
        expect(result.ok).toBe(false);
        expect(result.document).toBeNull();
        expect(result.removed).toBe(0);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnresolvedNodeReference, severity: "error" }),
        );
    });

    it("fails with an UNKNOWN_PORT for a port the catalog says the type does not have", () => {
        // SurfaceOutput is a known type; it has no "value" output.
        const document = portTestDocument();
        const result = removeConnectionsAtPort(document, "node.output", "value");
        expect(result.ok).toBe(false);
        expect(result.document).toBeNull();
        expect(result.removed).toBe(0);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: DiagnosticCode.UnknownPort, severity: "error" }),
        );
    });

    it("is an honest no-op for a real port with zero attachments: ok, SAME instance, removed 0", () => {
        const document = portTestDocument();
        const result = removeConnectionsAtPort(document, "node.output", "Emissive");
        expect(result.ok).toBe(true);
        expect(result.removed).toBe(0);
        expect(result.document).toBe(document); // same instance → nothing applies, nothing dirties
        expect(result.diagnostics).toEqual([]);
    });
});

describe("reconnectConnection", () => {
    it("moves exactly one endpoint and preserves the id, unknownFields, and the other end", () => {
        const record = baseDocument();
        const connections = record["connections"] as Record<string, unknown>[];
        const first = expectElement(connections, 0) as Record<string, unknown>;
        first["revisit"] = "keep-me"; // unknown field → must survive the move
        const document = expectParsed(parseShaderGraphDocument(JSON.stringify(record)).value);
        const moved = document.connections[0];
        expect(moved).not.toBeUndefined();
        if (moved === undefined) {
            throw new Error("expected the fixture connection");
        }
        const result = reconnectConnection(document, moved.id, { side: "to", nodeId: "node.output", portId: "Emissive" });
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        if (result.document === null) {
            throw new Error("expected a document");
        }
        const after = expectElement(result.document.connections, 0);
        expect(after.id).toBe(moved.id); // the SAME first-class object
        expect(after.to).toEqual({ nodeId: "node.output", portId: "Emissive", unknownFields: {} });
        expect(after.from).toEqual(moved.from); // other end untouched
        expect((after as { revisit?: unknown }).revisit ?? after.unknownFields["revisit"]).toEqual("keep-me");
        // The input document keeps its original wire (atomic).
        expect(document.connections[0]?.to.portId).toBe("BaseColor");
    });

    it("fails with a structured CONNECTION_NOT_FOUND and no document for a stale id", () => {
        const document = expectParsed(parseShaderGraphDocument(baseJson).value);
        const result = reconnectConnection(document, "conn.stale", { side: "from", nodeId: "node.constant", portId: "value" });
        expect(result.ok).toBe(false);
        expect(result.document).toBeNull();
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toEqual(
            expect.objectContaining({ code: DiagnosticCode.ConnectionNotFound, severity: "error", dataPath: "$.connections" }),
        );
    });
});
