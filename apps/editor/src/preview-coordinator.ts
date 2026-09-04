/**
 * Minimal PreviewCoordinator ownership rules (guidance §12.1, acceptance
 * intent #7/#8). The Runtime Preview composes from an EXPLICIT Preview
 * target, never from the editing (active) document:
 *
 *   - the Preview target is its own Workspace axis; the active document is
 *     the editing axis;
 *   - switching the active tab must not re-target the Runtime (the reducer
 *     enforces this — activation never touches `preview`);
 *   - "Preview This Graph" is the only retarget entry point;
 *   - closing a tab that is the target clears the target (reducer) and the
 *     caller completes the Runtime transition BEFORE the close.
 *
 * This module owns the target-resolution rule only: it is pure and has no
 * React/Tauri dependency, so the ownership decision is testable in
 * isolation. The actual Runtime lifecycle (stop/await the old attached
 * session before a new binding) is executed by the caller at the point where
 * these rules are applied.
 */
import type {
    WorkspaceDocumentHandle,
    WorkspaceSession,
} from "./workspace-session.js";

/** The DocumentSession the Runtime Preview composes from.
 *
 * The explicit Preview target is authoritative at ALL times. The reducer
 * guarantees the invariant: the first document a Workspace opens IS its
 * Preview target (seeded at open time, not followed live), a target close
 * re-seeds the surviving active document, and only "Preview This Graph"
 * commits a different one. The active-document fallback below is therefore
 * defensive only — reachable when no document is open — and never a live
 * re-coupling of the Preview to tab switching. */
export function resolvePreviewTarget<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
): TDocument | undefined {
    const targetId = workspace.preview.targetDocumentId ?? workspace.activeDocumentId;
    if (targetId === null) {
        return undefined;
    }
    return workspace.documents.find((candidate) => candidate.sessionId === targetId);
}

/** Whether an explicit Preview target is present. With the open/close seed
 * invariant this is true whenever any document is open; the UI surfaces the
 * target with the ▶ marker so a user can see WHICH tab the Runtime previews. */
export function hasExplicitPreviewTarget(
    workspace: WorkspaceSession<WorkspaceDocumentHandle>,
): boolean {
    return workspace.preview.targetDocumentId !== null;
}
