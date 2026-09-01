/**
 * Workspace-level ownership of open document sessions.
 *
 * This module intentionally owns no graph semantics, filesystem traversal,
 * React state, or Runtime process. It establishes the product identity axes
 * that those adapters must use:
 *
 *   DocumentSessionId        -> one open editing context;
 *   CanonicalDocumentUri     -> one host-identified on-disk file;
 *   activeDocumentId         -> the tab being edited;
 *   preview.targetDocumentId -> the explicitly selected Preview target.
 *
 * A canonical URI is an opaque host fact. This reducer compares it for exact
 * equality and never lowercases, resolves, or otherwise guesses path rules in
 * the WebView. Persisted graphId and generated-source identity are deliberately
 * absent from the open-document key: two different files remain two sessions
 * even when either semantic identity is equal.
 */

declare const documentSessionIdBrand: unique symbol;
declare const canonicalDocumentUriBrand: unique symbol;

export type DocumentSessionId = string & {
    readonly [documentSessionIdBrand]: "DocumentSessionId";
};

export type CanonicalDocumentUri = string & {
    readonly [canonicalDocumentUriBrand]: "CanonicalDocumentUri";
};

/** Tag a caller-created ephemeral session identity after basic validation. */
export function createDocumentSessionId(value: string): DocumentSessionId {
    if (value.trim() === "") {
        throw new Error("A DocumentSessionId must not be empty.");
    }
    return value as DocumentSessionId;
}

/**
 * Accept a canonical URI returned by the native host.
 *
 * This function validates only the transport shape. It does not canonicalize a
 * user-supplied path and therefore must be called only on a host-owned result.
 */
export function canonicalDocumentUriFromHost(value: string): CanonicalDocumentUri {
    if (value.trim() === "") {
        throw new Error("A host-canonical document URI must not be empty.");
    }
    return value as CanonicalDocumentUri;
}

export interface WorkspaceDocumentHandle {
    readonly sessionId: DocumentSessionId;
    /** Null until an untitled/imported document is saved to a host-owned URI. */
    readonly canonicalUri: CanonicalDocumentUri | null;
}

export interface WorkspacePreviewTargetState {
    /** Explicit user intent. It is never derived from activeDocumentId. */
    readonly targetDocumentId: DocumentSessionId | null;
}

export interface WorkspaceSession<
    TDocument extends WorkspaceDocumentHandle = WorkspaceDocumentHandle,
> {
    /** The complete open-document records owned by this Workspace. */
    readonly documents: readonly TDocument[];
    readonly activeDocumentId: DocumentSessionId | null;
    readonly preview: WorkspacePreviewTargetState;
}

export function createWorkspaceSession<
    TDocument extends WorkspaceDocumentHandle = WorkspaceDocumentHandle,
>(): WorkspaceSession<TDocument> {
    return {
        documents: [],
        activeDocumentId: null,
        preview: { targetDocumentId: null },
    };
}

export type WorkspaceRefusal =
    | {
          readonly reason: "document-session-id-already-open";
          readonly documentSessionId: DocumentSessionId;
      }
    | {
          readonly reason: "document-not-open";
          readonly documentSessionId: DocumentSessionId;
      }
    | {
          readonly reason: "canonical-document-uri-already-open";
          readonly canonicalUri: CanonicalDocumentUri;
          readonly owningDocumentSessionId: DocumentSessionId;
      }
    | {
          readonly reason: "document-update-changed-session-id";
          readonly documentSessionId: DocumentSessionId;
          readonly returnedDocumentSessionId: DocumentSessionId;
      };

export type WorkspaceTransition<
    TDocument extends WorkspaceDocumentHandle = WorkspaceDocumentHandle,
> =
    | {
          readonly accepted: true;
          /** Same instance for an accepted no-op; a new instance for a change. */
          readonly workspace: WorkspaceSession<TDocument>;
      }
    | {
          readonly accepted: false;
          /** A refusal never mutates the input workspace. */
          readonly workspace: WorkspaceSession<TDocument>;
          readonly refusal: WorkspaceRefusal;
      };

export type OpenWorkspaceDocumentResult<
    TDocument extends WorkspaceDocumentHandle = WorkspaceDocumentHandle,
