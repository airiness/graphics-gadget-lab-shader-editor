/**
 * Document session — identity, document history, provenance, saved baseline,
 * dirty state, save target, window title, and the close-guard decision.
 *
 * The regression most worth locking: "Load from text" replaces the
 * document but must never keep a previous file's save authority — an
 * imported document's Save target is `null`, so a plain Save goes through
 * the host-owned dialog and can never silently overwrite the last file.
 */
import { describe, expect, it } from "vitest";
import {
    basenameOf,
    closeAction,
    createSession,
    isDirty,
    provenanceFromImport,
    provenanceFromFile,
    recordDocumentChange,
    redoDocumentChange,
    saveTarget,
    sessionSaved,
    sessionTitle,
    undoDocumentChange,
    type DocumentProvenance,
} from "../src/document-session.js";
import { serializeShaderGraphDocument, type ShaderGraphDocument } from "@gglab/shader-graph-core";
import {
    activeWorkspaceDocument,
    activateWorkspaceDocument,
    commitWorkspacePreviewTarget,
    canonicalDocumentUriFromHost,
    createDocumentSessionId,
    createWorkspaceSession,
    openWorkspaceDocument,
    updateWorkspaceDocument,
    type DocumentSessionId,
} from "../src/workspace-session.js";
import {
    fileRevisionTokenFromHost,
    type DocumentSnapshot,
} from "../src/host-io.js";

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

const SESSION_ID = createDocumentSessionId("document-session-a");
const CANONICAL_URI = canonicalDocumentUriFromHost("file:///C:/gglab/A.shadergraph");
const REVISION = fileRevisionTokenFromHost("revision-a");

function savedSnapshot(
    document: ShaderGraphDocument = DOC,
    displayPath: string = "C:\\gglab\\A.shadergraph",
): DocumentSnapshot {
    return {
        canonicalDocumentUri: CANONICAL_URI,
        displayPath,
        text: serializeShaderGraphDocument(document),
        fileRevisionToken: REVISION,
    };
}

function makeSession(
    provenance: DocumentProvenance,
    document: ShaderGraphDocument = DOC,
    sessionId: DocumentSessionId = SESSION_ID,
) {
    return createSession(sessionId, provenance, document);
}

describe("document provenance and save target", () => {
    it("requires the native URI and revision token as one inseparable capability", () => {
        expect(() =>
            createSession(
                SESSION_ID,
                provenanceFromFile("C:\\gglab\\A.shadergraph"),
                DOC,
                CANONICAL_URI,
            ),
        ).toThrow(/requires both canonical URI and file revision token/);
    });

    it("never treats a display/provenance path as native save authority", () => {
        const session = makeSession(provenanceFromFile("C:\\gglab\\A.shadergraph"));
        expect(saveTarget(session, false)).toBeNull();
    });

    it("a host snapshot owns the canonical URI and revision required by plain Save", () => {
        const session = createSession(
            SESSION_ID,
            provenanceFromFile("C:\\gglab\\A.shadergraph"),
            DOC,
            CANONICAL_URI,
            REVISION,
        );
        expect(saveTarget(session, false)).toEqual({
            canonicalDocumentUri: CANONICAL_URI,
            expectedFileRevisionToken: REVISION,
        });
    });

    it("Save As always asks for a destination, even when file provenance is known", () => {
        expect(saveTarget(makeSession(provenanceFromFile("C:\\gglab\\A.shadergraph")), true)).toBeNull();
    });

    it("an imported document owns NO save authority — plain Save must ask", () => {
        // The dangerous sequence: A.shadergraph was current, then the
        // document was replaced by a text import. The import must not
        // inherit A.shadergraph.
        const session = makeSession(provenanceFromImport());
        expect(session.provenance).toEqual({ kind: "imported" });
        expect(saveTarget(session, false)).toBeNull();
        expect(saveTarget(session, true)).toBeNull();
    });

    it("the seeded startup document is treated like an import (no save authority)", () => {
        expect(saveTarget(makeSession(provenanceFromImport()), false)).toBeNull();
    });

    it("a successful save installs the host-returned URI, revision, path, and baseline", () => {
        const saved = sessionSaved(
            makeSession(provenanceFromImport()),
            SESSION_ID,
            savedSnapshot(DOC, "C:\\gglab\\B.shadergraph"),
        );
        expect(saved.provenance).toEqual({ kind: "file", path: "C:\\gglab\\B.shadergraph" });
        expect(saveTarget(saved, false)).toEqual({
            canonicalDocumentUri: CANONICAL_URI,
            expectedFileRevisionToken: REVISION,
        });
    });
});

