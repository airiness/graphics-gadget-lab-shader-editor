/**
 * The bottom panel's surface vocabulary and its drag-resize bounds.
 *
 * The bottom panel is a pure editor PRESENTATION container: it owns the
 * visible view (tab), the collapsed/open state, and the drag-resize height —
 * nothing else. Its four views will project their owners' structured facts —
 * Output, Build, and Preview are CHRONOLOGICAL event projections, while
 * Problems is a REPLACEABLE current diagnostic snapshot. The panel never
 * adds, mirrors, or re-orders a Build, Preview, or Workspace authority; it
 * only presents what its owners already hold (the same rule the right
 * inspector already obeys).
 *
 * Two layout rules are enforced here so the composition root stays
 * declarative and both are unit-testable without a browser:
 *  - the panel keeps the Canvas row above an explicit floor (the max is
 *    always capped by the body's CURRENT available height, not a fixed px);
 *  - a pointer-resize height is clamped into [min, effective max].
 *
 * The tab vocabulary and the floor/clamp rules live here (next to the
 * inspector zone vocabulary) for exactly that reason.
 */

export const BOTTOM_PANEL_TABS = [
    { id: "output", label: "Output" },
    { id: "build", label: "Build" },
    { id: "preview", label: "Preview" },
    { id: "problems", label: "Problems" },
] as const;

export type BottomPanelTab = (typeof BOTTOM_PANEL_TABS)[number]["id"];

/** The default label for a tab id (a lookup, so no index is assumed). */
export function bottomPanelTabLabel(tab: BottomPanelTab): string {
    return BOTTOM_PANEL_TABS.find((entry) => entry.id === tab)?.label ?? "Bottom panel";
}

/** The minimum the Canvas row must always retain (px) — the panel must
 *  never be able to press the Canvas away. */
export const CANVAS_MIN_FLOOR_HEIGHT = 240;

/** Drag-resize bounds (px): the panel stays usable. `BOTTOM_PANEL_MAX_HEIGHT`
 *  is only an absolute ceiling; the EFFECTIVE max is always lower, capped by
 *  the body's current available height minus the Canvas floor. */
export const BOTTOM_PANEL_MIN_HEIGHT = 96;
export const BOTTOM_PANEL_MAX_HEIGHT = 480;
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 220;

/** The keyboard step the resize handle moves the height by (px). */
export const BOTTOM_PANEL_KEYBOARD_STEP = 8;

/**
 * Resolve the EFFECTIVE maximum panel height for the CURRENT available height
 * of `.gglab-body` (the Canvas row + this panel). The Canvas row must keep at
 * least its floor, so the panel can never exceed `bodyHeight - floor`.
 *
 * Degenerate cases (the window is simply too small to hold BOTH a usable
 * panel and the Canvas floor, i.e. `bodyHeight < floor + min`):
 *  - the panel keeps its MINIMUM (the smallest height it is still usable at);
 *  - the Canvas row then receives whatever remains (`bodyHeight - min`), which
 *    in this case may be below the floor;
 *  - a non-finite body height (unmeasurable layout) falls back to the absolute
 *    ceiling.
 * This is an unavoidable trade-off — the panel cannot shrink past its minimum
 * without becoming unusable. In the product (minimum window ≈ 600px, so the
 * body ≈ 520px > floor + min = 336px) the body is always large enough that the
 * Canvas floor is honored in full; the degenerate path only exists to keep the
 * layout honest at sizes the product never reaches.
 */
export function resolvePanelMaxHeight(bodyHeight: number): number {
    if (!Number.isFinite(bodyHeight)) {
        return BOTTOM_PANEL_MAX_HEIGHT;
    }
    const byBody = bodyHeight - CANVAS_MIN_FLOOR_HEIGHT;
    return Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.min(BOTTOM_PANEL_MAX_HEIGHT, byBody));
}

/** Clamp a pointer-resize height into [min, effective max]. A non-finite
 *  read (a degenerate event) falls back to the default rather than a broken
 *  layout, still capped by the effective max. */
export function clampBottomPanelHeight(height: number, effectiveMax: number): number {
    const upper = Math.max(BOTTOM_PANEL_MIN_HEIGHT, effectiveMax);
    const value = Number.isFinite(height) ? Math.round(height) : BOTTOM_PANEL_DEFAULT_HEIGHT;
    return Math.min(upper, Math.max(BOTTOM_PANEL_MIN_HEIGHT, value));
}
