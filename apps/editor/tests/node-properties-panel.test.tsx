import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NodePropertiesPanel } from "@gglab/editor-ui";
import type { GraphNode } from "@gglab/shader-graph-core";

function makeNode(type: string, properties: GraphNode["properties"]): GraphNode {
    return {
        id: `node.${type}`,
        type,
        version: 1,
        properties,
        unknownFields: {},
    };
}

describe("NodePropertiesPanel", () => {
    it("commits a scalar constant with the selected node identity", () => {
        const onCommit = vi.fn(() => true);

        const view = render(
            <NodePropertiesPanel
                node={makeNode("Float", { value: 0.25 })}
                onConstantValueCommit={onCommit}
            />,
        );

        const input = screen.getByRole("textbox", { name: "Value" });
        fireEvent.change(input, { target: { value: "0.75" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(onCommit).toHaveBeenCalledOnce();
        expect(onCommit).toHaveBeenCalledWith("node.Float", 0.75);
        view.unmount();
    });

    it("commits a complete vector value", () => {
        const onCommit = vi.fn(() => true);

        const view = render(
            <NodePropertiesPanel
                node={makeNode("Float3", { value: [1, 2, 3] })}
                onConstantValueCommit={onCommit}
            />,
        );

        fireEvent.change(screen.getByRole("textbox", { name: "X" }), { target: { value: "4" } });
        fireEvent.change(screen.getByRole("textbox", { name: "Y" }), { target: { value: "5" } });
        const zInput = screen.getByRole("textbox", { name: "Z" });
        fireEvent.change(zInput, { target: { value: "6" } });
        fireEvent.keyDown(zInput, { key: "Enter" });

        expect(onCommit).toHaveBeenCalledOnce();
        expect(onCommit).toHaveBeenCalledWith("node.Float3", [4, 5, 6]);
        view.unmount();
    });

    it("rejects non-finite input before it reaches the authoring operation", () => {
        const onCommit = vi.fn(() => true);

        const view = render(
            <NodePropertiesPanel
                node={makeNode("Float", { value: 0.25 })}
                onConstantValueCommit={onCommit}
            />,
        );

        const input = screen.getByRole("textbox", { name: "Value" });
        fireEvent.change(input, { target: { value: "not-a-number" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(onCommit).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toContain("finite number");
        view.unmount();
    });

    it("keeps parameter bindings read-only because their values are Runtime-owned", () => {
        const view = render(
            <NodePropertiesPanel
                node={makeNode("ScalarParameter", { parameterId: "roughness" })}
                onConstantValueCommit={vi.fn(() => true)}
            />,
        );

        expect(screen.getByText("roughness")).toBeTruthy();
        expect(screen.getByText(/Runtime-owned/i)).toBeTruthy();
        expect(screen.queryByRole("textbox")).toBeNull();
        view.unmount();
    });

    it("explains how to expose contextual properties when nothing is selected", () => {
        const view = render(<NodePropertiesPanel node={null} onConstantValueCommit={vi.fn(() => true)} />);

        expect(screen.getByText(/Select a node/i)).toBeTruthy();
        view.unmount();
    });
});
