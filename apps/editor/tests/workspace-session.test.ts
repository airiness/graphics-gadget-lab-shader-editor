import { describe, expect, it } from "vitest";
import {
    activeWorkspaceDocument,
    activateWorkspaceDocument,
    bindWorkspaceDocumentUri,
    canonicalDocumentUriFromHost,
    canonicalWorkspaceUriFromHost,
    closeWorkspaceDocument,
    commitWorkspacePreviewTarget,
    createDocumentSessionId,
    createWorkspaceSession,
    openWorkspaceDocument,
    setWorkspaceRoot,
    updateWorkspaceDocument,
    type CanonicalDocumentUri,
    type DocumentSessionId,
    type WorkspaceDocumentHandle,
    type WorkspaceSession,
} from "../src/workspace-session.js";

function id(value: string): DocumentSessionId {
    return createDocumentSessionId(value);
}

function uri(value: string): CanonicalDocumentUri {
    return canonicalDocumentUriFromHost(value);
}

function document(sessionId: string, canonicalUri: string | null): WorkspaceDocumentHandle {
    return {
        sessionId: id(sessionId),
        canonicalUri: canonicalUri === null ? null : uri(canonicalUri),
    };
}

function opened(...documents: readonly WorkspaceDocumentHandle[]): WorkspaceSession {
    let workspace = createWorkspaceSession();
    for (const entry of documents) {
        const result = openWorkspaceDocument(workspace, entry);
        if (result.accepted === false) {
            throw new Error(`fixture open refused: ${result.refusal.reason}`);
        }
        workspace = result.workspace;
    }
    return workspace;
}

describe("workspace document identity", () => {
    it("owns the host-canonical Workspace root independently of open documents", () => {
        const initial = opened(document("session-a", null));
        const root = {
            canonicalWorkspaceUri: canonicalWorkspaceUriFromHost("file:///D:/Shaders"),
            displayPath: "D:\\Shaders",
        };

        const rooted = setWorkspaceRoot(initial, root);

        expect(rooted.workspaceRoot).toEqual(root);
        expect(rooted.documents).toBe(initial.documents);
        expect(setWorkspaceRoot(rooted, root)).toBe(rooted);
    });

    it("de-duplicates a saved file only by the exact host-canonical URI", () => {
        const first = document("session-a", "file:///D:/Shaders/Surface.shadergraph");
        const duplicateRequest = document("session-b", "file:///D:/Shaders/Surface.shadergraph");
        const workspace = opened(first);

        const result = openWorkspaceDocument(workspace, duplicateRequest);

        expect(result).toMatchObject({
            accepted: true,
            disposition: "activated-existing",
            documentSessionId: first.sessionId,
        });
        if (result.accepted) {
            expect(result.workspace.documents).toEqual([first]);
            expect(result.workspace.activeDocumentId).toBe(first.sessionId);
        }
    });

    it("keeps untitled documents distinct because they have no canonical URI", () => {
        const first = document("untitled-a", null);
        const second = document("untitled-b", null);
        const workspace = opened(first, second);

        expect(workspace.documents).toEqual([first, second]);
        expect(workspace.activeDocumentId).toBe(second.sessionId);
    });

    it("does not accept a reused DocumentSessionId for another file", () => {
        const first = document("session-a", "file:///D:/Shaders/A.shadergraph");
        const workspace = opened(first);

        const result = openWorkspaceDocument(
            workspace,
            document("session-a", "file:///D:/Shaders/B.shadergraph"),
        );

        expect(result).toEqual({
            accepted: false,
            workspace,
            refusal: {
                reason: "document-session-id-already-open",
                documentSessionId: first.sessionId,
            },
        });
    });

    it("refuses a reused session id even when the requested URI belongs to another open tab", () => {
        const first = document("session-a", "file:///D:/Shaders/A.shadergraph");
        const second = document("session-b", "file:///D:/Shaders/B.shadergraph");
        const workspace = opened(first, second);

        const result = openWorkspaceDocument(workspace, {
            sessionId: second.sessionId,
            canonicalUri: first.canonicalUri,
        });

        expect(result).toEqual({
            accepted: false,
            workspace,
            refusal: {
                reason: "document-session-id-already-open",
                documentSessionId: second.sessionId,
            },
        });
    });

    it("treats canonical URIs as opaque host facts and performs no frontend path folding", () => {
        const upper = document("upper", "file:///D:/Shaders/A.shadergraph");
        const lower = document("lower", "file:///d:/shaders/a.shadergraph");
        const workspace = opened(upper, lower);

        expect(workspace.documents).toHaveLength(2);
    });
});

