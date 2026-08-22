/**
 * Document session provenance — where the CURRENT document came from.
 *
 * This is the small but load-bearing invariant that keeps the Save
 * target consistent with the document's provenance:
 *
 *   a document opened from a file  → the session owns that path;
 *   a document imported from text  → the session owns NO path;
 *   the seeded startup document   → the session owns no path.
 *
 * Consequence a user will rely on: a plain Save may only write to the
 * path owned by the CURRENT document — it never inherits a previous
 * document's path, so an imported document can never silently overwrite
 * the last opened file. When no path is owned, the host asks for a
 * destination instead.
 *
 * (A richer session record — path, saved baseline, dirty state — will
 * grow out of this provenance as the desktop session model matures.)
 */

export type DocumentProvenance =
    | { readonly kind: "file"; readonly path: string }
    | { readonly kind: "imported" };

/** The current document came from this file path. */
export function provenanceFromFile(path: string): DocumentProvenance {
    return { kind: "file", path };
}

/** The current document was imported from text (or is the seeded one):
 * it owns no file path. */
export function provenanceFromImport(): DocumentProvenance {
    return { kind: "imported" };
}

/**
 * Target for a plain Save of the current document.
 *
 * - Save As (`as === true`) → always `null` (the host must pick);
 * - Save of a file-opened document → its owned path;
 * - Save of an imported/seeded document → `null` (the host must pick),
 *   NEVER a path left over from any other document.
 */
export function saveTarget(provenance: DocumentProvenance, as: boolean): string | null {
    if (as) {
        return null;
    }
    return provenance.kind === "file" ? provenance.path : null;
}