describe("document identity and history ownership", () => {
    it("keeps the identity, history, provenance, and baseline in one aggregate", () => {
        const initial = makeSession(provenanceFromFile("C:\\gglab\\A.shadergraph"));
        const changedDocument: ShaderGraphDocument = { ...DOC, graphId: "changed" };

        const changed = recordDocumentChange(initial, changedDocument, "changed graph id");

        expect(changed.sessionId).toBe(SESSION_ID);
        expect(changed.canonicalUri).toBeNull();
        expect(changed.provenance).toBe(initial.provenance);
        expect(changed.savedBaseline).toBe(initial.savedBaseline);
        expect(changed.history.present).toBe(changedDocument);
        expect(changed.history.past).toHaveLength(1);
        expect(isDirty(changed)).toBe(true);
    });

    it("undo and redo move only this session's current document", () => {
        const initial = makeSession(provenanceFromImport());
        const changedDocument: ShaderGraphDocument = { ...DOC, graphId: "changed" };
        const changed = recordDocumentChange(initial, changedDocument, "changed graph id");

        const undone = undoDocumentChange(changed);
        const redone = redoDocumentChange(undone);

        expect(undone.sessionId).toBe(SESSION_ID);
        expect(undone.history.present).toBe(DOC);
        expect(redone.sessionId).toBe(SESSION_ID);
        expect(redone.history.present).toBe(changedDocument);
    });

    it("preserves the aggregate instance for history no-ops", () => {
        const initial = makeSession(provenanceFromImport());

        expect(recordDocumentChange(initial, initial.history.present, "no change")).toBe(initial);
        expect(undoDocumentChange(initial)).toBe(initial);
        expect(redoDocumentChange(initial)).toBe(initial);
    });

    it("ignores a save completion issued by another document session", () => {
        const current = makeSession(provenanceFromImport());
        const otherSessionId = createDocumentSessionId("document-session-b");

        const result = sessionSaved(
            current,
            otherSessionId,
            savedSnapshot(DOC, "C:\\gglab\\Other.shadergraph"),
        );

        expect(result).toBe(current);
        expect(result.provenance).toEqual({ kind: "imported" });
    });
});

describe("WorkspaceSession and DocumentSession composition", () => {
    it("keeps independent histories and baselines while active and Preview ownership move separately", () => {
        const firstDocument: ShaderGraphDocument = { ...DOC, graphId: "first" };
        const secondDocument: ShaderGraphDocument = { ...DOC, graphId: "second" };
        const first = makeSession(
            provenanceFromFile("C:\\gglab\\First.shadergraph"),
            firstDocument,
            createDocumentSessionId("first-session"),
        );
        const second = makeSession(
            provenanceFromImport(),
            secondDocument,
            createDocumentSessionId("second-session"),
        );
        let workspace = createWorkspaceSession<typeof first>();
        for (const documentSession of [first, second]) {
            const opened = openWorkspaceDocument(workspace, documentSession);
            if (opened.accepted === false) {
                throw new Error(`fixture open refused: ${opened.refusal.reason}`);
            }
            workspace = opened.workspace;
        }
        const preview = commitWorkspacePreviewTarget(workspace, second.sessionId);
        if (preview.accepted === false) {
            throw new Error("fixture Preview target was refused");
        }
        workspace = preview.workspace;

        const changedFirstDocument: ShaderGraphDocument = { ...firstDocument, graphId: "first-changed" };
        const updated = updateWorkspaceDocument(workspace, first.sessionId, (current) =>
            recordDocumentChange(current, changedFirstDocument, "changed first document"),
        );
        if (updated.accepted === false) {
            throw new Error(`fixture update refused: ${updated.refusal.reason}`);
        }
        workspace = updated.workspace;

        expect(activeWorkspaceDocument(workspace)).toBe(second);
        expect(workspace.preview.targetDocumentId).toBe(second.sessionId);
        expect(isDirty(workspace.documents[0]!)).toBe(true);
        expect(workspace.documents[0]!.history.past).toHaveLength(1);
        expect(isDirty(workspace.documents[1]!)).toBe(false);
        expect(workspace.documents[1]).toBe(second);

        const activated = activateWorkspaceDocument(workspace, first.sessionId);
        expect(activated.accepted).toBe(true);
        expect(activeWorkspaceDocument(activated.workspace)?.history.present).toBe(changedFirstDocument);
        expect(activated.workspace.preview.targetDocumentId).toBe(second.sessionId);
    });
});

