import { describe, expect, it } from "vitest";
import { addNode, addParameter, addConnection, removeNode, setConstantValue, removeConnection, removeConnectionsAtPort, reconnectConnection } from "@gglab/editor-ui";
import { applyGraphEdit, type ShaderGraphDocument } from "@gglab/shader-graph-core";

const empty: ShaderGraphDocument = { schemaVersion: 1, graphId: "adapter", profile: "gglab.surface", profileVersion: 1, nodes: [], parameters: [], connections: [], editorMetadata: { nodes: {}, unknownFields: {} }, unknownFields: {} };

describe("GUI adapters share core edit semantics", () => {
    it("matches core creation and adds only requested canvas placement", () => {
        const core = applyGraphEdit(empty, { kind: "add-node", nodeType: "Float" });
        expect(addNode(empty, "Float").document).toEqual(core.document);
        const positioned = addNode(empty, "Float", { position: { x: 10, y: 20 } });
        expect(positioned.document.nodes).toEqual(core.document.nodes);
        expect(positioned.document.editorMetadata.nodes.n1?.position).toEqual({ x: 10, y: 20 });
        const parameter = applyGraphEdit(empty, { kind: "add-parameter", class: "VectorParameter", valueType: "float3", name: "Tint" });
        expect(addParameter(empty, { class: "VectorParameter", valueType: "float3", name: "Tint" }).document).toEqual(parameter.document);
        const refused = addParameter(empty, { class: "BoolParameter", valueType: "float", name: "P" }, { position: { x: 5, y: 5 } });
        expect(refused.document).toBe(empty);
        expect(refused.applied).toBe(false);
        expect(refused.refusal?.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER_CLASS");
    });

    it("preserves no-op identity and forwards structured core refusals", () => {
        const document = addNode(empty, "Float").document;
        const noop = setConstantValue(document, "n1", 0);
        expect(noop.applied).toBe(true);
        expect(noop.document).toBe(document);
        const command = { kind: "set-constant-value", nodeId: "n1", value: [1, 2] } as const;
        const core = applyGraphEdit(document, command);
        const gui = setConstantValue(document, "n1", [1, 2]);
        expect(gui.document).toBe(document);
        expect(gui.refusal?.diagnostics).toEqual(core.diagnostics);
    });

    it("routes connection edits and whole-node deletion through the same core behavior", () => {
        const nodes = addNode(addNode(empty, "Float").document, "OneMinus").document;
        const from = { nodeId: "n1", portId: "value" };
        const to = { nodeId: "n2", portId: "value" };
        const wired = addConnection(nodes, from, to).document;
        expect(wired).toEqual(applyGraphEdit(nodes, { kind: "add-connection", from, to }).document);
        expect(reconnectConnection(wired, "c1", { side: "to", ...to }).document).toBe(wired);
        expect(removeConnection(wired, "c1").document).toEqual(applyGraphEdit(wired, { kind: "remove-connection", connectionId: "c1" }).document);
        expect(removeConnectionsAtPort(wired, { ...to, side: "input" }).document).toEqual(applyGraphEdit(wired, { kind: "disconnect-port", ...to, side: "input" }).document);
        expect(removeNode(wired, "n2").document).toEqual(applyGraphEdit(wired, { kind: "remove-node", nodeId: "n2" }).document);
    });
});
