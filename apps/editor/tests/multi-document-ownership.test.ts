/**
 * Multi-document ownership (guidance #4/#5, §12.1) — the invariants:
 *
 *   - each open DocumentSession owns its OWN selection / focus / emission /
 *     notes / text pane (presentation); a document change, undo, redo, or
 *     reload resets IT — never a sibling's;
 *   - opening a document is co-existing (two documents stay open, each with
 *     independent presentation and history);
 *   - switching the active tab never re-targets the explicit Preview target,
 *     and the Preview target is only ever moved by an explicit commit.
 *
 * These are pure (no React): they exercise the ownership contract the
 * composition root renders, so a UI regression that leaks one document's
 * state into another's fails here, not only in the GUI.
 */
import { describe, expect, it } from "vitest";
import {
    appendSessionNote,
    clearSessionNotes,
    createSession,
    isDirty,
    provenanceFromFile,
    recordDocumentChange,
    redoDocumentChange,
    sessionSaved,
    sessionReloaded,
    undoDocumentChange,
    type DocumentSession,
} from "../src/document-session.js";
import {
    activeWorkspaceDocument,
    activateWorkspaceDocument,
    commitWorkspacePreviewTarget,
    canonicalDocumentUriFromHost,
    createDocumentSessionId,
    createWorkspaceSession,
    openWorkspaceDocument,
    updateWorkspaceDocument,
    type WorkspaceSession,
} from "../src/workspace-session.js";
import { fileRevisionTokenFromHost, type DocumentSnapshot } from "../src/host-io.js";
import { serializeShaderGraphDocument, type ShaderGraphDocument } from "@gglab/shader-graph-core";

const DOC: ShaderGraphDocument = {
    schemaVersion: 1,
    graphId: "g",
    profile: "gglab.surface",
    profileVersion: 1,
    parameters: [],
    nodes: [],
    connections: [],
    editorMetadata: { nodes: {}, unknownFields: {} },
    unknownFields: {},
};

const CHANGED: ShaderGraphDocument = { ...DOC, graphId: "changed" };
const A_URI = canonicalDocumentUriFromHost("file:///C:/gglab/A.shadergraph");
const B_URI = canonicalDocumentUriFromHost("file:///C:/gglab/B.shadergraph");
const A_REV = fileRevisionTokenFromHost("revision-a");
const B_REV = fileRevisionTokenFromHost("revision-b");

function fileSession(
    sessionId: string,
    uri: ReturnType<typeof canonicalDocumentUriFromHost>,
    revision: ReturnType<typeof fileRevisionTokenFromHost>,
    path: string,
): DocumentSession {
    return createSession(
        createDocumentSessionId(sessionId),
        provenanceFromFile(path),
        DOC,
        uri,
        revision,
    );
}

function snapshot(uri: typeof A_URI, revision: typeof A_REV, path: string): DocumentSnapshot {
    return {
        canonicalDocumentUri: uri,
        displayPath: path,
        text: serializeShaderGraphDocument(DOC),
        fileRevisionToken: revision,
    };
}

