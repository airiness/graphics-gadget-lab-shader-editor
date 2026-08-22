/**
 * The single geometric system of the canvas card. This module is the ONLY
 * place the node-card numbers live: the port row rhythm, the handle
 * position/size, and the node card footprint are all derived from one
 * object, so the handle center, the port-row vertical center, and the
 * React Flow edge anchor all agree by construction (xyflow anchors an edge
 * to the measured handle, which sits on the shared `portCenterY`).
 *
 * The presentation side (CSS) consumes these same numbers as custom
 * properties injected from `flowGeometryCssVars()`, so the CSS and the TS
 * projection cannot drift: there is one source of truth here, and both
 * sides reference it. Tests lock the invariants that the whole system
 * depends on (handle center == port center; rows are monotonic).
 */
import type { CSSProperties } from "react";

export interface FlowGeometry {
    /** Node card content width. */
    readonly nodeWidth: number;
    /** Card header block (title + meta + optional unknown flag). */
    readonly headerHeight: number;
    /** One port row. */
    readonly portRowHeight: number;
    /** Handle dot diameter. */
    readonly handleSize: number;
    /** How far a Handle sits outside the card border along its axis. */
    readonly handleInset: number;
    /** Breathing room under the last port row. */
    readonly rowsBottomPad: number;
    /** Card top/bottom content padding around the header and rows. */
    readonly headerPadTop: number;
    readonly headerPadLeft: number;
    readonly headerPadRight: number;
    readonly grid: { readonly startX: number; readonly startY: number; readonly columnWidth: number; readonly rowHeight: number; readonly columns: number };
}

export const FLOW_GEOMETRY: FlowGeometry = {
    nodeWidth: 200,
    headerHeight: 56,
    portRowHeight: 26,
    handleSize: 10,
    handleInset: 7,
    rowsBottomPad: 10,
    headerPadTop: 9,
    headerPadLeft: 15,
    headerPadRight: 12,
    grid: { startX: 60, startY: 60, columnWidth: 340, rowHeight: 236, columns: 3 },
};

/** Number of rendered port rows for a node. */
export function portRowCount(inputPorts: number, outputPorts: number): number {
    return Math.max(inputPorts, outputPorts, 1);
}

/** Top of port row `index` (card-local Y). */
export function portRowTop(index: number, g: FlowGeometry = FLOW_GEOMETRY): number {
    return g.headerHeight + index * g.portRowHeight;
}

/** Vertical center line of port row `index` — the shared axis for the
 * handle and (via xyflow's measured handle) the edge anchor. */
export function portCenterY(index: number, g: FlowGeometry = FLOW_GEOMETRY): number {
    return portRowTop(index, g) + g.portRowHeight / 2;
}

/** Inline `top` that centers a Handle on its port row. */
export function handleTop(index: number, g: FlowGeometry = FLOW_GEOMETRY): number {
    return portCenterY(index, g) - g.handleSize / 2;
}

/** Full node-card height for a given number of port rows. */
export function nodeCardHeight(rows: number, g: FlowGeometry = FLOW_GEOMETRY): number {
    return g.headerHeight + rows * g.portRowHeight + g.rowsBottomPad;
}

/**
 * The geometry as CSS custom properties, so the stylesheet references the
 * same single source of truth instead of re-declaring the numbers.
 */
export function flowGeometryCssVars(g: FlowGeometry = FLOW_GEOMETRY): CSSProperties {
    return {
        "--gglab-geom-node-w": `${g.nodeWidth}px`,
        "--gglab-geom-header-h": `${g.headerHeight}px`,
        "--gglab-geom-row-h": `${g.portRowHeight}px`,
        "--gglab-geom-handle-s": `${g.handleSize}px`,
        "--gglab-geom-inset": `${g.handleInset}px`,
        "--gglab-geom-rows-pad": `${g.rowsBottomPad}px`,
        "--gglab-geom-pad-top": `${g.headerPadTop}px`,
        "--gglab-geom-pad-left": `${g.headerPadLeft}px`,
        "--gglab-geom-pad-right": `${g.headerPadRight}px`,
    } as CSSProperties;
}
