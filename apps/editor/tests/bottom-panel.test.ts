/**
 * The bottom panel's pure surface vocabulary and its drag-resize clamp.
 * Headless by construction: no React, no authority — the tab ids/labels,
 * the label lookup, and the height clamp rule.
 */
import { describe, expect, it } from "vitest";
import {
    BOTTOM_PANEL_DEFAULT_HEIGHT,
    BOTTOM_PANEL_MAX_HEIGHT,
    BOTTOM_PANEL_MIN_HEIGHT,
    BOTTOM_PANEL_TABS,
    bottomPanelTabLabel,
    clampBottomPanelHeight,
} from "../src/bottom-panel.js";

describe("the bottom panel vocabulary", () => {
    it("names exactly the four views, in order", () => {
        expect(BOTTOM_PANEL_TABS.map((tab) => tab.id)).toEqual(["output", "build", "preview", "problems"]);
        expect(BOTTOM_PANEL_TABS.map((tab) => tab.label)).toEqual(["Output", "Build", "Preview", "Problems"]);
    });

    it("labels each tab by a lookup (no index is assumed)", () => {
        expect(bottomPanelTabLabel("output")).toBe("Output");
        expect(bottomPanelTabLabel("build")).toBe("Build");
        expect(bottomPanelTabLabel("preview")).toBe("Preview");
        expect(bottomPanelTabLabel("problems")).toBe("Problems");
    });

    it("keeps the default height inside the supported range", () => {
        expect(BOTTOM_PANEL_DEFAULT_HEIGHT).toBeGreaterThanOrEqual(BOTTOM_PANEL_MIN_HEIGHT);
        expect(BOTTOM_PANEL_DEFAULT_HEIGHT).toBeLessThanOrEqual(BOTTOM_PANEL_MAX_HEIGHT);
    });
});

describe("the drag-resize height clamp", () => {
    it("clamps below the minimum up to the minimum", () => {
        expect(clampBottomPanelHeight(1)).toBe(BOTTOM_PANEL_MIN_HEIGHT);
        expect(clampBottomPanelHeight(BOTTOM_PANEL_MIN_HEIGHT - 10)).toBe(BOTTOM_PANEL_MIN_HEIGHT);
    });

    it("clamps above the maximum down to the maximum", () => {
        expect(clampBottomPanelHeight(100000)).toBe(BOTTOM_PANEL_MAX_HEIGHT);
        expect(clampBottomPanelHeight(BOTTOM_PANEL_MAX_HEIGHT + 5)).toBe(BOTTOM_PANEL_MAX_HEIGHT);
    });

    it("keeps an in-range height, rounded to a whole pixel", () => {
        expect(clampBottomPanelHeight(150)).toBe(150);
        expect(clampBottomPanelHeight(150.4)).toBe(150);
        expect(clampBottomPanelHeight(150.6)).toBe(151);
    });

    it("falls back to the default for a non-finite read (never a broken layout)", () => {
        expect(clampBottomPanelHeight(Number.NaN)).toBe(BOTTOM_PANEL_DEFAULT_HEIGHT);
        expect(clampBottomPanelHeight(Number.POSITIVE_INFINITY)).toBe(BOTTOM_PANEL_DEFAULT_HEIGHT);
        expect(clampBottomPanelHeight(Number.NEGATIVE_INFINITY)).toBe(BOTTOM_PANEL_DEFAULT_HEIGHT);
    });
});
