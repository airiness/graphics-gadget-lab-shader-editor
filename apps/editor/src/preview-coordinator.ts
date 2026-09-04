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
 * The explicit Preview target is authoritative. Before the user has ever
 * chosen one explicitly, the active document is the bootstrap default so a
 * single seeded document previews out of the box; once a target is chosen it
 * is pinned until the next explicit retarget or a target close. */
export function resolvePreviewTarget<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
): TDocument | undefined {
    const targetId = workspace.preview.targetDocumentId ?? workspace.activeDocumentId;
    if (targetId === null) {
        return undefined;
    }
    return workspace.documents.find((candidate) => candidate.sessionId === targetId);
}

/** Whether an explicit Preview target is present (as opposed to the active
 * document being used only as a bootstrap default). The UI surfaces the
 * explicit target with the ▶ marker; a bootstrap default is not surfaced as
 * a deliberate ownership claim. */
export function hasExplicitPreviewTarget(
    workspace: WorkspaceSession<WorkspaceDocumentHandle>,
): boolean {
    return workspace.preview.targetDocumentId !== null;
}