describe("complete document record ownership", () => {
    interface TestDocument extends WorkspaceDocumentHandle {
        readonly title: string;
        readonly revision: number;
    }

    function testDocument(
        sessionId: string,
        canonicalUri: string | null,
        revision: number = 0,
    ): TestDocument {
        return {
            ...document(sessionId, canonicalUri),
            title: sessionId,
            revision,
        };
    }

    function testWorkspace(...documents: readonly TestDocument[]): WorkspaceSession<TestDocument> {
        let workspace = createWorkspaceSession<TestDocument>();
        for (const entry of documents) {
            const result = openWorkspaceDocument(workspace, entry);
            if (result.accepted === false) {
                throw new Error(`fixture open refused: ${result.refusal.reason}`);
            }
            workspace = result.workspace;
        }
        return workspace;
    }

    it("returns the complete active document record", () => {
        const first = testDocument("session-a", null);
        const second = testDocument("session-b", null);
        const workspace = testWorkspace(first, second);

        expect(activeWorkspaceDocument(workspace)).toBe(second);
        expect(activeWorkspaceDocument(createWorkspaceSession<TestDocument>())).toBeNull();
    });

    it("updates one document by session identity without moving active or Preview ownership", () => {
        const first = testDocument("session-a", null);
        const second = testDocument("session-b", null);
        let workspace = testWorkspace(first, second);
        const preview = commitWorkspacePreviewTarget(workspace, first.sessionId);
        if (preview.accepted === false) {
            throw new Error("fixture Preview target was refused");
        }
        workspace = preview.workspace;

        const result = updateWorkspaceDocument(workspace, first.sessionId, (current) => ({
            ...current,
            revision: current.revision + 1,
        }));

        expect(result.accepted).toBe(true);
        expect(result.workspace.documents).toEqual([{ ...first, revision: 1 }, second]);
        expect(result.workspace.activeDocumentId).toBe(second.sessionId);
        expect(result.workspace.preview.targetDocumentId).toBe(first.sessionId);
    });

    it("preserves the Workspace instance for a document update no-op", () => {
        const only = testDocument("session-a", null);
        const workspace = testWorkspace(only);

        const result = updateWorkspaceDocument(workspace, only.sessionId, (current) => current);

        expect(result).toEqual({ accepted: true, workspace });
        expect(result.workspace).toBe(workspace);
    });

    it("refuses an updater that changes the document session identity", () => {
        const only = testDocument("session-a", null);
        const workspace = testWorkspace(only);
        const returnedDocumentSessionId = id("session-b");

        const result = updateWorkspaceDocument(workspace, only.sessionId, (current) => ({
            ...current,
            sessionId: returnedDocumentSessionId,
        }));

        expect(result).toEqual({
            accepted: false,
            workspace,
            refusal: {
                reason: "document-update-changed-session-id",
                documentSessionId: only.sessionId,
                returnedDocumentSessionId,
            },
        });
    });

    it("refuses a document update that collides with another canonical URI", () => {
        const first = testDocument("session-a", "file:///D:/Shaders/A.shadergraph");
        const second = testDocument("session-b", null);
        const workspace = testWorkspace(first, second);

        const result = updateWorkspaceDocument(workspace, second.sessionId, (current) => ({
            ...current,
            canonicalUri: first.canonicalUri,
        }));

        expect(result).toEqual({
            accepted: false,
            workspace,
            refusal: {
                reason: "canonical-document-uri-already-open",
                canonicalUri: first.canonicalUri,
                owningDocumentSessionId: first.sessionId,
            },
        });
    });

    it("binding a canonical URI preserves the complete document record", () => {
        const only = testDocument("session-a", null, 7);
        const workspace = testWorkspace(only);
        const canonicalUri = uri("file:///D:/Shaders/A.shadergraph");

        const result = bindWorkspaceDocumentUri(workspace, only.sessionId, canonicalUri);

        expect(result.accepted).toBe(true);
        expect(result.workspace.documents).toEqual([{ ...only, canonicalUri }]);
        expect(activeWorkspaceDocument(result.workspace)).toEqual({ ...only, canonicalUri });
    });
});