describe("per-document presentation is owned by its DocumentSession", () => {
    it("a document change clears selection/focus/emission/notes but preserves the text pane", () => {
        const session = fileSession("s-a", A_URI, A_REV, "C:\\gglab\\A.shadergraph");
        const withState = updateWorkspaceDocument(
            createWorkspaceSession(),
            createWorkspaceSession().activeDocumentId ?? createDocumentSessionId("s-a"),
            () => session,
        );
        // (The workspace is only the vehicle; the contract is on the record.)
        const seeded = {
            ...session,
            presentation: {
                ...session.presentation,
                selectedNodeId: "node-1",
                focus: { nodeHighlights: [{ nodeId: "node-1", portIds: [] }], connectionHighlights: [] },
                emission: null,
                notes: ["a note"],
                savedText: "custom-text-pane",
            },
        };
        const changed = recordDocumentChange(seeded, CHANGED, "changed graph");
        expect(changed.presentation.selectedNodeId).toBeNull();
        expect(changed.presentation.focus).toBeNull();
        expect(changed.presentation.notes).toEqual([]);
        expect(changed.presentation.savedText).toBe("custom-text-pane"); // preserved
        expect(isDirty(changed)).toBe(true);
        expect(withState).toBeDefined();
    });

    it("undo and redo also reset this document's session-local presentation", () => {
        const base = fileSession("s-a", A_URI, A_REV, "C:\\gglab\\A.shadergraph");
        const changed = {
            ...recordDocumentChange(base, CHANGED, "changed graph"),
            presentation: {
                ...recordDocumentChange(base, CHANGED, "changed graph").presentation,
                selectedNodeId: "node-1",
                notes: ["arm"],
            },
        };
        const undone = undoDocumentChange(changed);
        expect(undone.presentation.selectedNodeId).toBeNull();
        expect(undone.presentation.notes).toEqual([]);
        const redone = redoDocumentChange(undone);
        expect(redone.presentation.selectedNodeId).toBeNull();
    });

    it("a reload resets the presentation and points the text pane at the reloaded document", () => {
        const base = fileSession("s-a", A_URI, A_REV, "C:\\gglab\\A.shadergraph");
        const external: ShaderGraphDocument = { ...DOC, graphId: "external" };
        const reloaded = sessionReloaded(
            base,
            base.sessionId,
            { canonicalDocumentUri: A_URI, displayPath: "C:\\gglab\\A.shadergraph", text: JSON.stringify(external), fileRevisionToken: A_REV },
            external,
        );
        expect(reloaded.presentation.selectedNodeId).toBeNull();
        expect(reloaded.presentation.savedText).toBe(serializeShaderGraphDocument(external));
        expect(isDirty(reloaded)).toBe(false);
    });

    it("a successful save refreshes this document's text pane and keeps its selection", () => {
        const base = fileSession("s-a", A_URI, A_REV, "C:\\gglab\\A.shadergraph");
        const withSelection = {
            ...base,
            presentation: { ...base.presentation, selectedNodeId: "node-1", savedText: "stale" },
        };
        const saved = sessionSaved(withSelection, withSelection.sessionId, snapshot(A_URI, A_REV, "C:\\gglab\\A.shadergraph"));
        expect(saved.presentation.selectedNodeId).toBe("node-1"); // a save does not retarget selection
        expect(saved.presentation.savedText).toBe(snapshot(A_URI, A_REV, "C:\\gglab\\A.shadergraph").text);
    });

    it("notes are appended and cleared per document (a sibling is never affected)", () => {
        const a = fileSession("s-a", A_URI, A_REV, "C:\\gglab\\A.shadergraph");
        const b = fileSession("s-b", B_URI, B_REV, "C:\\gglab\\B.shadergraph");
        const aNoted = appendSessionNote(a, "A's note");
        expect(aNoted.presentation.notes).toEqual(["A's note"]);
        expect(b.presentation.notes).toEqual([]); // untouched
        const aCleared = clearSessionNotes(aNoted);
        expect(aCleared.presentation.notes).toEqual([]);
        expect(aCleared).not.toBe(aNoted); // a distinct record, not the same instance
    });
});

describe("multi-open keeps each DocumentSession's presentation independent", () => {
    function twoOpenDocs(): { workspace: WorkspaceSession<DocumentSession>; a: DocumentSession; b: DocumentSession } {
        const a = fileSession("doc-a", A_URI, A_REV, "C:\\gglab\\A.shadergraph");
        const b = fileSession("doc-b", B_URI, B_REV, "C:\\gglab\\B.shadergraph");
        const openedA = openWorkspaceDocument(createWorkspaceSession<DocumentSession>(), a);
        if (openedA.accepted === false) {
            throw new Error(`opening doc-a was refused unexpectedly`);
        }
        const openedB = openWorkspaceDocument(openedA.workspace, b);
        if (openedB.accepted === false) {
            throw new Error(`opening doc-b was refused unexpectedly`);
        }
        return { workspace: openedB.workspace, a, b };
    }

    it("two documents coexist, each retaining its own selection and history", () => {
        const { workspace, a, b } = twoOpenDocs();
        expect(workspace.documents).toHaveLength(2);

        // Give document A a selection + note, then document B a different one.
        const withA = updateWorkspaceDocument(workspace, a.sessionId, (prev) => ({
            ...prev,
            presentation: { ...prev.presentation, selectedNodeId: "node-a", notes: ["note-a"] },
        }));
        const withBoth = updateWorkspaceDocument(withA.workspace, b.sessionId, (prev) => ({
            ...prev,
            presentation: { ...prev.presentation, selectedNodeId: "node-b", notes: ["note-b"] },
        }));
        expect(withA.accepted).toBe(true);
        expect(withBoth.accepted).toBe(true);
        const final = withBoth.workspace;

        // Each tab reads back ITS OWN presentation — no cross-document leak.
        const aFromWorkspace = final.documents.find((d) => d.sessionId === a.sessionId);
        const bFromWorkspace = final.documents.find((d) => d.sessionId === b.sessionId);
        expect(aFromWorkspace?.presentation.selectedNodeId).toBe("node-a");
        expect(aFromWorkspace?.presentation.notes).toEqual(["note-a"]);
        expect(bFromWorkspace?.presentation.selectedNodeId).toBe("node-b");
        expect(bFromWorkspace?.presentation.notes).toEqual(["note-b"]);
        // The active document is B (opened last / activated by the update),
        // yet A's state is intact and independent.
        expect(activeWorkspaceDocument(final)?.sessionId).toBe(b.sessionId);
    });
});

