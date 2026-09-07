import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyGraphEdit, applyGraphEdits, emitHlsl, parseGraphEditCommands, parseShaderGraphDocument, parseSurfaceProfileDescriptor, readGraphEditCommand, serializeShaderGraphDocument, validateShaderGraph, type GraphEditCommand, type ShaderGraphDocument } from "../src/index.js";
import { canonicalV1Fixture } from "./fixtures/descriptor-v1.js";
import { canonicalV2Fixture } from "./fixtures/descriptor-v2.js";

const document: ShaderGraphDocument = {
    schemaVersion: 1, graphId: "edits", profile: "gglab.surface", profileVersion: 1,
    nodes: [], parameters: [], connections: [], editorMetadata: { nodes: {}, unknownFields: { theme: "retained" } }, unknownFields: { extension: { keep: true } },
};
const descriptor = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV1Fixture)).value!;
const descriptorV2 = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV2Fixture)).value!;
const golden = parseShaderGraphDocument(readFileSync(new URL("./fixtures/SurfaceTextureGolden.shadergraph", import.meta.url), "utf8")).value!;

describe("atomic core authoring", () => {
    it("reports changed, unchanged and refused while preserving identity and retained fields", () => {
        const created = applyGraphEdit(document, { kind: "add-node", nodeType: "Float3" });
        expect(created).toMatchObject({ status: "changed", createdId: "n1" });
        expect(created.document.nodes[0]?.properties).toEqual({ value: [0, 0, 0] });
        const next = applyGraphEdit(created.document, { kind: "set-constant-value", nodeId: "n1", value: [1, 2, 3] });
        expect(next.status).toBe("changed");
        expect(next.document.unknownFields).toBe(document.unknownFields);
        expect(next.document.editorMetadata).toBe(document.editorMetadata);
        const same = applyGraphEdit(next.document, { kind: "set-constant-value", nodeId: "n1", value: [1, 2, 3] });
        expect(same.status).toBe("unchanged");
        expect(same.document).toBe(next.document);
        const refused = applyGraphEdit(next.document, { kind: "set-constant-value", nodeId: "n1", value: [1, 2] });
        expect(refused.status).toBe("refused");
        expect(refused.document).toBe(next.document);
        expect(refused.diagnostics[0]).toMatchObject({ code: "INVALID_NODE_PROPERTY", dataPath: "$.nodes[0].properties.value" });
    });

    it("rejects nonfinite and sparse constants and does not reinterpret unknown node versions", () => {
        const current = applyGraphEdit(document, { kind: "add-node", nodeType: "Float3" }).document;
        for (const value of [NaN, Infinity, [1, Infinity, 2], new Array<number>(3)]) {
            expect(applyGraphEdit(current, { kind: "set-constant-value", nodeId: "n1", value }).document).toBe(current);
            expect(applyGraphEdit(current, { kind: "set-constant-value", nodeId: "n1", value }).status).toBe("refused");
        }
        const newer = { ...current, nodes: current.nodes.map((node) => ({ ...node, version: 999 })) };
        expect(applyGraphEdit(newer, { kind: "set-constant-value", nodeId: "n1", value: [1, 2, 3] })).toMatchObject({ status: "refused", diagnostics: [{ code: "UNKNOWN_NODE_VERSION" }] });
    });

    it("allocates stable IDs independent of array ordering and rejects collisions atomically", () => {
        const initial = applyGraphEdits(document, [
            { kind: "add-node", nodeType: "Float", nodeId: "n2" },
            { kind: "add-node", nodeType: "Float", nodeId: "n1" },
        ]).document;
        expect(applyGraphEdit(initial, { kind: "add-node", nodeType: "Float" }).createdId).toBe("n3");
        expect(applyGraphEdit({ ...initial, nodes: [...initial.nodes].reverse() }, { kind: "add-node", nodeType: "Float" }).createdId).toBe("n3");
        for (const nodeId of ["n1", "invalid id"]) {
            const result = applyGraphEdit(initial, { kind: "add-parameter", class: "ScalarParameter", name: "P", valueType: "float", nodeId });
            expect(result.status).toBe("refused");
            expect(result.document).toBe(initial);
            expect(result.document.parameters).toHaveLength(0);
        }
    });

    it("removes the node, attached connections and its metadata as one operation", () => {
        const node = golden.nodes[0]!;
        const edited = applyGraphEdit(golden, { kind: "remove-node", nodeId: node.id });
        expect(edited.document.nodes.some((entry) => entry.id === node.id)).toBe(false);
        expect(edited.document.connections.some((entry) => entry.from.nodeId === node.id || entry.to.nodeId === node.id)).toBe(false);
        expect(edited.document.editorMetadata.nodes[node.id]).toBeUndefined();
        expect(edited.document.editorMetadata.nodes[golden.nodes[1]!.id]).toBe(golden.editorMetadata.nodes[golden.nodes[1]!.id]);
    });

    it("rolls back a failed batch and preserves the original instance for a net no-op", () => {
        const before = serializeShaderGraphDocument(document);
        const failed = applyGraphEdits(document, [{ kind: "add-node", nodeType: "Float" }, { kind: "remove-node", nodeId: "missing" }]);
        expect(failed.status).toBe("refused");
        expect(failed.document).toBe(document);
        expect(failed.createdIds).toEqual([]);
        expect(failed.failedCommandIndex).toBe(1);
        expect(failed.diagnostics.at(-1)?.dataPath).toBe("$.commands[1]");
        expect(serializeShaderGraphDocument(document)).toBe(before);
        const noop = applyGraphEdits(document, [{ kind: "add-node", nodeType: "Float" }, { kind: "remove-node", nodeId: "n1" }]);
        expect(noop.status).toBe("unchanged");
        expect(noop.document).toBe(document);
    });

    it("requires explicit profile selection and matching descriptor without mutating the original", () => {
        const command = { kind: "set-profile", profile: "gglab.surface", profileVersion: 2 } as const;
        expect(applyGraphEdit(document, command).status).toBe("refused");
        expect(applyGraphEdit(document, command, { descriptor }).status).toBe("refused");
        const selected = applyGraphEdit(document, command, { descriptor: descriptorV2 });
        expect(selected.status).toBe("changed");
        expect(selected.document.profileVersion).toBe(2);
        expect(document.profileVersion).toBe(1);
        expect(applyGraphEdit(selected.document, command, { descriptor: descriptorV2 }).document).toBe(selected.document);
        // A context supplied for an ordinary edit cannot upgrade its document.
        expect(applyGraphEdit(document, { kind: "add-node", nodeType: "Float" }, { descriptor: descriptorV2 }).document.profileVersion).toBe(1);
    });

    it("preserves generated symbols and source maps when only parameter display labels change", () => {
        const before = emitHlsl(golden, descriptorV2);
        expect(before.ok).toBe(true);
        const renamed = applyGraphEdit(golden, { kind: "rename-parameter", parameterId: "p.baseTint", name: "Different display name" });
        const after = emitHlsl(renamed.document, descriptorV2);
        expect(after.source).toBe(before.source);
        expect(after.sourceMap).toEqual(before.sourceMap);
        expect(renamed.document.parameters.find((parameter) => parameter.id === "p.baseTint")?.valueType).toBe("float3");
        expect(applyGraphEdit(renamed.document, { kind: "rename-parameter", parameterId: "p.baseTint", name: "Different display name" }).document).toBe(renamed.document);
    });

    it("preserves deterministic HLSL and source identity across edited save/load", () => {
        const wire = golden.connections.find((connection) => connection.to.portId === "Metallic")!;
        const commands: GraphEditCommand[] = [
            { kind: "add-node", nodeType: "Float", nodeId: "new-metal" },
            { kind: "set-constant-value", nodeId: "new-metal", value: 0.75 },
            { kind: "reconnect-connection", connectionId: wire.id, side: "from", nodeId: "new-metal", portId: "value" },
        ];
        const edited = applyGraphEdits(golden, commands);
        expect(edited.status).toBe("changed");
        expect(validateShaderGraph(edited.document).ok).toBe(true);
        const emitted = emitHlsl(edited.document, descriptorV2);
        expect(emitted.ok).toBe(true);
        const loaded = parseShaderGraphDocument(serializeShaderGraphDocument(edited.document));
        expect(loaded.ok).toBe(true);
        expect(emitHlsl(loaded.value!, descriptorV2)).toEqual(emitted);
    });
});

describe("strict core edit request reader", () => {
    it("rejects unknown commands, fields, sides and frontend placement fields", () => {
        for (const value of [null, { kind: "future-edit" }, { kind: "add-node", nodeType: "Float", position: { x: 1, y: 2 } }, { kind: "disconnect-port", nodeId: "n1", portId: "value", side: "from" }, { kind: "add-parameter", name: "P", class: "ScalarParameter", valueType: "double" }]) {
            expect(readGraphEditCommand(value).ok).toBe(false);
        }
        expect(parseGraphEditCommands("{" ).ok).toBe(false);
        expect(parseGraphEditCommands("{}").ok).toBe(false);
        expect(parseGraphEditCommands('[{"kind":"add-node","nodeType":"Float"}]').ok).toBe(true);
    });
});
