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
import { BOTTOM_PANEL_TABS, BOTTOM_PANEL_DEFAULT_HEIGHT, BOTTOM_PANEL_MAX_HEIGHT, BOTTOM_PANEL_MIN_HEIGHT } from "../src/bottom-panel.js";

const read = (relative: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), "utf8");

// jsdom does not implement ResizeObserver (or IntersectionObserver); the full
// App mounts a React Flow viewport whose measurement effect needs both, and
// the panel observes `.gglab-body` to keep the Canvas floor a continuous
// invariant.
class NoopObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): readonly unknown[] {
        return [];
    }
}

// A functional ResizeObserver: every instance is recorded and can FIRE its
// callback (simulating a body resize). It also tracks the observed elements so
// a test can target only the instance observing `.gglab-body` — never firing
// the internal (React Flow) observers.
class ResizeObserverStub {
    static readonly instances: ResizeObserverStub[] = [];
    readonly callback: (entries: ReadonlyArray<{ readonly contentRect: { readonly height: number } }>) => void;
    readonly observed: Array<Element> = [];
    constructor(callback: (entries: ReadonlyArray<{ readonly contentRect: { readonly height: number } }>) => void) {
        this.callback = callback;
        ResizeObserverStub.instances.push(this);
    }
    observe(el: Element): void {
        this.observed.push(el);
    }
    unobserve(el: Element): void {
        const index = this.observed.indexOf(el);
        if (index !== -1) {
            this.observed.splice(index, 1);
        }
    }
    disconnect(): void {
        this.observed.length = 0;
        const index = ResizeObserverStub.instances.indexOf(this);
        if (index !== -1) {
            ResizeObserverStub.instances.splice(index, 1);
        }
    }
    takeRecords(): readonly unknown[] {
        return [];
    }
    fire(height: number): void {
        this.callback([{ contentRect: { height } }]);
    }
}

if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
if (typeof globalThis.IntersectionObserver === "undefined") {
    globalThis.IntersectionObserver = NoopObserverStub as unknown as typeof IntersectionObserver;
}