describe("active document and Preview target ownership", () => {
    it("seeds the Preview target at the FIRST OPEN — an explicit target exists from the start, never a live active-follow", () => {
        const first = document("session-a", "file:///D:/Shaders/A.shadergraph");
        const second = document("session-b", "file:///D:/Shaders/B.shadergraph");

        const firstOpen = openWorkspaceDocument(createWorkspaceSession(), first);
        if (firstOpen.accepted === false) {
            throw new Error(`fixture first open refused: ${firstOpen.refusal.reason}`);
        }
        // The first opened document IS the Preview target — the "bootstrap"
        // is a one-time ownership decision at open time, not a derivation
        // from the active tab.
        expect(firstOpen.workspace.preview.targetDocumentId).toBe(first.sessionId);

        const secondOpen = openWorkspaceDocument(firstOpen.workspace, second);
        if (secondOpen.accepted === false) {
            throw new Error(`fixture second open refused: ${secondOpen.refusal.reason}`);
        }
        // A later open activates the new tab but must NOT move the target:
        // active and Preview target are independent axes.
        expect(secondOpen.workspace.activeDocumentId).toBe(second.sessionId);
        expect(secondOpen.workspace.preview.targetDocumentId).toBe(first.sessionId);
    });

    it("switching the active document never retargets Preview", () => {
        const first = document("session-a", "file:///D:/Shaders/A.shadergraph");
        const second = document("session-b", "file:///D:/Shaders/B.shadergraph");
        let workspace = opened(first, second);
        const preview = commitWorkspacePreviewTarget(workspace, first.sessionId);
        if (preview.accepted === false) {
            throw new Error("fixture Preview target was refused");
        }
        workspace = preview.workspace;

        const activated = activateWorkspaceDocument(workspace, second.sessionId);

        expect(activated.accepted).toBe(true);
        expect(activated.workspace.activeDocumentId).toBe(second.sessionId);
        expect(activated.workspace.preview.targetDocumentId).toBe(first.sessionId);
    });

    it("opening another file activates it without moving an existing Preview target", () => {
        const first = document("session-a", "file:///D:/Shaders/A.shadergraph");
        const second = document("session-b", "file:///D:/Shaders/B.shadergraph");
        let workspace = opened(first);
        const preview = commitWorkspacePreviewTarget(workspace, first.sessionId);
        if (preview.accepted === false) {
            throw new Error("fixture Preview target was refused");
        }
        workspace = preview.workspace;

        const result = openWorkspaceDocument(workspace, second);

        expect(result.accepted).toBe(true);
        if (result.accepted) {
            expect(result.workspace.activeDocumentId).toBe(second.sessionId);
            expect(result.workspace.preview.targetDocumentId).toBe(first.sessionId);
        }
    });

    it("refuses an active or Preview target that is not open without changing state", () => {
        const workspace = opened(document("session-a", null));
        const missing = id("missing");

        expect(activateWorkspaceDocument(workspace, missing)).toEqual({
            accepted: false,
            workspace,
            refusal: { reason: "document-not-open", documentSessionId: missing },
        });
        expect(commitWorkspacePreviewTarget(workspace, missing)).toEqual({
            accepted: false,
            workspace,
            refusal: { reason: "document-not-open", documentSessionId: missing },
        });
    });

    it("preserves the workspace instance for accepted active/target no-ops", () => {
        const only = document("session-a", null);
        let workspace = opened(only);

        const activated = activateWorkspaceDocument(workspace, only.sessionId);
        expect(activated).toEqual({ accepted: true, workspace });
        expect(activated.workspace).toBe(workspace);

        const preview = commitWorkspacePreviewTarget(workspace, only.sessionId);
        if (preview.accepted === false) {
            throw new Error("fixture Preview target was refused");
        }
        workspace = preview.workspace;
        const repeated = commitWorkspacePreviewTarget(workspace, only.sessionId);
        expect(repeated).toEqual({ accepted: true, workspace });
        expect(repeated.workspace).toBe(workspace);
    });
});

