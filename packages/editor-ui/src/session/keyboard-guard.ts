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
    if (target.closest("input, textarea, select") !== null) {
        return true;
    }
    // A contenteditable region — but one that is actually EDITABLE. The
    // attribute also exists with a "false" value (read-only rich text),
    // and that is not an editing surface.
    const region = target.closest("[contenteditable]");
    if (region === null) {
        return false;
    }
    return region.getAttribute("contenteditable") !== "false";
}