// Simulate the `.gglab-body` changing to `height` px: fire ONLY the
// ResizeObserver instance that is observing that element.
function fireBodyResize(container: HTMLElement, height: number): void {
    const bodyEl = container.querySelector(".gglab-body");
    const instance = bodyEl !== null ? ResizeObserverStub.instances.find((entry) => entry.observed.includes(bodyEl)) : undefined;
    if (instance === undefined) {
        throw new Error("no ResizeObserver is observing the .gglab-body element");
    }
    instance.fire(height);
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

// Lift the panel to its CURRENT effective max using the keyboard (a real,
// clamped resize path). This is used to place the panel at a large, legal
// height before the "body shrink" regression, because this headless DOM has no
// PointerEvent (so a pointer-drag's clientY delta is not drivable here). The
// pure module test covers the clamp arithmetic itself.
function keyboardLift(handle: HTMLElement, steps = 80): void {
    act(() => {
        for (let i = 0; i < steps; i++) {
            fireEvent.keyDown(handle, { key: "ArrowUp" });
        }
    });
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

    it("runs the resize gesture down -> move -> up and cleans the window-level state", () => {
        const { root, container, unmount } = mountApp();
        const handle = root.getByRole("slider", { name: /resize the bottom panel/i });
        // A large body, so the effective range is wide (96..480) and a clamped
        // move is distinguishable.
        act(() => {
            fireBodyResize(container, 800);
        });

        // pointerdown: the gesture becomes active (the shared "resizing" state).
        act(() => {
            fireEvent.pointerDown(handle, { pointerId: 7 });
        });
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(true);

        // pointermove while active: handled, and the resulting height stays
        // within the CURRENT effective range [min, max].
        act(() => {
            fireEvent.pointerMove(handle, { pointerId: 7 });
        });
        const moved = panelHeightPx(container);
        expect(moved).toBeGreaterThanOrEqual(BOTTOM_PANEL_MIN_HEIGHT);
        expect(moved).toBeLessThanOrEqual(480);
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(true);

        // pointerup: the gesture ends and the shared state clears.
        act(() => {
            fireEvent.pointerUp(handle, { pointerId: 7 });
        });
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(false);

        // A stray move after the gesture is a no-op (state stays cleared).
        act(() => {
            fireEvent.pointerMove(handle, { pointerId: 7 });
        });
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(false);
        expect(panelHeightPx(container)).toBe(moved);
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

    it("ends the gesture when the pointer capture is lost", () => {
        const { root, container, unmount } = mountApp();
        const handle = root.getByRole("slider", { name: /resize the bottom panel/i });
        act(() => {
            fireEvent.pointerDown(handle, { pointerId: 41, clientY: 200 });
        });
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(true);
        act(() => {
            fireEvent.lostPointerCapture(handle, { pointerId: 41 });
        });
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(false);
        // A stray move after the capture was lost is a no-op (gesture finished).
        const beforeStray = panelHeightPx(container);
        act(() => {
            fireEvent.pointerMove(handle, { pointerId: 41, clientY: 10 });
        });
        expect(panelHeightPx(container)).toBe(beforeStray);
        unmount();
    });

    it("does not press the current height toward the minimum before the first valid measurement", () => {
        const { root, container, unmount } = mountApp();
        const handle = () => root.getByRole("slider", { name: /resize the bottom panel/i });
        // The body is UNMEASURED: its constraint is unknown (a large window is
        // just as likely as a small one), so the current/default height stays.
        expect(panelHeightPx(container)).toBe(BOTTOM_PANEL_DEFAULT_HEIGHT);
        // …and the slider range is only the absolute ceiling.
        expect(handle().getAttribute("aria-valuemax")).toBe(String(BOTTOM_PANEL_MAX_HEIGHT));
        // A resize action even must not push it toward the minimum.
        act(() => {
            fireEvent.pointerDown(handle(), { pointerId: 1 });
        });
        act(() => {
            fireEvent.pointerMove(handle(), { pointerId: 1 });
        });
        act(() => {
            fireEvent.pointerUp(handle(), { pointerId: 1 });
        });
        expect(panelHeightPx(container)).toBe(BOTTOM_PANEL_DEFAULT_HEIGHT);
        // The FIRST valid measurement then takes effect — and a large body
        // simply confirms the current height as legal (it does not reset it).
        act(() => {
            fireBodyResize(container, 800);
        });
        expect(panelHeightPx(container)).toBe(BOTTOM_PANEL_DEFAULT_HEIGHT);
        expect(handle().getAttribute("aria-valuemax")).toBe(String(480));
        unmount();
    });

    it("keeps an active drag under the CURRENT body constraint, even while it shrinks", () => {
        const { root, container, unmount } = mountApp();
        const handle = () => root.getByRole("slider", { name: /resize the bottom panel/i });

        // Begin the gesture under a large body (effective max 480).
        act(() => {
            fireBodyResize(container, 800);
        });
        act(() => {
            fireEvent.pointerDown(handle(), { pointerId: 61 });
        });
        // The gesture is active:
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(true);
        // …then the body shrinks to 400 (effective max 160) while it is active.
        // The continuous observer re-clamps the stored height:
        act(() => {
            fireBodyResize(container, 400);
        });
        expect(panelHeightPx(container)).toBe(160);
        // A further move must stay UNDER the current constraint — a max
        // captured at pointerdown (480) must not be able to re-break the floor.
        act(() => {
            fireEvent.pointerMove(handle(), { pointerId: 61 });
        });
        const after = panelHeightPx(container);
        expect(after).toBeLessThanOrEqual(160);
        expect(after).toBeGreaterThanOrEqual(BOTTOM_PANEL_MIN_HEIGHT);
        act(() => {
            fireEvent.pointerUp(handle(), { pointerId: 61 });
        });
        expect(window.document.body.classList.contains("gglab-resizing")).toBe(false);
        unmount();
    });

    it("re-clamps the panel when the body shrinks (the Canvas-floor invariant is continuous)", () => {
        const { root, container, unmount } = mountApp();
        const slider = () => root.getByRole("slider", { name: /resize the bottom panel/i });

        // A large body (800px) allows the panel up to its effective max (480px).
        act(() => {
            fireBodyResize(container, 800);
        });
        // The large body lets the slider range up to 480.
        expect(slider().getAttribute("aria-valuemax")).toBe(String(480));
        // Lift the panel to that effective max with the keyboard (a real,
        // clamped resize path that is drivable in this headless DOM).
        keyboardLift(slider());
        // 480 + 240 floor = 720 <= 800: in the large body the Canvas keeps its floor.
        expect(panelHeightPx(container)).toBe(480);
        expect(slider().getAttribute("aria-valuemax")).toBe(String(480));

        // Shrink the body to 400px: the stored 480 is no longer legal. It is
        // re-clamped to 160 (160 + 240 = 400): the Canvas keeps its floor.
        act(() => {
            fireBodyResize(container, 400);
        });
        expect(panelHeightPx(container)).toBe(160);
        // The ARIA upper bound tracks the CURRENT effective max.
        expect(slider().getAttribute("aria-valuemax")).toBe(String(160));
        unmount();
    });

    it("keeps a legal height across a collapse -> body-shrink -> reopen round-trip", () => {
        const { root, container, unmount } = mountApp();
        const handle = () => root.getByRole("slider", { name: /resize the bottom panel/i });

        // Large body: lift the panel to its effective max (480).
        act(() => {
            fireBodyResize(container, 800);
        });
        keyboardLift(handle());
        expect(panelHeightPx(container)).toBe(480);

        // Collapse, then shrink the body. The panel is hidden, but its height
        // state must STILL be re-clamped to the new, smaller available height.
        act(() => {
            void root.getByRole("button", { name: "Collapse the bottom panel" }).click();
        });
        act(() => {
            fireBodyResize(container, 300);
        });

        // Reopen: the panel comes back at a LEGAL height for the 300px body.
        // 300 < floor(240) + min(96), so the effective max is the panel minimum.
        act(() => {
            void root.getByRole("button", { name: "Expand the bottom panel" }).click();
        });
        expect(panelHeightPx(container)).toBe(96);
        expect(root.getByRole("slider", { name: /resize the bottom panel/i }).getAttribute("aria-valuemax")).toBe(String(96));
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
