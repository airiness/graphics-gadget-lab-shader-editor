import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InlineConstantEditor, NodePropertiesPanel } from "@gglab/editor-ui";
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


describe("InlineConstantEditor", () => {
    it("keeps invalid drafts local and discards them on Escape", () => {
        const commit = vi.fn(() => true);
        const view = render(<InlineConstantEditor node={makeNode("Float", { value: 0.25 })} onCommit={commit} />);
        const input = screen.getByRole("textbox", { name: "Value" });
        fireEvent.change(input, { target: { value: "-" } });
        fireEvent.blur(input);
        expect(commit).not.toHaveBeenCalled();
        expect(screen.getByRole("alert")).toBeTruthy();
        fireEvent.keyDown(input, { key: "Escape" });
        fireEvent.blur(input);
        expect(commit).not.toHaveBeenCalled();
        expect((input as HTMLInputElement).value).toBe("0.25");
        expect(screen.queryByRole("alert")).toBeNull();
        view.unmount();
    });

    it("commits the complete vector and reflects values changed by the other surface", () => {
        const commit = vi.fn(() => true);
        const view = render(<InlineConstantEditor node={makeNode("Float3", { value: [1, 2, 3] })} onCommit={commit} />);
        fireEvent.change(screen.getByRole("textbox", { name: "Y" }), { target: { value: "0.5" } });
        fireEvent.keyDown(screen.getByRole("textbox", { name: "Y" }), { key: "Enter" });
        expect(commit).toHaveBeenCalledWith("node.Float3", [1, 0.5, 3]);
        view.rerender(<InlineConstantEditor node={makeNode("Float3", { value: [4, 5, 6] })} onCommit={commit} />);
        expect((screen.getByRole("textbox", { name: "Y" }) as HTMLInputElement).value).toBe("5");
        view.unmount();
    });

    it("isolates a draft when two document sessions reuse the same node ID", () => {
        const commit = vi.fn(() => true);
        const node = makeNode("Float", { value: 1 });
        const view = render(<InlineConstantEditor key="document-a" node={node} onCommit={commit} />);
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "99" } });
        view.rerender(<InlineConstantEditor key="document-b" node={node} onCommit={commit} />);
        expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("1");
        expect(commit).not.toHaveBeenCalled();
        view.unmount();
    });

    it("does not forward edit gestures to the canvas or invent parameter defaults", () => {
        const pointer = vi.fn(), keyboard = vi.fn(), commit = vi.fn(() => false);
        const view = render(<div onPointerDown={pointer} onKeyDown={keyboard}>
            <InlineConstantEditor node={makeNode("Float", { value: 1 })} onCommit={commit} />
        </div>);
        const input = screen.getByRole("textbox");
        fireEvent.pointerDown(input);
        fireEvent.change(input, { target: { value: "2" } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(pointer).not.toHaveBeenCalled();
        expect(keyboard).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toContain("did not accept");
        view.rerender(<InlineConstantEditor node={makeNode("ScalarParameter", { parameterId: "p.rough" })} onCommit={commit} />);
        expect(screen.queryByRole("textbox")).toBeNull();
        view.unmount();
    });
});
