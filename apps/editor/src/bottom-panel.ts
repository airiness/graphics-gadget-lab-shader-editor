/**
 * The bottom panel's surface vocabulary and its drag-resize bounds.
 *
 * The bottom panel is a pure editor PRESENTATION container: it owns the
 * visible view (tab), the collapsed/open state, and the drag-resize height —
 * nothing else. Its four views project their owners' structured facts;
 * Output, Build, and Preview are CHRONOLOGICAL event projections, while
 * Problems is a REPLACEABLE current diagnostic snapshot. The panel never
 * adds, mirrors, or re-orders a Build, Preview, or Workspace authority —
 * it only presents what its owners already hold (the same rule the right
 * inspector already obeys: the badge/rows project, they do not own).
 *
 * The tab vocabulary and the height clamp live here, next to the inspector
 * zone vocabulary, so the clamp rule is unit-testable without React and the
 * composition root stays declarative.
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

/** Drag-resize bounds (px): the panel stays usable but can never consume
 *  the whole canvas. */
export const BOTTOM_PANEL_MIN_HEIGHT = 96;
export const BOTTOM_PANEL_MAX_HEIGHT = 480;
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 220;

/** Clamp a pointer-resize height into the supported range. A non-finite
 *  read (a degenerate event) falls back to the default rather than
 *  producing a broken layout. */
export function clampBottomPanelHeight(height: number): number {
    if (!Number.isFinite(height)) {
        return BOTTOM_PANEL_DEFAULT_HEIGHT;
    }
    return Math.min(BOTTOM_PANEL_MAX_HEIGHT, Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.round(height)));
}
