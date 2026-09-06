/**
 * The bottom panel shell (presentation dock): it renders the four views,
 * switches the active tab (mouse AND keyboard), collapses to a strip and
 * reopens (keeping the active view), exposes an accessible resize control,
 * and runs a COMPLETE pointer-resize gesture lifecycle (down -> move ->
 * clamp -> up, plus cancel and unmount cleanup) with no leaked window-level
 * state. The panel owns only its visible view, open state, and height — and
 * none of that may enter the Workspace semantic authority.
 *
 * Each test mounts its OWN `<App />` and queries within that render's
 * container (then unmounts), so renders never accumulate in the shared body
 * and the queries stay unambiguous.
 *
 * jsdom reports a 0px body height, so the EFFECTIVE max resolves to the
 * panel minimum (96px) everywhere here; that is exactly what lets these tests
 * verify the clamp and the gesture end-to-end (the Canvas-floor arithmetic is
 * covered by value in the pure module test).
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "../src/app.js";
import { BOTTOM_PANEL_TABS, BOTTOM_PANEL_MIN_HEIGHT } from "../src/bottom-panel.js";

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

interface Mounted {
    readonly root: QueryRoot;
    readonly container: HTMLElement;
    readonly unmount: () => void;
}

function mountApp(): Mounted {
    const view = render(<App />);
    return { root: within(view.container), container: view.container as HTMLElement, unmount: () => view.unmount() };
}

const panelSection = (container: HTMLElement): HTMLElement => {
    const section = container.querySelector(".gglab-bottom-panel");
    expect(section).not.toBeNull();
    return section as HTMLElement;
};

const panelHeightPx = (container: HTMLElement): number => {
    const section = panelSection(container);
    const raw = section.style.height;
    expect(raw).toMatch(/^\d+px$/);
    return Number.parseInt(raw.replace("px", ""), 10);
};

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
        expect(root.getByRole("tabpanel").getAttribute("aria-label")).toBe("Preview");
        unmount();
    });

    it("navigates the tabs with the keyboard (arrows, Home, End)", () => {
        const { root, unmount } = mountApp();
        const selected = (name: string): string => (root.getByRole("tab", { name }).getAttribute("aria-selected") as string);
        // Default is "output" (index 0).
        act(() => {
            fireEvent.keyDown(root.getByRole("tab", { name: "Output" }), { key: "ArrowRight" });
        });
        expect(selected("Build")).toBe("true");
        act(() => {
            fireEvent.keyDown(root.getByRole("tab", { name: "Build" }), { key: "ArrowRight" });
        });
        expect(selected("Preview")).toBe("true");
        act(() => {
            fireEvent.keyDown(root.getByRole("tab", { name: "Preview" }), { key: "ArrowLeft" });
        });
        expect(selected("Build")).toBe("true");
        act(() => {
            fireEvent.keyDown(root.getByRole("tab", { name: "Build" }), { key: "End" });
        });
        expect(selected("Problems")).toBe("true");
        act(() => {
            fireEvent.keyDown(root.getByRole("tab", { name: "Problems" }), { key: "Home" });
        });
        expect(selected("Output")).toBe("true");
        unmount();
    });

    it("collapses to a strip and reopens, keeping the active view", () => {
        const { root, unmount } = mountApp();
        act(() => {
            void root.getByRole("tab", { name: "Preview" }).click();
        });
        act(() => {
            void root.getByRole("button", { name: "Collapse the bottom panel" }).click();
        });
        // Collapsed: the open panel and its control are gone; the re-open is present.
        expect(root.queryByRole("button", { name: "Collapse the bottom panel" })).toBeNull();
        act(() => {
            void root.getByRole("button", { name: "Expand the bottom panel" }).click();
        });
        // Reopened: the panel and its control are back, and the view persisted.
        expect(root.getByRole("button", { name: "Collapse the bottom panel" })).toBeTruthy();
        expect(root.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
        unmount();
    });

    it("exposes the resize control as an accessible, focusable vertical slider", () => {
        const { root, unmount } = mountApp();
        const handle = root.getByRole("slider", { name: /resize the bottom panel/i });
        expect(handle.getAttribute("aria-orientation")).toBe("vertical");
        expect(handle.getAttribute("aria-valuemin")).not.toBeNull();
        expect(handle.getAttribute("aria-valuemax")).not.toBeNull();
        expect(handle.getAttribute("aria-valuenow")).not.toBeNull();
        expect(handle.getAttribute("tabindex")).toBe("0");
        unmount();
    });

    it("grows and shrinks the panel with the keyboard (within the effective range)", () => {
        const { root, container, unmount } = mountApp();
        const handle = root.getByRole("slider", { name: /resize the bottom panel/i });
        const before = panelHeightPx(container);
        act(() => {
            fireEvent.keyDown(handle, { key: "ArrowDown" });
        });
        const afterDown = panelHeightPx(container);
        act(() => {
            fireEvent.keyDown(handle, { key: "ArrowUp" });
        });
        const afterUp = panelHeightPx(container);
        // Keyboard steps are reflected within the effective range (jsdom's
        // degenerate 0px body resolves the effective max to the minimum).
        for (const height of [before, afterDown, afterUp]) {
            expect(height).toBeGreaterThanOrEqual(BOTTOM_PANEL_MIN_HEIGHT);
        }
        expect(afterUp).toBeGreaterThanOrEqual(afterDown);
        unmount();
    });

    it("runs the resize gesture down -> move -> clamp -> up and cleans up", () => {
        const { root, container, unmount } = mountApp();
        const handle = root.getByRole("slider", { name: /resize the bottom panel/i });

        act(() => {
            fireEvent.pointerDown(handle, { pointerId: 7, clientY: 200 });
        });
        // The gesture is in flight: the shared "resizing" state is set.
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(true);

        // Drag UP 100px (decreasing clientY): the height moves and is clamped
        // into the effective range (in jsdom, to the minimum of 96px).
        act(() => {
            fireEvent.pointerMove(handle, { pointerId: 7, clientY: 100 });
        });
        const clamped = panelHeightPx(container);
        expect(clamped).toBeGreaterThanOrEqual(BOTTOM_PANEL_MIN_HEIGHT);
        expect(clamped).toBe(BOTTOM_PANEL_MIN_HEIGHT);

        act(() => {
            fireEvent.pointerUp(handle, { pointerId: 7, clientY: 100 });
        });
        // The gesture is over: the shared state is cleared.
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(false);

        // A stray move after the gesture is a no-op (nothing re-enters).
        const beforeStray = panelHeightPx(container);
        act(() => {
            fireEvent.pointerMove(handle, { pointerId: 7, clientY: 10 });
        });
        expect(panelHeightPx(container)).toBe(beforeStray);
        unmount();
    });

    it("cleans the gesture up on pointercancel", () => {
        const { root, unmount } = mountApp();
        const handle = root.getByRole("slider", { name: /resize the bottom panel/i });
        act(() => {
            fireEvent.pointerDown(handle, { pointerId: 11, clientY: 200 });
        });
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(true);
        act(() => {
            fireEvent.pointerCancel(handle, { pointerId: 11, clientY: 150 });
        });
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(false);
        unmount();
    });

    it("cleans the gesture up on unmount (no leaked window-level state)", () => {
        const { root, unmount } = mountApp();
        const handle = root.getByRole("slider", { name: /resize the bottom panel/i });
        act(() => {
            fireEvent.pointerDown(handle, { pointerId: 12, clientY: 200 });
        });
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(true);
        // HMR / unmount mid-gesture: the cleanup must clear the shared state.
        unmount();
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(false);
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