> =
    | {
          readonly accepted: true;
          readonly workspace: WorkspaceSession<TDocument>;
          readonly disposition: "opened" | "activated-existing";
          readonly documentSessionId: DocumentSessionId;
      }
    | {
          readonly accepted: false;
          readonly workspace: WorkspaceSession<TDocument>;
          readonly refusal: Extract<WorkspaceRefusal, { readonly reason: "document-session-id-already-open" }>;
      };

/**
 * Open one document editing context.
 *
 * Saved files de-duplicate only by the opaque host-canonical URI. Untitled
 * documents have no URI and therefore remain distinct by DocumentSessionId.
 * Opening an already-open file activates its existing session without moving
 * the Preview target.
 */
export function openWorkspaceDocument<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
    document: TDocument,
): OpenWorkspaceDocumentResult<TDocument> {
    const existingById = findDocument(workspace, document.sessionId);
    if (existingById !== undefined) {
        if (existingById.canonicalUri === document.canonicalUri) {
            return {
                accepted: true,
                workspace: activateExisting(workspace, existingById.sessionId),
                disposition: "activated-existing",
                documentSessionId: existingById.sessionId,
            };
        }
        return {
            accepted: false,
            workspace,
            refusal: {
                reason: "document-session-id-already-open",
                documentSessionId: document.sessionId,
            },
        };
    }

    if (document.canonicalUri !== null) {
        const existingByUri = workspace.documents.find(
            (candidate) => candidate.canonicalUri === document.canonicalUri,
        );
        if (existingByUri !== undefined) {
            return {
                accepted: true,
                workspace: activateExisting(workspace, existingByUri.sessionId),
                disposition: "activated-existing",
                documentSessionId: existingByUri.sessionId,
            };
        }
    }

    return {
        accepted: true,
        workspace: {
            ...workspace,
            documents: [...workspace.documents, document],
            activeDocumentId: document.sessionId,
        },
        disposition: "opened",
        documentSessionId: document.sessionId,
    };
}

/** Activate a tab without changing explicit Preview ownership. */
export function activateWorkspaceDocument<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
    documentSessionId: DocumentSessionId,
): WorkspaceTransition<TDocument> {
    if (findDocument(workspace, documentSessionId) === undefined) {
        return refusedDocumentNotOpen(workspace, documentSessionId);
    }
    return { accepted: true, workspace: activateExisting(workspace, documentSessionId) };
}

/**
 * Commit the explicit Preview target without changing the active tab.
 *
 * This reducer owns the final target selection only. When a live Runtime is
 * attached, the PreviewCoordinator must stop/await the old ownership binding
 * before it commits this transition.
 */
export function commitWorkspacePreviewTarget<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
    documentSessionId: DocumentSessionId | null,
): WorkspaceTransition<TDocument> {
    if (documentSessionId !== null && findDocument(workspace, documentSessionId) === undefined) {
        return refusedDocumentNotOpen(workspace, documentSessionId);
    }
    if (workspace.preview.targetDocumentId === documentSessionId) {
        return { accepted: true, workspace };
    }
    return {
        accepted: true,
        workspace: {
            ...workspace,
            preview: { targetDocumentId: documentSessionId },
        },
    };
}

/**
 * Bind an untitled/imported session to the canonical URI returned by Save As.
 * A URI already owned by another open session is a conflict, never an implicit
 * merge of two editing contexts.
 */
export function bindWorkspaceDocumentUri<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
    documentSessionId: DocumentSessionId,
    canonicalUri: CanonicalDocumentUri,
): WorkspaceTransition<TDocument> {
    const document = findDocument(workspace, documentSessionId);
    if (document === undefined) {
        return refusedDocumentNotOpen(workspace, documentSessionId);
    }
    const existingOwner = workspace.documents.find(
        (candidate) => candidate.canonicalUri === canonicalUri && candidate.sessionId !== documentSessionId,
    );
    if (existingOwner !== undefined) {
        return {
            accepted: false,
            workspace,
            refusal: {
                reason: "canonical-document-uri-already-open",
                canonicalUri,
                owningDocumentSessionId: existingOwner.sessionId,
            },
        };
    }
    if (document.canonicalUri === canonicalUri) {
        return { accepted: true, workspace };
    }
    return {
        accepted: true,
        workspace: {
            ...workspace,
            documents: workspace.documents.map((candidate) =>
                candidate.sessionId === documentSessionId
                    ? { ...candidate, canonicalUri }
                    : candidate,
            ),
        },
    };
}