describe("dirty — canonical bytes vs the saved baseline", () => {
    it("a freshly established session is not dirty", () => {
        const session = makeSession(provenanceFromFile("C:\\gglab\\A.shadergraph"));
        // The baseline IS the document's own canonical bytes (the core's
        // serialization authority).
        expect(session.savedBaseline).toBe(serializeShaderGraphDocument(DOC));
        expect(isDirty(session)).toBe(false);
    });

    it("any semantic change in the current document makes it dirty", () => {
        const session = makeSession(provenanceFromFile("C:\\gglab\\A.shadergraph"));
        const mutated: ShaderGraphDocument = { ...DOC, graphId: "other" };
        const changed = recordDocumentChange(session, mutated, "changed graph id");
        expect(isDirty(changed)).toBe(true);
        // ...and saving the mutated state establishes it as the new
        // baseline — clean again.
        const saved = sessionSaved(
            changed,
            SESSION_ID,
            savedSnapshot(mutated),
        );
        expect(isDirty(saved)).toBe(false);
    });

    it("serialization order is not a change: equal documents in different key order are not dirty", () => {
        const session = makeSession(provenanceFromFile("C:\\gglab\\A.shadergraph"));
        const reordered: ShaderGraphDocument = {
            editorMetadata: DOC.editorMetadata,
            connections: DOC.connections,
            nodes: DOC.nodes,
            parameters: DOC.parameters,
            profileVersion: DOC.profileVersion,
            profile: DOC.profile,
            graphId: DOC.graphId,
            schemaVersion: DOC.schemaVersion,
            unknownFields: DOC.unknownFields,
        };
        // The core's canonical serialization is deterministic, so a byte
        // comparison over it is a structural comparison.
        expect(isDirty(recordDocumentChange(session, reordered, "reordered fields"))).toBe(false);
    });
});

describe("window title", () => {
    it("names the owned file, with a star exactly when dirty", () => {
        const session = makeSession(provenanceFromFile("C:\\gglab\\MyShader.shadergraph"));
        expect(sessionTitle(session, false)).toBe("GGLab Shader Graph Editor — MyShader.shadergraph");
        expect(sessionTitle(session, true)).toBe("GGLab Shader Graph Editor — MyShader.shadergraph *");
    });

    it("a pathless document is Untitled", () => {
        const session = makeSession(provenanceFromImport());
        expect(sessionTitle(session, false)).toBe("GGLab Shader Graph Editor — Untitled");
        expect(sessionTitle(session, true)).toBe("GGLab Shader Graph Editor — Untitled *");
    });
});

describe("pathname helpers", () => {
    it("basenameOf handles Windows and POSIX paths", () => {
        expect(basenameOf("C:\\gglab\\MyShader.shadergraph")).toBe("MyShader.shadergraph");
        expect(basenameOf("/home/u/doc.json")).toBe("doc.json");
        expect(basenameOf("shadergraph")).toBe("shadergraph");
    });
});

describe("the unsaved-close decision (pure)", () => {
    it("Save closes only when the save actually succeeded", () => {
        expect(closeAction("save", true)).toBe("close");
        expect(closeAction("save", false)).toBe("stay"); // failed save — never close
    });

    it("Don't Save closes regardless; anything else stays", () => {
        expect(closeAction("discard", false)).toBe("close");
        expect(closeAction("cancel", false)).toBe("stay");
        expect(closeAction("cancel", true)).toBe("stay");
    });
});
