import { diagnosticFocus, type CanvasFocus } from "@gglab/editor-ui";
import { documentRevision, type DocumentSession } from "./document-session.js";
import type { ProblemSnapshotEntry } from "./panel-vocabulary.js";
import type { WorkspaceSession } from "./workspace-session.js";

export type ProblemNavigation =
    | { readonly available: false; readonly reason: string }
    | { readonly available: true; readonly document: DocumentSession; readonly focus: CanvasFocus | null; readonly detail: string };

/** Revalidate on activation, not just on render: an old dataPath index must
 * never select a different node after an edit or in a same-source document. */
export function resolveProblemNavigation(workspace: WorkspaceSession<DocumentSession>, entry: ProblemSnapshotEntry): ProblemNavigation {
    const id = entry.correlation.documentSessionId;
    if (id === null) return { available: false, reason: "No document ownership was recorded for this diagnostic." };
    const document = workspace.documents.find((candidate) => candidate.sessionId === id);
    if (document === undefined) return { available: false, reason: "The owning document is closed." };
    if (entry.correlation.documentRevision !== documentRevision(document)) {
        return { available: true, document, focus: null, detail: "Open owning document; diagnostic belongs to an older revision. Node navigation is unavailable." };
    }
    if (entry.location.kind === "graph") {
        const focus = diagnosticFocus(document.history.present, {
            code: entry.code ?? "", severity: entry.severity, message: entry.text, dataPath: entry.location.dataPath,
        });
        return { available: true, document, focus, detail: focus === null ? "Open owning document; this diagnostic has no canvas target." : "Show diagnostic in its owning document." };
    }
    // The published ToolDiagnostic contract has no structured line/column.
    // Even an exact source map cannot select a range without that location.
    return { available: true, document, focus: null, detail: "Open owning document; the tool did not report a structured line and column for node navigation." };
}
