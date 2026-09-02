/**
 * User-owned resolution state for a compare-and-swap save conflict.
 *
 * The exact local bytes and the originating DocumentSession identity travel
 * with the prompt. A later async choice must never serialize whichever
 * document happens to be active at that moment. The observed revision is an
 * opaque, single-use capability: it enables one deliberate overwrite attempt,
 * which is itself another compare-and-swap save.
 */
import type { FileRevisionToken } from "./host-io.js";
import type { CanonicalDocumentUri, DocumentSessionId } from "./workspace-session.js";

export type DocumentSaveConflictOrigin = "save" | "save-as";
export type DocumentSaveConflictAction = "reload" | "overwrite" | "save-as" | "cancel";

export interface PendingDocumentSaveConflict {
    readonly sessionId: DocumentSessionId;
    readonly origin: DocumentSaveConflictOrigin;
    readonly canonicalDocumentUri: CanonicalDocumentUri;
    readonly observedFileRevisionToken: FileRevisionToken | null;
    /** Another open editing context already owns this destination. */
    readonly destinationOwnerSessionId: DocumentSessionId | null;
    readonly localText: string;
    readonly defaultName: string;
}

/**
 * Ordered choices exposed by the prompt.
 *
 * Reload applies only to an already-open source file. Overwrite is available
 * only when the host observed an exact destination revision; a missing or
 * identity-invalidated file cannot be recreated through an unguarded write.
 * Save As always remains the non-destructive escape hatch.
 */
export function documentSaveConflictActions(
    conflict: PendingDocumentSaveConflict,
): readonly DocumentSaveConflictAction[] {
    const overwrite =
        conflict.observedFileRevisionToken === null ||
        conflict.destinationOwnerSessionId !== null
            ? []
            : (["overwrite"] satisfies readonly DocumentSaveConflictAction[]);
    return conflict.origin === "save"
        ? ["reload", ...overwrite, "save-as", "cancel"]
        : [...overwrite, "save-as", "cancel"];
}
