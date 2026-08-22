/**
 * Document session — where the CURRENT document came from, what its last
 * saved state was, and whether the current state differs from it.
 *
 * Load-bearing invariants (kept in one place, so the UI and the close
 * guard both use the same rules):
 *
 *   a document opened from a file   → the session owns that path;
 *   a document imported from text   → the session owns NO path;
 *   the seeded startup document    → the session owns no path.
 *
 *   dirty ⇔ serializeShaderGraphDocument(current) ≠ savedBaseline.
 *   Because the core's serialization is deterministic AND structurally
 *   stable (fixed field order, recursively sorted canonical JSON), a
 *   byte comparison over the two canonical forms is a comparison of the
 *   two document states — nothing else can make a document appear dirty,
 *   and no semantic change can stay invisible.
 *
 *   A plain Save may only write to the path owned by the CURRENT
 *   document — an imported document can never silently overwrite a file
 *   that a previous document owned.
 */
import { serializeShaderGraphDocument, type ShaderGraphDocument } from "@gglab/shader-graph-core";

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
 * The full session record for a document that just became current
 * (open, text import, or the seeded startup document): its provenance
 * and the canonical bytes of THIS state as the new baseline.
 */
export interface DocumentSession {
    readonly provenance: DocumentProvenance;
    /** Canonical serialization of the document in its last saved /
     * last established state. */
    readonly savedBaseline: string;
}

export function createSession(provenance: DocumentProvenance, document: ShaderGraphDocument): DocumentSession {
    return { provenance, savedBaseline: serializeShaderGraphDocument(document) };
}

/** A session established by a successful save of `savedBytes` to `path`. */
export function sessionSaved(path: string, savedBytes: string): DocumentSession {
    return { provenance: provenanceFromFile(path), savedBaseline: savedBytes };
}

/** Dirty: the current document's canonical bytes differ from the
 * baseline (a byte comparison over canonical forms = a structural
 * comparison, by the core's determinism). */
export function isDirty(document: ShaderGraphDocument, session: DocumentSession): boolean {
    return serializeShaderGraphDocument(document) !== session.savedBaseline;
}

/**
 * Target for a plain Save of the current document.
 *
 * - Save As (`as === true`) → always `null` (the host must pick);
 * - Save of a file-opened document → its owned path;
 * - Save of an imported/seeded document → `null` (the host must pick),
 *   NEVER a path left over from any other document.
 */
export function saveTarget(session: DocumentSession, as: boolean): string | null {
    if (as) {
        return null;
    }
    return session.provenance.kind === "file" ? session.provenance.path : null;
}

/**
 * The unsaved-close guard's decision, as a pure (testable) function:
 * the dialog offers Save / Don't Save / Cancel ("cancel" also covers an
 * unambiguous dismissal — anything not a positive choice); "save" may
 * then still fail, in which case the session must STAY (never close
 * with unsaved changes behind).
 */
export type CloseChoice = "save" | "discard" | "cancel";

export function closeAction(choice: CloseChoice, saveSucceeded: boolean): "close" | "stay" {
    if (choice === "cancel") {
        return "stay";
    }
    if (choice === "save") {
        return saveSucceeded ? "close" : "stay";
    }
    return "close"; // discard
}

/** Last path segment of a host file path (Windows or POSIX separators). */
export function basenameOf(path: string): string {
    const parts = path.split(/[\\/]/);
    const last = parts[parts.length - 1];
    return last === undefined || last === "" ? path : last;
}

/**
 * The window title: `GGLab Shader Graph Editor — MyShader.shadergraph`,
 * with a trailing ` *` while dirty (the star is the session's dirty
 * marker, same rule as the status bar).
 */
export function sessionTitle(session: DocumentSession, dirty: boolean): string {
    const base = "GGLab Shader Graph Editor";
    const name = session.provenance.kind === "file" ? basenameOf(session.provenance.path) : "Untitled";
    return `${base} — ${name}${dirty ? " *" : ""}`;
}