/** Return the complete active document record, or null for an empty Workspace. */
export function activeWorkspaceDocument<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
): TDocument | null {
    if (workspace.activeDocumentId === null) {
        return null;
    }
    return findDocument(workspace, workspace.activeDocumentId) ?? null;
}

/**
 * Update one open document by its ephemeral session identity.
 *
 * The reducer preserves Workspace ownership invariants around the update:
 * document identity cannot change, and a changed canonical URI cannot collide
 * with another open document. This is the route for history, baseline,
 * selection, diagnostics, and other per-document state updates once their
 * complete records are stored in `WorkspaceSession.documents`.
 */
export function updateWorkspaceDocument<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
    documentSessionId: DocumentSessionId,
    update: (document: TDocument) => TDocument,
): WorkspaceTransition<TDocument> {
    const index = workspace.documents.findIndex((candidate) => candidate.sessionId === documentSessionId);
    const current = workspace.documents[index];
    if (index < 0 || current === undefined) {
        return refusedDocumentNotOpen(workspace, documentSessionId);
    }

    const next = update(current);
    if (next.sessionId !== documentSessionId) {
        return {
            accepted: false,
            workspace,
            refusal: {
                reason: "document-update-changed-session-id",
                documentSessionId,
                returnedDocumentSessionId: next.sessionId,
            },
        };
    }
    if (next === current) {
        return { accepted: true, workspace };
    }
    if (next.canonicalUri !== null) {
        const existingOwner = workspace.documents.find(
            (candidate) =>
                candidate.canonicalUri === next.canonicalUri &&
                candidate.sessionId !== documentSessionId,
        );
        if (existingOwner !== undefined) {
            return {
                accepted: false,
                workspace,
                refusal: {
                    reason: "canonical-document-uri-already-open",
                    canonicalUri: next.canonicalUri,
                    owningDocumentSessionId: existingOwner.sessionId,
                },
            };
        }
    }

    const documents = [...workspace.documents];
    documents[index] = next;
    return {
        accepted: true,
        workspace: { ...workspace, documents },
    };
}

/**
 * Remove one open context. Closing the Preview target clears Preview ownership.
 * Closing the active tab chooses the next tab at that index, then the previous
 * tab, deterministically; closing another tab leaves the active tab untouched.
 * The caller must complete unsaved-change handling and Preview Runtime teardown
 * before committing this final close transition.
 */
export function closeWorkspaceDocument<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
    documentSessionId: DocumentSessionId,
): WorkspaceTransition<TDocument> {
    const index = workspace.documents.findIndex((candidate) => candidate.sessionId === documentSessionId);
    if (index < 0) {
        return refusedDocumentNotOpen(workspace, documentSessionId);
    }
    const documents = workspace.documents.filter((candidate) => candidate.sessionId !== documentSessionId);
    const activeDocumentId =
        workspace.activeDocumentId === documentSessionId
            ? (documents[index]?.sessionId ?? documents[index - 1]?.sessionId ?? null)
            : workspace.activeDocumentId;
    const targetDocumentId =
        workspace.preview.targetDocumentId === documentSessionId
            ? null
            : workspace.preview.targetDocumentId;
    return {
        accepted: true,
        workspace: {
            ...workspace,
            documents,
            activeDocumentId,
            preview:
                targetDocumentId === workspace.preview.targetDocumentId
                    ? workspace.preview
                    : { targetDocumentId },
        },
    };
}

function findDocument<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
    documentSessionId: DocumentSessionId,
): TDocument | undefined {
    return workspace.documents.find((candidate) => candidate.sessionId === documentSessionId);
}

function activateExisting<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
    documentSessionId: DocumentSessionId,
): WorkspaceSession<TDocument> {
    return workspace.activeDocumentId === documentSessionId
        ? workspace
        : { ...workspace, activeDocumentId: documentSessionId };
}

function refusedDocumentNotOpen<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
    documentSessionId: DocumentSessionId,
): Extract<WorkspaceTransition<TDocument>, { readonly accepted: false }> {
    return {
        accepted: false,
        workspace,
        refusal: { reason: "document-not-open", documentSessionId },
    };
}
