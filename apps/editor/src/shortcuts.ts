/**
 * Editor keyboard shortcuts — the classification of save shortcuts, as a
 * single pure authority (the app's keydown listener consults it; the
 * rule is testable without a DOM).
 *
 *   Ctrl/⌘+S        → Save
 *   Ctrl/⌘+Shift+S  → Save As
 */

/** The subset of a key event the classification needs. */
export interface KeyStateLike {
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly key: string;
}

/** Classify a key press as a save shortcut (or nothing else).
 * Alt (including AltGr-style combos that surface as ctrl+alt on
 * some keyboard layouts) is never a save shortcut. */
export function saveShortcutOf(ev: KeyStateLike): "save" | "save-as" | null {
    if (ev.altKey) {
        return null;
    }
    if (!ev.ctrlKey && !ev.metaKey) {
        return null;
    }
    if (ev.key !== "s" && ev.key !== "S") {
        return null;
    }
    return ev.shiftKey ? "save-as" : "save";
}
