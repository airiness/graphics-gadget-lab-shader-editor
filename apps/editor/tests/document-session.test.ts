/**
 * Document session — identity, document history, provenance, saved baseline,
 * dirty state, save target, window title, and the close-guard decision.
 *
 * The regression most worth locking: "Load from text" replaces the
 * document but must never keep a previous file's path — an imported
 * document's Save target is `null`, so a plain Save goes through the
 * dialog and can never silently overwrite the last opened file.
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
import { createDocumentSessionId, type DocumentSessionId } from "../src/workspace-session.js";

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

function makeSession(
    provenance: DocumentProvenance,
    document: ShaderGraphDocument = DOC,
    sessionId: DocumentSessionId = SESSION_ID,
) {
    return createSession(sessionId, provenance, document);
}

describe("document provenance and save target", () => {
    it("a file-opened document owns its path for a plain Save", () => {
        const session = makeSession(provenanceFromFile("C:\\gglab\\A.shadergraph"));
        expect(saveTarget(session, false)).toBe("C:\\gglab\\A.shadergraph");
    });

    it("Save As always asks for a destination, even when a path is owned", () => {
        expect(saveTarget(makeSession(provenanceFromFile("C:\\gglab\\A.shadergraph")), true)).toBeNull();
    });

    it("an imported (text-loaded) document owns NO path — plain Save must ask, never overwrite a previous file", () => {
        // The dangerous sequence: A.shadergraph was current, then the
        // document was replaced by a text import. The import must not
        // inherit A.shadergraph.
        const session = makeSession(provenanceFromImport());
        expect(session.provenance).toEqual({ kind: "imported" });
        expect(saveTarget(session, false)).toBeNull();
        expect(saveTarget(session, true)).toBeNull();
    });

    it("the seeded startup document is treated like an import (no path)", () => {
        expect(saveTarget(makeSession(provenanceFromImport()), false)).toBeNull();
    });

    it("a successful save makes the document own that exact path", () => {
        const saved = sessionSaved(
            makeSession(provenanceFromImport()),
            SESSION_ID,
            "C:\\gglab\\B.shadergraph",
            serializeShaderGraphDocument(DOC),
        );
        expect(saved.provenance).toEqual({ kind: "file", path: "C:\\gglab\\B.shadergraph" });
        expect(saveTarget(saved, false)).toBe("C:\\gglab\\B.shadergraph");
    });
});

describe("document identity and history ownership", () => {
    it("keeps the identity, history, provenance, and baseline in one aggregate", () => {
        const initial = makeSession(provenanceFromFile("C:\\gglab\\A.shadergraph"));
        const changedDocument: ShaderGraphDocument = { ...DOC, graphId: "changed" };

        const changed = recordDocumentChange(initial, changedDocument, "changed graph id");

        expect(changed.sessionId).toBe(SESSION_ID);
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
            "C:\\gglab\\Other.shadergraph",
            serializeShaderGraphDocument(DOC),
        );

        expect(result).toBe(current);
        expect(result.provenance).toEqual({ kind: "imported" });
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
            "C:\\gglab\\A.shadergraph",
            serializeShaderGraphDocument(mutated),
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
