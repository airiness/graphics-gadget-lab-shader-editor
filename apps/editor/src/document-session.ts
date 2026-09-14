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
    type CanvasFocus,
    type DocumentHistory,
} from "@gglab/editor-ui";
import { emitHlsl, serializeShaderGraphDocument, type SurfaceProfileDescriptor, type ShaderGraphSourceMap, type HlslEmission, type ShaderGraphDocument } from "@gglab/shader-graph-core";
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
 * One open document's session-LOCAL presentation and evidence anchors.
 *
 * These are per-DocumentSession by the ownership model (guidance §4.4):
 * selection, the diagnostic focus, the active emission snapshot, and the
 * authoring notes belong to the document that produced them. A tab switch
 * must move between these records — it must never leave one document's
 * selection pointing at another document's nodes, or present one document's
 * emission as another document's. They are presentation, never graph
 * semantics: nothing here mutates the document, and clearing it (a
 * document change) never touches history.
 */
/** The canvas view state (pan/zoom) for one document. It is a per-document
 * presentation fact: switching tabs must restore each document's own view and
 * two documents must never share pan/zoom. */
export interface CanvasViewport {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
}

export interface DocumentSessionPresentation {
    /** The selected node id (session-local single-selection target). */
    readonly selectedNodeId: string | null;
    /** The selected connection id (exclusive with selectedNodeId). */
    readonly selectedConnectionId: string | null;
    /** The armed reconnection connection id (a pending gesture). */
    readonly reconnectArmed: string | null;
    /** The edge context-menu anchor (null = closed). */
    readonly edgeMenu: { readonly x: number; readonly y: number } | null;
    /** The node action-menu target + anchor (null = closed). */
    readonly nodeMenu: { readonly nodeId: string; readonly x: number; readonly y: number } | null;
    /** The diagnostic navigation focus the canvas highlights. */
    readonly focus: CanvasFocus | null;
    /** This document's emission snapshot (or `null` while none stands). */
    readonly emission: HlslEmission | null;
    /** This document's authoring notes (a chronological, replaceable list). */
    readonly notes: readonly string[];
    /** This document's .shadergraph text pane. Stable across authoring
     * (an edit does not rewrite it); reset on reload and set on save/open. */
    readonly savedText: string;
    /** This document's canvas view state (pan/zoom), or `null` until one is
     * captured (then the canvas fits to content). Carried across a document
     * change (an edit does not move the view); reset when the content is
     * replaced (reload) or a fresh document is created. */
    readonly viewport: CanvasViewport | null;
}

/** A fresh presentation: the volatile selection/focus/emission/notes are
 * empty, but the carried per-document facts (the text pane and the canvas
 * viewport) are preserved. A document change must not wipe that document's
 * text pane or move its pan/zoom; a content replacement passes `null` for the
 * viewport so the canvas re-fits the new content. */
export function emptyPresentation(
    savedText: string,
    viewport: CanvasViewport | null = null,
): DocumentSessionPresentation {
    return {
        selectedNodeId: null,
        selectedConnectionId: null,
        reconnectArmed: null,
        edgeMenu: null,
        nodeMenu: null,
        focus: null,
        emission: null,
        notes: [],
        savedText,
        viewport,
    };
}

/**
 * The full editing context for one document. The current graph lives only in
 * `history.present`; keeping history and the persistence baseline in this
 * aggregate prevents active-document switching from pairing one document's
 * undo stack with another document's save state.
 */
export interface DocumentSession extends WorkspaceDocumentHandle {
    readonly [evidenceOwner]: object;
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
    /** This document's session-local presentation and evidence anchors. */
    readonly presentation: DocumentSessionPresentation;
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
        [evidenceOwner]: newEvidenceOwner(sessionId, document),
        sessionId,
        canonicalUri,
        fileRevisionToken,
        history: createHistory(document),
        provenance,
        savedBaseline: serializeShaderGraphDocument(document),
        presentation: emptyPresentation(serializeShaderGraphDocument(document)),
    };
}

/** Record one accepted authoring intent in this document's own history.
 *
 * A genuine document move makes this document's selection, focus, and
 * emission stale (a selection on a node that may no longer exist, or an
 * emission of the prior revision): they are reset with it. A no-op (the
 * same document instance) changes nothing and returns the same aggregate. */
export function recordDocumentChange(
    session: DocumentSession,
    document: ShaderGraphDocument,
    label: string,
): DocumentSession {
    requireEvidenceOwner(session);
    const history = recordHistory(session.history, document, label);
    return history === session.history ? session : { ...session, [evidenceOwner]: newEvidenceOwner(session.sessionId, history.present), history, presentation: emptyPresentation(session.presentation.savedText, session.presentation.viewport) };
}

/** Move this document one history step back. The restored document's
 * session-local presentation is stale for the new revision — reset it. */
export function undoDocumentChange(session: DocumentSession): DocumentSession {
    requireEvidenceOwner(session);
    const history = undoHistory(session.history);
    return history === session.history ? session : { ...session, [evidenceOwner]: newEvidenceOwner(session.sessionId, history.present), history, presentation: emptyPresentation(session.presentation.savedText, session.presentation.viewport) };
}

/** Move this document one history step forward (same reset rule). */
export function redoDocumentChange(session: DocumentSession): DocumentSession {
    requireEvidenceOwner(session);
    const history = redoHistory(session.history);
    return history === session.history ? session : { ...session, [evidenceOwner]: newEvidenceOwner(session.sessionId, history.present), history, presentation: emptyPresentation(session.presentation.savedText, session.presentation.viewport) };
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
        // A save does not retarget selection; it does refresh this
        // document's text pane to the exact bytes that landed on disk.
        presentation: { ...session.presentation, savedText: snapshot.text },
    };
}

