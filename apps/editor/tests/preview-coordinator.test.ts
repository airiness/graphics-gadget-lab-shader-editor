/**
 * PreviewCoordinator ownership (guidance §12.1, acceptance intent #7/#8).
 * The Runtime Preview composes from the EXPLICIT Preview target — a distinct
 * Workspace axis — never from the active (editing) document:
 *
 *   - the target survives a tab switch (switching only moves the active);
 *   - retarget moves it ("Preview This Graph" is the only retarget path);
 *   - closing a tab that is the target clears it (and the caller completes
 *     the Runtime transition before the close);
 *   - before an explicit target is chosen, the active document is the
 *     bootstrap default for a single seeded document.
 *
 * Pure: no React, no Tauri. The resolution rule is the ownership decision;
 * these tests lock it so a UI regression that re-couples the preview to the
 * active document fails here.
 */
import { describe, expect, it } from "vitest";
import {
    createSession,
    provenanceFromFile,
    type DocumentSession,
} from "../src/document-session.js";
import {
    activateWorkspaceDocument,
    canonicalDocumentUriFromHost,
    closeWorkspaceDocument,
    commitWorkspacePreviewTarget,
    createDocumentSessionId,
    createWorkspaceSession,
    openWorkspaceDocument,
    type WorkspaceSession,
} from "../src/workspace-session.js";
import { fileRevisionTokenFromHost } from "../src/host-io.js";
import {
    hasExplicitPreviewTarget,
    resolvePreviewTarget,
} from "../src/preview-coordinator.js";
import { type ShaderGraphDocument } from "@gglab/shader-graph-core";

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

function fileDoc(
    sessionId: string,
    uri: ReturnType<typeof canonicalDocumentUriFromHost>,
    rev: ReturnType<typeof fileRevisionTokenFromHost>,
    path: string,
): DocumentSession {
    return createSession(createDocumentSessionId(sessionId), provenanceFromFile(path), DOC, uri, rev);
}

function twoOpen(): { workspace: WorkspaceSession<DocumentSession>; a: DocumentSession; b: DocumentSession } {
    const a = fileDoc("doc-a", canonicalDocumentUriFromHost("file:///C:/gglab/A.shadergraph"), fileRevisionTokenFromHost("rev-a"), "C:\\gglab\\A.shadergraph");
    const b = fileDoc("doc-b", canonicalDocumentUriFromHost("file:///C:/gglab/B.shadergraph"), fileRevisionTokenFromHost("rev-b"), "C:\\gglab\\B.shadergraph");
    let workspace = createWorkspaceSession<DocumentSession>();
    const oa = openWorkspaceDocument(workspace, a);
    if (oa.accepted === false) throw new Error("open a refused");
    workspace = oa.workspace;
    const ob = openWorkspaceDocument(workspace, b);
    if (ob.accepted === false) throw new Error("open b refused");
    workspace = ob.workspace;
    return { workspace, a, b };
}

describe("resolvePreviewTarget — the Runtime composes from the explicit target", () => {
    it("the first opened document is the Preview target from the start (explicit from the first OPEN, never a live active-follow)", () => {
        const { workspace, a, b } = twoOpen();
        // The fixture opens A first, then B: B is the active tab, but an
        // EXPLICIT Preview target already exists — it was seeded at the first
        // open (a one-time ownership decision), not derived from the active
        // tab. A later open / activation never moves it.
        expect(workspace.activeDocumentId).toBe(b.sessionId);
        expect(hasExplicitPreviewTarget(workspace)).toBe(true);
        const resolved = resolvePreviewTarget(workspace);
        expect(resolved?.sessionId).toBe(a.sessionId);
    });

    it("an explicit target is pinned even when the active tab differs", () => {
        const { workspace, a, b } = twoOpen();
        // Explicitly target A.
        const targeted = commitWorkspacePreviewTarget(workspace, a.sessionId);
        expect(targeted.accepted).toBe(true);
        const withTarget = targeted.accepted ? targeted.workspace : workspace;
        // Now activate B (editing B) — the target must stay A.
        const switched = activateWorkspaceDocument(withTarget, b.sessionId);
        expect(switched.accepted).toBe(true);
        const afterSwitch = switched.accepted ? switched.workspace : withTarget;
        expect(afterSwitch.activeDocumentId).toBe(b.sessionId);
        expect(resolvePreviewTarget(afterSwitch)?.sessionId).toBe(a.sessionId);
        expect(hasExplicitPreviewTarget(afterSwitch)).toBe(true);
    });

    it("retarget moves the resolved target; a second retarget moves it again", () => {
        const { workspace, a, b } = twoOpen();
        const t1 = commitWorkspacePreviewTarget(workspace, a.sessionId);
        expect(t1.accepted).toBe(true);
        const w1 = t1.accepted ? t1.workspace : workspace;
        expect(resolvePreviewTarget(w1)?.sessionId).toBe(a.sessionId);
        // Retarget to B (the only way to move it).
        const t2 = commitWorkspacePreviewTarget(w1, b.sessionId);
        expect(t2.accepted).toBe(true);
        const w2 = t2.accepted ? t2.workspace : w1;
        expect(resolvePreviewTarget(w2)?.sessionId).toBe(b.sessionId);
    });

    it("closing a tab that is the target RE-SEEDS it onto the surviving active (no live fallback); closing a non-target keeps it", () => {
        const { workspace, a, b } = twoOpen();
        // Target A, close A → ownership re-seeds, as a one-time close-time
        // decision, onto the surviving active document (B). It is still an
        // explicit target — never a live re-coupling to whatever tab is open.
        const tA = commitWorkspacePreviewTarget(workspace, a.sessionId);
        expect(tA.accepted).toBe(true);
        const wA = tA.accepted ? tA.workspace : workspace;
        const cA = closeWorkspaceDocument(wA, a.sessionId);
        expect(cA.accepted).toBe(true);
        const afterCloseA = cA.accepted ? cA.workspace : wA;
        expect(hasExplicitPreviewTarget(afterCloseA)).toBe(true);
        expect(afterCloseA.preview.targetDocumentId).toBe(b.sessionId);
        expect(resolvePreviewTarget(afterCloseA)?.sessionId).toBe(b.sessionId);

        // Fresh: target B, close A (non-target) → target stays B.
        const { workspace: ws2, a: a2, b: b2 } = twoOpen();
        const tB = commitWorkspacePreviewTarget(ws2, b2.sessionId);
        expect(tB.accepted).toBe(true);
        const wB = tB.accepted ? tB.workspace : ws2;
        const cA2 = closeWorkspaceDocument(wB, a2.sessionId);
        expect(cA2.accepted).toBe(true);
        const afterClose = cA2.accepted ? cA2.workspace : wB;
        expect(hasExplicitPreviewTarget(afterClose)).toBe(true);
        expect(resolvePreviewTarget(afterClose)?.sessionId).toBe(b2.sessionId);
    });
});
