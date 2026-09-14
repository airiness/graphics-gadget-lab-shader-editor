import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { parseSurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { canonicalV2Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v2.js";
import { App } from "../src/app.js";

// Drive the Canvas adapter's intent callbacks directly. Canvas gesture behavior
// has its own tests; this suite exercises ownership and shell placement.
vi.mock("@gglab/editor-ui", async importOriginal => {
    const actual = await importOriginal<typeof import("@gglab/editor-ui")>();
    return { ...actual, DescriptorPanel: (props: ComponentProps<typeof actual.DescriptorPanel>) => <>
        <actual.DescriptorPanel {...props} />
        <button onClick={() => props.onStateChange({ kind: "ready", descriptor: parseSurfaceProfileDescriptor(JSON.stringify(canonicalV2Fixture)).value! })}>Load test profile catalog</button>
    </>, FlowViewport: (props: ComponentProps<typeof actual.FlowViewport>) => <div>
        {props.nodes.map(node => <button key={node.id} onClick={() => props.onNodeSelect?.(node.id)}>Select {node.id}</button>)}
        {props.nodes.map(node => <button key={`menu-${node.id}`} onClick={() => props.onNodeMenu?.(node.id, { x: 0, y: 0 })}>Menu {node.id}</button>)}
        {props.edges.map(edge => <button key={edge.id} onClick={() => props.onEdgeSelect?.(edge.id)}>Select connection {edge.id}</button>)}
    </div> };
});
// jsdom has no native modal implementation. Exercise controlled open/cancel
// behavior here; browser focus containment/return is a separate visual gate.
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
afterEach(cleanup);

describe("selection Inspector and global workbench surfaces", () => {
    it("starts with a lightweight selection Inspector and keeps configuration out", () => {
        const { container } = render(<App />), root = within(container);
        const inspector = root.getByRole("complementary", { name: "Selection Inspector" });
        expect(inspector.textContent).toContain("Select a node");
        for (const text of ["Tool path", "Native build", "Surface Profile", "Graph document text", "Shader Graph Preview"]) expect(inspector.textContent).not.toContain(text);
        expect(within(inspector).queryByRole("tablist")).toBeNull();
        const actions = root.getByRole("group", { name: "Document and native actions" });
        expect(within(actions).getByRole("combobox", { name: "Target" })).toBeDefined();
    });
    it("keeps selected node details while opening and dismissing global configuration", () => {
        const { container } = render(<App />), root = within(container);
        fireEvent.click(root.getByRole("button", { name: "Select n.t" }));
        const inspector = root.getByRole("complementary", { name: "Selection Inspector" });
        expect(inspector.textContent).toContain("p.tint");
        fireEvent.click(root.getByRole("button", { name: "Profile…" }));
        const modal = root.getByRole("dialog", { name: "Surface Profile" });
        expect(modal.textContent).toContain("requested profile line");
        fireEvent(modal, new Event("cancel", { bubbles: false, cancelable: true }));
        expect(root.queryByRole("dialog")).toBeNull(); expect(inspector.textContent).toContain("p.tint");
    });
    it("shows the selected connection and deletes it through the existing authoring path", () => {
        const { container } = render(<App />), root = within(container);
        fireEvent.click(root.getByRole("button", { name: "Select connection c1" }));
        const inspector = root.getByRole("complementary", { name: "Selection Inspector" });
        expect(inspector.textContent).toContain("n.t · value");
        expect(inspector.textContent).toContain("n.out · Emissive");
        fireEvent.click(within(inspector).getByRole("button", { name: "Delete connection" }));
        expect(root.queryByRole("button", { name: "Select connection c1" })).toBeNull();
        fireEvent.click(root.getByRole("button", { name: "Undo" }));
        expect(root.getByRole("button", { name: "Select connection c1" })).toBeDefined();
    });
    it("keeps node menu and Delete bound to the same selected owner", () => {
        const { container } = render(<App />), root = within(container);
        fireEvent.click(root.getByRole("button", { name: "Menu n.t" }));
        const inspector = root.getByRole("complementary", { name: "Selection Inspector" });
        expect(inspector.textContent).toContain("p.tint");
        fireEvent.click(root.getByRole("menuitem", { name: /Delete Node/ }));
        expect(root.queryByRole("button", { name: "Select n.t" })).toBeNull();
        fireEvent.click(root.getByRole("button", { name: "Undo" }));
        expect(root.getByRole("button", { name: "Select n.t" })).toBeDefined();
    });
    it("exposes document text in its global modal and preserves drafts across close", () => {
        const { container } = render(<App />), root = within(container);
        fireEvent.click(root.getByRole("button", { name: "Document…" }));
        const modal = root.getByRole("dialog", { name: "Graph document" });
        const input = within(modal).getByRole("textbox", { name: "Graph document JSON" });
        fireEvent.change(input, { target: { value: "draft" } });
        fireEvent.click(within(modal).getByRole("button", { name: "Close" }));
        fireEvent.click(root.getByRole("button", { name: "Document…" }));
        expect((root.getByRole("textbox", { name: "Graph document JSON" }) as HTMLTextAreaElement).value).toBe("draft");
    });
    it("keeps loose tool paths in explicit advanced configuration", () => {
        const { container } = render(<App />), root = within(container);
        expect(root.queryByRole("textbox", { name: "Explicit tool path (discovery rule 1)" })).toBeNull();
        fireEvent.click(root.getByRole("button", { name: "Advanced…" }));
        const modal = root.getByRole("dialog", { name: "Advanced native configuration" });
        expect(within(modal).getByRole("textbox", { name: "Explicit tool path (discovery rule 1)" })).toBeDefined();
        expect(within(modal).getByRole("button", { name: "Re-discover" })).toBeDefined();
    });
    it("reopens the proper evidence view independently of Inspector visibility", () => {
        const { container } = render(<App />), root = within(container);
        fireEvent.click(root.getByRole("button", { name: "Collapse the inspector" }));
        fireEvent.click(root.getByRole("button", { name: "Collapse the bottom panel" }));
        fireEvent.click(root.getByRole("button", { name: "Build / HLSL" }));
        expect(root.getByRole("tab", { name: "Build" }).getAttribute("aria-selected")).toBe("true");
        expect(root.getByText("Native readiness and identities")).toBeDefined();
        expect(root.getByText("Generated HLSL")).toBeDefined();
        fireEvent.click(root.getByRole("button", { name: "Preview details" }));
        expect(root.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
        expect(root.getByText("Preview state and advanced controls")).toBeDefined();
        expect(root.getByLabelText("Inspector (collapsed)")).toBeDefined();
    });
});


describe("workbench keyboard tabs", () => {
    it("moves sidebar focus with selection and wraps without intercepting modified keys", () => {
        const { container } = render(<App />), root = within(container);
        const tabs = within(root.getByRole("tablist", { name: "Workspace panels" }));
        const nodes = tabs.getByRole("tab", { name: "Nodes" });
        const explorer = tabs.getByRole("tab", { name: "Explorer" });
        nodes.focus();
        fireEvent.keyDown(nodes, { key: "ArrowRight" });
        expect(document.activeElement).toBe(explorer);
        expect(explorer.getAttribute("aria-selected")).toBe("true");
        expect(explorer.tabIndex).toBe(0); expect(nodes.tabIndex).toBe(-1);
        fireEvent.keyDown(explorer, { key: "End" });
        expect(document.activeElement).toBe(nodes);
        fireEvent.keyDown(nodes, { key: "Home", ctrlKey: true });
        expect(document.activeElement).toBe(nodes);
        fireEvent.keyDown(nodes, { key: "Home" });
        expect(document.activeElement).toBe(explorer);
    });
    it("moves bottom-panel focus as well as the visible evidence view", () => {
        const { container } = render(<App />), root = within(container);
        const tabs = within(root.getByRole("tablist", { name: "Bottom panel views" }));
        const output = tabs.getByRole("tab", { name: "Output" });
        const problems = tabs.getByRole("tab", { name: "Problems" });
        output.focus(); fireEvent.keyDown(output, { key: "End" });
        expect(document.activeElement).toBe(problems);
        expect(root.getByRole("tabpanel", { name: "Problems" })).toBeDefined();
        fireEvent.keyDown(problems, { key: "ArrowRight" });
        expect(document.activeElement).toBe(output);
        expect(root.getByRole("tabpanel", { name: "Output" })).toBeDefined();
    });
    it("switches document focus while preserving the explicit Preview target", () => {
        const { container } = render(<App />), root = within(container);
        fireEvent.click(root.getByRole("button", { name: "Document…" }));
        const modal = within(root.getByRole("dialog", { name: "Graph document" }));
        fireEvent.click(modal.getByRole("button", { name: "Export to text" }));
        fireEvent.click(modal.getByRole("button", { name: "Import from text" }));
        fireEvent.click(modal.getByRole("button", { name: "Close" }));
        const list = root.getByRole("tablist", { name: "Open documents" });
        const tabs = within(list).getAllByRole("tab");
        expect(tabs).toHaveLength(2);
        const first = tabs[0]!, second = tabs[1]!;
        expect(first.tagName).toBe("BUTTON");
        expect(within(first).getByLabelText("Preview target")).toBeDefined();
        second.focus(); fireEvent.keyDown(second, { key: "Home" });
        expect(document.activeElement).toBe(first);
        expect(first.getAttribute("aria-selected")).toBe("true");
        expect(first.tabIndex).toBe(0); expect(second.tabIndex).toBe(-1);
        fireEvent.keyDown(first, { key: "ArrowLeft" });
        expect(document.activeElement).toBe(second);
        expect(second.getAttribute("aria-selected")).toBe("true");
        expect(within(first).getByLabelText("Preview target")).toBeDefined();
        expect(within(second).queryByLabelText("Preview target")).toBeNull();
        expect(within(first).queryByRole("button")).toBeNull();
    });
});


describe("explicit document profile authoring", () => {
    it("does not upgrade on descriptor load and applies through undoable document history", () => {
        const { container } = render(<App />), root = within(container);
        fireEvent.click(root.getByRole("button", { name: "Document…" }));
        fireEvent.click(root.getByRole("button", { name: "Export to text" }));
        fireEvent.click(root.getByRole("button", { name: "Import from text" }));
        fireEvent.click(within(root.getByRole("dialog")).getByRole("button", { name: "Close" }));
        fireEvent.click(root.getByRole("button", { name: "Profile…" }));
        const modal = within(root.getByRole("dialog", { name: "Surface Profile" }));
        expect(modal.getByRole("button", { name: "Apply document profile" }).hasAttribute("disabled")).toBe(true);
        fireEvent.click(modal.getByRole("button", { name: "Load test profile catalog" }));
        expect(modal.getByText("Document profile: gglab.surface v1")).toBeDefined();
        fireEvent.change(modal.getByRole("combobox", { name: "Requested profile" }), { target: { value: JSON.stringify(["gglab.surface", 2]) } });
        expect(modal.getByText("Document profile: gglab.surface v1")).toBeDefined();
        fireEvent.click(modal.getByRole("button", { name: "Apply document profile" }));
        expect(modal.getByText("Document profile: gglab.surface v2")).toBeDefined();
        fireEvent.click(modal.getByRole("button", { name: "Close" }));
        fireEvent.click(root.getByRole("button", { name: "Undo" }));
        fireEvent.click(root.getByRole("button", { name: "Profile…" }));
        expect(root.getByText("Document profile: gglab.surface v1")).toBeDefined();
        fireEvent.click(within(root.getByRole("dialog")).getByRole("button", { name: "Close" }));
        fireEvent.click(root.getByRole("button", { name: "Redo" }));
        fireEvent.click(root.getByRole("button", { name: "Document…" }));
        fireEvent.click(root.getByRole("button", { name: "Export to text" }));
        const text = (root.getByRole("textbox", { name: "Graph document JSON" }) as HTMLTextAreaElement).value;
        expect(JSON.parse(text)).toMatchObject({ profile: "gglab.surface", profileVersion: 2 });
        fireEvent.click(within(root.getByRole("dialog")).getByRole("button", { name: "Close" }));
        fireEvent.click(within(root.getByRole("tablist", { name: "Open documents" })).getAllByRole("tab")[0]!);
        fireEvent.click(root.getByRole("button", { name: "Profile…" }));
        expect(root.getByText("Document profile: gglab.surface v1")).toBeDefined();
    });
});