describe("Save As identity and close transitions", () => {
    it("binds an untitled session to a host-canonical URI", () => {
        const untitled = document("untitled", null);
        const workspace = opened(untitled);
        const canonicalUri = uri("file:///D:/Shaders/Saved.shadergraph");

        const result = bindWorkspaceDocumentUri(workspace, untitled.sessionId, canonicalUri);

        expect(result.accepted).toBe(true);
        expect(result.workspace.documents).toEqual([{ ...untitled, canonicalUri }]);
    });

    it("refuses Save As binding when another open session owns the URI", () => {
        const saved = document("saved", "file:///D:/Shaders/A.shadergraph");
        const untitled = document("untitled", null);
        const workspace = opened(saved, untitled);

        const result = bindWorkspaceDocumentUri(
            workspace,
            untitled.sessionId,
            saved.canonicalUri as CanonicalDocumentUri,
        );

        expect(result).toEqual({
            accepted: false,
            workspace,
            refusal: {
                reason: "canonical-document-uri-already-open",
                canonicalUri: saved.canonicalUri,
                owningDocumentSessionId: saved.sessionId,
            },
        });
    });

    it("closing the Preview target clears ownership while choosing the adjacent active tab", () => {
        const first = document("session-a", null);
        const second = document("session-b", null);
        const third = document("session-c", null);
        let workspace = opened(first, second, third);
        const preview = commitWorkspacePreviewTarget(workspace, second.sessionId);
        if (preview.accepted === false) {
            throw new Error("fixture Preview target was refused");
        }
        const active = activateWorkspaceDocument(preview.workspace, second.sessionId);
        if (active.accepted === false) {
            throw new Error("fixture activation was refused");
        }
        workspace = active.workspace;

        const result = closeWorkspaceDocument(workspace, second.sessionId);

        expect(result.accepted).toBe(true);
        expect(result.workspace.documents).toEqual([first, third]);
        expect(result.workspace.activeDocumentId).toBe(third.sessionId);
        expect(result.workspace.preview.targetDocumentId).toBeNull();
    });

    it("closing a background Preview target clears ownership and preserves the active tab", () => {
        const first = document("session-a", null);
        const second = document("session-b", null);
        let workspace = opened(first, second);
        const preview = commitWorkspacePreviewTarget(workspace, first.sessionId);
        if (preview.accepted === false) {
            throw new Error("fixture Preview target was refused");
        }
        workspace = preview.workspace;

        const result = closeWorkspaceDocument(workspace, first.sessionId);

        expect(result.accepted).toBe(true);
        expect(result.workspace.documents).toEqual([second]);
        expect(result.workspace.activeDocumentId).toBe(second.sessionId);
        expect(result.workspace.preview.targetDocumentId).toBeNull();
        const reopened = openWorkspaceDocument(result.workspace, first);
        expect(reopened.workspace.preview.targetDocumentId).toBeNull();
    });

    it("closing the last document leaves no Preview target (there is nothing to own)", () => {
        const only = document("session-a", null);
        const workspace = opened(only);
        expect(workspace.preview.targetDocumentId).toBe(only.sessionId); // seeded at open

        const result = closeWorkspaceDocument(workspace, only.sessionId);
        expect(result.accepted).toBe(true);
        expect(result.workspace.documents).toEqual([]);
        expect(result.workspace.activeDocumentId).toBeNull();
        expect(result.workspace.preview.targetDocumentId).toBeNull();
    });

    it("closing a background document preserves active and Preview ownership", () => {
        const first = document("session-a", null);
        const second = document("session-b", null);
        let workspace = opened(first, second);
        const preview = commitWorkspacePreviewTarget(workspace, second.sessionId);
        if (preview.accepted === false) {
            throw new Error("fixture Preview target was refused");
        }
        workspace = preview.workspace;

        const result = closeWorkspaceDocument(workspace, first.sessionId);

        expect(result.accepted).toBe(true);
        expect(result.workspace.documents).toEqual([second]);
        expect(result.workspace.activeDocumentId).toBe(second.sessionId);
        expect(result.workspace.preview.targetDocumentId).toBe(second.sessionId);
    });
});

describe("identity constructors", () => {
    it("rejects empty session identities and host URI transport values", () => {
        expect(() => createDocumentSessionId("  ")).toThrow("DocumentSessionId");
        expect(() => canonicalDocumentUriFromHost("")).toThrow("host-canonical document URI");
    });
});