describe("switching tabs never re-targets the explicit Preview target", () => {
    it("the target survives a tab switch and is only moved by an explicit commit", () => {
        let workspace = createWorkspaceSession();
        const a = fileSession("doc-a", A_URI, A_REV, "C:\\gglab\\A.shadergraph");
        const b = fileSession("doc-b", B_URI, B_REV, "C:\\gglab\\B.shadergraph");
        workspace = openWorkspaceDocument(workspace, a).accepted ? openWorkspaceDocument(workspace, a).workspace : workspace;
        workspace = openWorkspaceDocument(workspace, b).accepted ? openWorkspaceDocument(workspace, b).workspace : workspace;

        // Explicitly target document A, then activate document B.
        const targeted = commitWorkspacePreviewTarget(workspace, a.sessionId);
        expect(targeted.accepted).toBe(true);
        const previewed = targeted.accepted ? targeted.workspace : workspace;
        const switched = activateWorkspaceDocument(previewed, b.sessionId);
        expect(switched.accepted).toBe(true);
        const afterSwitch = switched.accepted ? switched.workspace : previewed;

        expect(afterSwitch.activeDocumentId).toBe(b.sessionId); // editing B now
        expect(afterSwitch.preview.targetDocumentId).toBe(a.sessionId); // …but Preview still targets A

        // Only an explicit commit moves it to B.
        const retargeted = commitWorkspacePreviewTarget(afterSwitch, b.sessionId);
        expect(retargeted.accepted).toBe(true);
        const final = retargeted.accepted ? retargeted.workspace : afterSwitch;
        expect(final.preview.targetDocumentId).toBe(b.sessionId);
    });
});

describe("the canvas viewport is a per-document fact (pan/zoom never shared)", () => {
    const VP_A = { x: 111, y: 222, zoom: 1.6 };
    const VP_B = { x: 9, y: 8, zoom: 0.9 };
    function withViewport(session: DocumentSession, viewport: { x: number; y: number; zoom: number } | null): DocumentSession {
        return { ...session, presentation: { ...session.presentation, viewport } };
    }

    it("a document change / undo / redo carries the viewport (an edit does not move the view)", () => {
        const session = withViewport(fileSession("s-a", A_URI, A_REV, "C:\\gglab\\A.shadergraph"), VP_A);
        const changed = recordDocumentChange(session, CHANGED, "change");
        expect(changed.presentation.viewport).toStrictEqual(VP_A);
        const undone = undoDocumentChange(changed);
        expect(undone.presentation.viewport).toStrictEqual(VP_A);
        const redone = redoDocumentChange(undone);
        expect(redone.presentation.viewport).toStrictEqual(VP_A);
    });

    it("saving carries the viewport (a save does not change the view)", () => {
        const session = withViewport(fileSession("s-a", A_URI, A_REV, "C:\\gglab\\A.shadergraph"), VP_A);
        const snap: DocumentSnapshot = {
            canonicalDocumentUri: A_URI,
            displayPath: "C:\\gglab\\A.shadergraph",
            text: serializeShaderGraphDocument(DOC),
            fileRevisionToken: A_REV,
        };
        const saved = sessionSaved(session, session.sessionId, snap);
        expect(saved.presentation.viewport).toStrictEqual(VP_A);
    });

    it("a content replacement (reload) resets the viewport so the canvas re-fits the new content", () => {
        const session = withViewport(fileSession("s-a", A_URI, A_REV, "C:\\gglab\\A.shadergraph"), VP_A);
        const snap: DocumentSnapshot = {
            canonicalDocumentUri: A_URI,
            displayPath: "C:\\gglab\\A.shadergraph",
            text: serializeShaderGraphDocument(CHANGED),
            fileRevisionToken: A_REV,
        };
        const reloaded = sessionReloaded(session, session.sessionId, snap, CHANGED);
        expect(reloaded.presentation.viewport).toBeNull();
    });

    it("two open documents keep INDEPENDENT viewports (no shared pan/zoom)", () => {
        let workspace = createWorkspaceSession<DocumentSession>();
        const a = withViewport(fileSession("doc-a", A_URI, A_REV, "C:\\gglab\\A.shadergraph"), VP_A);
        const b = withViewport(fileSession("doc-b", B_URI, B_REV, "C:\\gglab\\B.shadergraph"), VP_B);
        const oa = openWorkspaceDocument(workspace, a);
        expect(oa.accepted).toBe(true);
        workspace = oa.workspace;
        const ob = openWorkspaceDocument(workspace, b);
        expect(ob.accepted).toBe(true);
        workspace = ob.workspace;

        const aFromWorkspace = workspace.documents.find((d) => d.sessionId === a.sessionId);
        const bFromWorkspace = workspace.documents.find((d) => d.sessionId === b.sessionId);
        expect(aFromWorkspace?.presentation.viewport).toStrictEqual(VP_A);
        expect(bFromWorkspace?.presentation.viewport).toStrictEqual(VP_B);
        // B is active (opened last) with its own view; A's view is intact and distinct.
        expect(activeWorkspaceDocument(workspace)?.sessionId).toBe(b.sessionId);
        expect(activeWorkspaceDocument(workspace)?.presentation.viewport).toStrictEqual(VP_B);
    });
});
