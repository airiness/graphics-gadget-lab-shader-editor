/**
 * The bottom panel shell (presentation dock): it renders the four views,
 * switches the active tab, collapses to a strip and reopens, and exposes a
 * pointer-resize handle. The panel owns only its visible view, its open
 * state, and its height — and none of that may enter the Workspace semantic
 * authority (a DocumentSession or the WorkspaceStore), so those modules are
 * pinned to contain no trace of the panel.
 *
 * Each test mounts its OWN `<App />` and queries within that render's
 * container (then unmounts), so renders never accumulate in the shared body
 * and the queries stay unambiguous.
 */
import { describe, expect, it } from "vitest";
import { act, render, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "../src/app.js";
import { BOTTOM_PANEL_TABS } from "../src/bottom-panel.js";

const read = (relative: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), "utf8");

// jsdom does not implement ResizeObserver (or IntersectionObserver); the full
// App mounts a React Flow viewport whose measurement effect needs both. A
// no-op observer is enough for the shell's rendered state.
class ObserversStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): readonly unknown[] {
        return [];
    }
}
if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ObserversStub as unknown as typeof ResizeObserver;
}
if (typeof globalThis.IntersectionObserver === "undefined") {
    globalThis.IntersectionObserver = ObserversStub as unknown as typeof IntersectionObserver;
}

type QueryRoot = ReturnType<typeof within>;

/** Mount one fresh App and return a query object scoped to that render. */
function mountApp(): { root: QueryRoot; unmount: () => void } {
    const view = render(<App />);
    return { root: within(view.container), unmount: () => view.unmount() };
}

describe("the Bottom Panel shell", () => {
    it("renders the four views as tabs, the first selected by default", () => {
        const { root, unmount } = mountApp();
        for (const tab of BOTTOM_PANEL_TABS) {
            expect(root.getByRole("tab", { name: tab.label })).toBeTruthy();
        }
        // "output" is the default tab: it is the selected one.
        expect(root.getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
        expect(root.getByRole("tab", { name: "Build" }).getAttribute("aria-selected")).toBe("false");
        unmount();
    });

    it("switches the active view on a tab click", () => {
        const { root, unmount } = mountApp();
        act(() => {
            void root.getByRole("tab", { name: "Preview" }).click();
        });
        expect(root.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
        expect(root.getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("false");
        // The body presents the selected view's name.
        expect(root.getByRole("tabpanel").getAttribute("aria-label")).toBe("Preview");
        unmount();
    });

    it("collapses to a strip and reopens with the same default view", () => {
        const { root, unmount } = mountApp();
        act(() => {
            void root.getByRole("button", { name: "Collapse the bottom panel" }).click();
        });
        // Collapsed: the open panel and its control are gone; the re-open is present.
        expect(root.queryByRole("button", { name: "Collapse the bottom panel" })).toBeNull();
        act(() => {
            void root.getByRole("button", { name: "Expand the bottom panel" }).click();
        });
        // Reopened: the panel and its control are back.
        expect(root.getByRole("button", { name: "Collapse the bottom panel" })).toBeTruthy();
        expect(root.getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
        unmount();
    });

    it("exposes the pointer-resize handle on the panel's top edge", () => {
        const { root, unmount } = mountApp();
        const handle = root.getByRole("separator", { name: "Resize the bottom panel" });
        expect(handle).toBeTruthy();
        expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
        unmount();
    });

    it("keeps the panel state out of the Workspace semantic authority", () => {
        // Pure source pins (no render needed): the panel's presentation state
        // must not live in a DocumentSession or in the Workspace session /
        // store reducers.
        const documentSession = read("../src/document-session.ts");
        const workspaceSession = read("../src/workspace-session.ts");
        for (const source of [documentSession, workspaceSession]) {
            expect(source).not.toContain("bottomPanel");
            expect(source).not.toContain("panelHeight");
            expect(source).not.toContain("panelOpen");
        }
    });
});
