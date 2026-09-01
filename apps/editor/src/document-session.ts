/**
 * Document session — the ephemeral identity, current document/history,
 * provenance, and saved baseline of one open editing context.
 *
 * Load-bearing invariants (kept in one place, so the UI and the close
 * guard both use the same rules):
 *
 *   a native document snapshot      → the session owns its host-issued
 *                                     canonical URI + revision token;
 *   a document imported from text   → the session owns NO save authority;
 *   the seeded startup document     → the session owns NO save authority.
 *
 *   dirty ⇔ serializeShaderGraphDocument(current) ≠ savedBaseline.
 *   Because the core's serialization is deterministic AND structurally
 *   stable (fixed field order, recursively sorted canonical JSON), a
 *   byte comparison over the two canonical forms is a comparison of the
 *   two document states — nothing else can make a document appear dirty,
 *   and no semantic change can stay invisible.
 *
 *   A plain Save may only present the authority and expected revision owned
 *   by the CURRENT document. A display path is provenance, never write
 *   authority, and an imported document can never silently overwrite a file
 *   that a previous document owned.
 */
import {
    createHistory,
    recordHistory,
    redoHistory,
    undoHistory,
    type DocumentHistory,
} from "@gglab/editor-ui";
import { serializeShaderGraphDocument, type ShaderGraphDocument } from "@gglab/shader-graph-core";
import type {
    CanonicalDocumentUri,
    DocumentSessionId,
    WorkspaceDocumentHandle,
} from "./workspace-session.js";
import type { DocumentSnapshot, FileRevisionToken } from "./host-io.js";

export type DocumentProvenance =
    | { readonly kind: "file"; readonly path: string }
    | { readonly kind: "imported" };

/** Display provenance for a document supplied by the native host. */
export function provenanceFromFile(path: string): DocumentProvenance {
    return { kind: "file", path };
}

/** The current document was imported from text (or is the seeded one):
 * it owns no file path. */
export function provenanceFromImport(): DocumentProvenance {
    return { kind: "imported" };
}

/**
 * The full editing context for one document. The current graph lives only in
 * `history.present`; keeping history and the persistence baseline in this
 * aggregate prevents active-document switching from pairing one document's
 * undo stack with another document's save state.
 */
export interface DocumentSession extends WorkspaceDocumentHandle {
    readonly sessionId: DocumentSessionId;
    /** Null until the native host supplies a canonical document URI. */
    readonly canonicalUri: CanonicalDocumentUri | null;
    /** Opaque revision of the snapshot on which local edits are based. */
    readonly fileRevisionToken: FileRevisionToken | null;
    readonly history: DocumentHistory<ShaderGraphDocument>;
    readonly provenance: DocumentProvenance;
    /** Canonical serialization of the document in its last saved /
     * last established state. */
    readonly savedBaseline: string;
}

export function createSession(
    sessionId: DocumentSessionId,
    provenance: DocumentProvenance,
    document: ShaderGraphDocument,
    canonicalUri: CanonicalDocumentUri | null = null,
    fileRevisionToken: FileRevisionToken | null = null,
): DocumentSession {
    if ((canonicalUri === null) !== (fileRevisionToken === null)) {
        throw new Error("A persisted DocumentSession requires both canonical URI and file revision token.");
    }
    return {
        sessionId,
        canonicalUri,
        fileRevisionToken,
        history: createHistory(document),
        provenance,
        savedBaseline: serializeShaderGraphDocument(document),
    };
}

/** Record one accepted authoring intent in this document's own history. */
export function recordDocumentChange(
    session: DocumentSession,
    document: ShaderGraphDocument,
    label: string,
): DocumentSession {
    const history = recordHistory(session.history, document, label);
    return history === session.history ? session : { ...session, history };
}

/** Move this document one history step back. */
export function undoDocumentChange(session: DocumentSession): DocumentSession {
    const history = undoHistory(session.history);
    return history === session.history ? session : { ...session, history };
}

/** Move this document one history step forward. */
export function redoDocumentChange(session: DocumentSession): DocumentSession {
    const history = redoHistory(session.history);
    return history === session.history ? session : { ...session, history };
}

/**
 * Apply a successful save to the editing context that initiated it.
 *
 * Saving is asynchronous. If another document became active before the write
 * completed, its session identity differs and the completion is stale for the
 * current context; it must not steal the URI, revision, or saved baseline.
 */
export function sessionSaved(
    session: DocumentSession,
    savedSessionId: DocumentSessionId,
    snapshot: DocumentSnapshot,
): DocumentSession {
    if (session.sessionId !== savedSessionId) {
        return session;
    }
    return {
        ...session,
        canonicalUri: snapshot.canonicalDocumentUri,
        fileRevisionToken: snapshot.fileRevisionToken,
        provenance: provenanceFromFile(snapshot.displayPath),
        savedBaseline: snapshot.text,
    };
}

/** Dirty: the current document's canonical bytes differ from the
 * baseline (a byte comparison over canonical forms = a structural
 * comparison, by the core's determinism). */
export function isDirty(session: DocumentSession): boolean {
    return serializeShaderGraphDocument(session.history.present) !== session.savedBaseline;
}

/**
 * Target for a plain Save of the current document.
 *
 * - Save As (`as === true`) → always `null` (the host must pick);
 * - Save of a host snapshot → its URI + expected revision capability;
 * - Save of an imported/seeded document → `null` (the host must pick),
 *   NEVER authority left over from any other document.
 */
export interface DocumentSaveTarget {
    readonly canonicalDocumentUri: CanonicalDocumentUri;
    readonly expectedFileRevisionToken: FileRevisionToken;
}

export function saveTarget(session: DocumentSession, as: boolean): DocumentSaveTarget | null {
    if (as) {
        return null;
    }
    if (session.canonicalUri === null || session.fileRevisionToken === null) {
        return null;
    }
    return {
        canonicalDocumentUri: session.canonicalUri,
        expectedFileRevisionToken: session.fileRevisionToken,
    };
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
