/**
 * The bottom panel's pure surface vocabulary and its resize rules.
 * Headless by construction: no React, no authority — the tab ids/labels,
 * the label lookup, the CANVAS-FLOOR height resolution, and the clamp rule.
 */
import { describe, expect, it } from "vitest";
import {
    BOTTOM_PANEL_DEFAULT_HEIGHT,
    BOTTOM_PANEL_KEYBOARD_STEP,
    BOTTOM_PANEL_MAX_HEIGHT,
    BOTTOM_PANEL_MIN_HEIGHT,
    BOTTOM_PANEL_TABS,
    CANVAS_MIN_FLOOR_HEIGHT,
    bottomPanelTabLabel,
    clampBottomPanelHeight,
    panelEffectiveMax,
    resolvePanelMaxHeight,
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

    it("uses a positive keyboard step smaller than the minimum height", () => {
        expect(BOTTOM_PANEL_KEYBOARD_STEP).toBeGreaterThan(0);
        expect(BOTTOM_PANEL_KEYBOARD_STEP).toBeLessThan(BOTTOM_PANEL_MIN_HEIGHT);
    });
});

describe("the Canvas-floor effective max", () => {
    it("caps the panel by the body's CURRENT height minus the Canvas floor", () => {
        // A 600px-tall body reserves the Canvas floor for the Canvas row.
        expect(resolvePanelMaxHeight(600)).toBe(600 - CANVAS_MIN_FLOOR_HEIGHT);
        // 880px body: 880 - 240 = 640, but the ABSOLUTE ceiling (480) wins.
        expect(resolvePanelMaxHeight(880)).toBe(BOTTOM_PANEL_MAX_HEIGHT);
    });

    it("guarantees the Canvas floor whenever the body can hold both", () => {
        // effectiveMax + floor <= bodyHeight is guaranteed by construction
        // (effectiveMax = body - floor, clamped up to the minimum only).
        for (const bodyHeight of [400, 500, 600, 720]) {
            const effectiveMax = resolvePanelMaxHeight(bodyHeight);
            expect(effectiveMax + CANVAS_MIN_FLOOR_HEIGHT).toBeLessThanOrEqual(bodyHeight);
            expect(effectiveMax).toBeGreaterThanOrEqual(BOTTOM_PANEL_MIN_HEIGHT);
            expect(effectiveMax).toBeLessThanOrEqual(BOTTOM_PANEL_MAX_HEIGHT);
        }
    });

    it("prioritizes the panel minimum over the Canvas floor in the degenerate case", () => {
        // 300px body is below floor + min (240 + 96 = 336): the panel keeps its
        // minimum (the smallest usable height) — never below 96px — and the
        // Canvas takes the remainder, which here is below the floor. This is the
        // documented trade-off; the product's minimum window never reaches it.
        expect(resolvePanelMaxHeight(300)).toBe(BOTTOM_PANEL_MIN_HEIGHT);
        expect(300 - BOTTOM_PANEL_MIN_HEIGHT).toBeLessThan(CANVAS_MIN_FLOOR_HEIGHT);
    });

    it("falls back to the absolute ceiling for a non-finite body height", () => {
        expect(resolvePanelMaxHeight(Number.NaN)).toBe(BOTTOM_PANEL_MAX_HEIGHT);
        expect(resolvePanelMaxHeight(Number.POSITIVE_INFINITY)).toBe(BOTTOM_PANEL_MAX_HEIGHT);
        expect(resolvePanelMaxHeight(Number.NEGATIVE_INFINITY)).toBe(BOTTOM_PANEL_MAX_HEIGHT);
    });
});

describe("the active max for a resize action", () => {
    it("treats an UNMEASURED body (null) as an unknown constraint, not 0px", () => {
        // Unknown constraint: only the absolute ceiling applies. This is what
        // keeps the current/default height from being pressed to the minimum
        // before the first real measurement arrives.
        expect(panelEffectiveMax(null)).toBe(BOTTOM_PANEL_MAX_HEIGHT);
        // A degenerate (non-finite) reading is likewise unknown, not small.
        expect(panelEffectiveMax(Number.NaN)).toBe(BOTTOM_PANEL_MAX_HEIGHT);
    });

    it("applies the Canvas floor once a valid measurement arrives", () => {
        expect(panelEffectiveMax(800)).toBe(BOTTOM_PANEL_MAX_HEIGHT);
        expect(panelEffectiveMax(400)).toBe(160);
        expect(panelEffectiveMax(300)).toBe(BOTTOM_PANEL_MIN_HEIGHT);
    });
});

describe("the panel height clamp", () => {
    it("clamps below the minimum up to the minimum", () => {
        expect(clampBottomPanelHeight(1, 480)).toBe(BOTTOM_PANEL_MIN_HEIGHT);
        expect(clampBottomPanelHeight(BOTTOM_PANEL_MIN_HEIGHT - 10, 480)).toBe(BOTTOM_PANEL_MIN_HEIGHT);
    });

    it("clamps above the EFFECTIVE max down to that max (not the absolute ceiling)", () => {
        expect(clampBottomPanelHeight(100000, 300)).toBe(300);
        expect(clampBottomPanelHeight(400, 300)).toBe(300);
    });

    it("keeps an in-range height, rounded to a whole pixel", () => {
        expect(clampBottomPanelHeight(150, 480)).toBe(150);
        expect(clampBottomPanelHeight(150.4, 480)).toBe(150);
        expect(clampBottomPanelHeight(150.6, 480)).toBe(151);
    });

    it("treats the effective max as the true ceiling even when it is below the default", () => {
        // The default (220) sits above a 180px effective max: any read is
        // capped at 180, and the default itself is clamped down too.
        expect(clampBottomPanelHeight(BOTTOM_PANEL_DEFAULT_HEIGHT, 180)).toBe(180);
    });

    it("falls back to the default for a non-finite read, capped by the effective max", () => {
        expect(clampBottomPanelHeight(Number.NaN, 480)).toBe(BOTTOM_PANEL_DEFAULT_HEIGHT);
        expect(clampBottomPanelHeight(Number.POSITIVE_INFINITY, 480)).toBe(BOTTOM_PANEL_DEFAULT_HEIGHT);
        // Even the non-finite fallback honors a low effective max.
        expect(clampBottomPanelHeight(Number.NaN, 180)).toBe(180);
    });
});
