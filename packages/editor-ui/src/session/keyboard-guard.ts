/**
 * Keyboard-shortcut guard — editor interaction infrastructure.
 *
 * Graph-level shortcuts (Delete/Backspace for the selected connection
 * today; Copy/Paste/Undo later) must stay quiet while the keyboard
 * belongs to a text field — the library search input, the document JSON
 * viewport, any future text control. Deleting a character there is the
 * field's business; it must never reach the graph.
 *
 * This is the ONE predicate every graph-level shortcut asks before it
 * acts, so the guard cannot drift per call site.
 */
export function isEditingTextTarget(target: EventTarget | null | undefined): boolean {
    if (target instanceof HTMLElement === false) {
        return false;
    }
    // Attribute-based contenteditable (any non-"false" value) as well as the
    // plain form controls — one predicate, no per-control branching.
    return target.closest("input, textarea, select, [contenteditable]") !== null;
}