/**
 * Replace the current revision with a freshly read snapshot of the SAME file.
 *
 * Reload is a conflict-resolution action, not a new open: it preserves the
 * ephemeral session identity while discarding local history and establishing
 * the disk document as the new clean baseline. The host-returned URI must
 * match the URI requested by this session; reload may never silently retarget
 * an editing context.
 */
export function sessionReloaded(
    session: DocumentSession,
    reloadedSessionId: DocumentSessionId,
    snapshot: DocumentSnapshot,
    document: ShaderGraphDocument,
): DocumentSession {
    requireEvidenceOwner(session);
    if (session.sessionId !== reloadedSessionId) {
        return session;
    }
    if (session.canonicalUri !== snapshot.canonicalDocumentUri) {
        throw new Error("A reload snapshot must belong to the DocumentSession's canonical URI.");
    }
    return {
        ...session,
        fileRevisionToken: snapshot.fileRevisionToken,
        [evidenceOwner]: newEvidenceOwner(session.sessionId, document),
        history: createHistory(document),
        provenance: provenanceFromFile(snapshot.displayPath),
        // The graph reader may accept non-canonical input. Dirty state is a
        // comparison of canonical document states, so a successful reload is
        // clean even when the external writer used another JSON layout.
        savedBaseline: serializeShaderGraphDocument(document),
        // A new snapshot makes the prior revision's selection/focus/emission
        // stale for this document — reset the session-local presentation,
        // but the text pane now shows the reloaded document.
        presentation: emptyPresentation(serializeShaderGraphDocument(document)),
    };
}

/** Append one authoring note to THIS document's own note list (a refused
 * operation, a save event, or an explicit failure are recorded against the
 * session that saw them — never against whatever is active later). */
export function appendSessionNote(session: DocumentSession, note: string): DocumentSession {
    return { ...session, presentation: { ...session.presentation, notes: [...session.presentation.notes, note] } };
}

/** Clear this document's authoring notes. A genuine document change already
 * does this (see `recordDocumentChange`); an explicit dismissal calls it. */
export function clearSessionNotes(session: DocumentSession): DocumentSession {
    if (session.presentation.notes.length === 0) {
        return session;
    }
    return { ...session, presentation: { ...session.presentation, notes: [] } };
}

/** Dirty: the current document's canonical bytes differ from the
 * baseline (a byte comparison over canonical forms = a structural
 * comparison, by the core's determinism). */
export function isDirty(session: DocumentSession): boolean {
    return serializeShaderGraphDocument(session.history.present) !== session.savedBaseline;
}

/** The document's CURRENT authoring revision, as its canonical
 * serialization. The core's serialization is deterministic and structurally
 * stable (fixed field order, recursively sorted canonical JSON), so two
 * revisions compare equal exactly when their contents are the same document
 * state — a new authoring revision always produces a different one.
 *
 * Load-bearing for the close-the-Preview-target transition: that transition
 * must bind to the exact revision the user confirmed discarding. If a NEWER
 * revision exists by the time the commit runs, closing it would discard work
 * the user never confirmed — so the transition revalidates this revision
 * and refuses instead. */
export function documentRevision(session: DocumentSession): string {
    return serializeShaderGraphDocument(session.history.present);
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

// A spread may carry an owner token, but cannot rebind its document or identity.
const evidenceOwner: unique symbol = Symbol("document-evidence-owner");
const evidenceOwners = new WeakMap<object, { id: DocumentSessionId; revision: string; document: ShaderGraphDocument }>();
function newEvidenceOwner(id: DocumentSessionId, document: ShaderGraphDocument): object {
    const token = Object.freeze({});
    evidenceOwners.set(token, { id, revision: serializeShaderGraphDocument(document), document: structuredClone(document) });
    return token;
}
function requireEvidenceOwner(session: DocumentSession) {
    const owner = evidenceOwners.get(session[evidenceOwner]);
    if (owner === undefined || owner.id !== session.sessionId || owner.revision !== documentRevision(session)) {
        throw new Error("Document evidence origin must belong to the unchanged document owner");
    }
    return owner;
}
const evidenceOrigins = new WeakSet<object>();
const originConstructorKey = Object.freeze({});
/** Opaque, owner-produced projection; no caller-supplied emission or identity. */
export class DocumentEvidenceOrigin {
    private readonly opaque = true;
    private constructor(
        key: object,
        readonly documentSessionId: DocumentSessionId,
        readonly documentRevision: string,
        readonly sourceMap: ShaderGraphSourceMap,
    ) {
        if (key !== originConstructorKey) throw new Error("Document evidence origin requires its owner");
        evidenceOrigins.add(this); Object.freeze(this);
    }
    static isValid(value: DocumentEvidenceOrigin): boolean { return evidenceOrigins.has(value) && value.opaque; }
    static capture(session: DocumentSession, descriptor: SurfaceProfileDescriptor | null): DocumentEvidenceOrigin | null {
        const owner = requireEvidenceOwner(session);
        if (descriptor === null) return null;
        const emission = emitHlsl(owner.document, descriptor);
        if (!emission.ok || emission.sourceMap === null) return null;
        const map = structuredClone(emission.sourceMap);
        for (const range of map.ranges) Object.freeze(range);
        Object.freeze(map.ranges); Object.freeze(map);
        return new DocumentEvidenceOrigin(originConstructorKey, owner.id, owner.revision, map);
    }
}
export function isDocumentEvidenceOrigin(value: DocumentEvidenceOrigin): boolean {
    return DocumentEvidenceOrigin.isValid(value);
}
