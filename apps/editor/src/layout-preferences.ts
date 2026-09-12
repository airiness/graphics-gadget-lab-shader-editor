import { BOTTOM_PANEL_MAX_HEIGHT, BOTTOM_PANEL_MIN_HEIGHT, BOTTOM_PANEL_TABS, type BottomPanelTab } from "./bottom-panel.js";

/** Presentation only. Native identities, paths and graph data are intentionally absent. */
export interface LayoutPreferences {
    readonly libraryOpen: boolean;
    readonly inspectorOpen: boolean;
    readonly bottomPanelOpen: boolean;
    readonly bottomPanelHeight: number;
    readonly bottomPanelTab: BottomPanelTab;
    readonly sidebarPanel: "explorer" | "nodes";
}
const keys = ["libraryOpen", "inspectorOpen", "bottomPanelOpen", "bottomPanelHeight", "bottomPanelTab", "sidebarPanel"];
export function readLayoutPreferences(value: unknown): LayoutPreferences {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected layout preferences object.");
    const data = value as Record<string, unknown>;
    if (Object.keys(data).length !== keys.length || Object.keys(data).some(key => !keys.includes(key)) ||
        typeof data.libraryOpen !== "boolean" || typeof data.inspectorOpen !== "boolean" || typeof data.bottomPanelOpen !== "boolean" ||
        typeof data.bottomPanelHeight !== "number" || !Number.isInteger(data.bottomPanelHeight) || data.bottomPanelHeight < BOTTOM_PANEL_MIN_HEIGHT || data.bottomPanelHeight > BOTTOM_PANEL_MAX_HEIGHT ||
        !BOTTOM_PANEL_TABS.some(tab => tab.id === data.bottomPanelTab) || (data.sidebarPanel !== "explorer" && data.sidebarPanel !== "nodes")) {
        throw new Error("Invalid layout preferences; refusing to reinterpret stored state.");
    }
    return { libraryOpen: data.libraryOpen, inspectorOpen: data.inspectorOpen, bottomPanelOpen: data.bottomPanelOpen,
        bottomPanelHeight: data.bottomPanelHeight, bottomPanelTab: data.bottomPanelTab as BottomPanelTab, sidebarPanel: data.sidebarPanel };
}
export interface LayoutPreferenceHost {
    readLayoutPreferences(): Promise<LayoutPreferences | null>;
    saveLayoutPreferences(layout: LayoutPreferences): Promise<void>;
}

/** Serializes/coalesces writes without restoring any Workspace or Runtime authority. */
export function bindLayoutPreferences(host: LayoutPreferenceHost, initial: LayoutPreferences, apply: (layout: LayoutPreferences) => void, report: (error: unknown) => void) {
    let current = initial, ready = false, disposed = false;
    let saved = JSON.stringify(initial), timer: ReturnType<typeof setTimeout> | undefined;
    let writes = Promise.resolve();
    const persist = () => {
        writes = writes.then(async () => {
            const snapshot = current, identity = JSON.stringify(snapshot);
            if (identity === saved) return;
            try { await host.saveLayoutPreferences(snapshot); saved = identity; }
            catch (error) { report(error); }
        });
    };
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(persist, 200);
    };
    const loaded = host.readLayoutPreferences().then(layout => {
        if (disposed) return;
        const unchanged = JSON.stringify(current) === JSON.stringify(initial);
        if (layout !== null) {
            saved = JSON.stringify(layout);
            if (unchanged) { current = layout; apply(layout); }
        }
        ready = true;
        if (JSON.stringify(current) !== saved) schedule();
    }).catch(error => { if (!disposed) report(error); });
    return {
        loaded,
        observe(layout: LayoutPreferences) { if (disposed) return; current = layout; if (ready) schedule(); },
        async dispose() { disposed = true; clearTimeout(timer); if (ready) persist(); await writes; },
    };
}
