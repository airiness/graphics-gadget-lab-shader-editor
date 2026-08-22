/**
 * Document session — provenance, saved baseline, dirty, save target,
 * window title, and the close-guard decision.
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
    saveTarget,
    sessionSaved,
    sessionTitle,
} from "../src/document-session.js";
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

describe("document provenance and save target", () => {
    it("a file-opened document owns its path for a plain Save", () => {
        const session = createSession(provenanceFromFile("C:\\gglab\\A.shadergraph"), DOC);
        expect(saveTarget(session, false)).toBe("C:\\gglab\\A.shadergraph");
    });

    it("Save As always asks for a destination, even when a path is owned", () => {
        expect(saveTarget(createSession(provenanceFromFile("C:\\gglab\\A.shadergraph"), DOC), true)).toBeNull();
    });

    it("an imported (text-loaded) document owns NO path — plain Save must ask, never overwrite a previous file", () => {
        // The dangerous sequence: A.shadergraph was current, then the
        // document was replaced by a text import. The import must not
        // inherit A.shadergraph.
        const session = createSession(provenanceFromImport(), DOC);
        expect(session.provenance).toEqual({ kind: "imported" });
        expect(saveTarget(session, false)).toBeNull();
        expect(saveTarget(session, true)).toBeNull();
    });

    it("the seeded startup document is treated like an import (no path)", () => {
        expect(saveTarget(createSession(provenanceFromImport(), DOC), false)).toBeNull();
    });

    it("a successful save makes the document own that exact path", () => {
        const session = sessionSaved("C:\\gglab\\B.shadergraph", serializeShaderGraphDocument(DOC));
        expect(session.provenance).toEqual({ kind: "file", path: "C:\\gglab\\B.shadergraph" });
        expect(saveTarget(session, false)).toBe("C:\\gglab\\B.shadergraph");
    });
});

describe("dirty — canonical bytes vs the saved baseline", () => {
    it("a freshly established session is not dirty", () => {
        const session = createSession(provenanceFromFile("C:\\gglab\\A.shadergraph"), DOC);
        // The baseline IS the document's own canonical bytes (the core's
        // serialization authority).
        expect(session.savedBaseline).toBe(serializeShaderGraphDocument(DOC));
        expect(isDirty(DOC, session)).toBe(false);
    });

    it("any semantic change in the current document makes it dirty", () => {
        const session = createSession(provenanceFromFile("C:\\gglab\\A.shadergraph"), DOC);
        const mutated: ShaderGraphDocument = { ...DOC, graphId: "other" };
        expect(isDirty(mutated, session)).toBe(true);
        // ...and saving the mutated state establishes it as the new
        // baseline — clean again.
        const saved = sessionSaved("C:\\gglab\\A.shadergraph", serializeShaderGraphDocument(mutated));
        expect(isDirty(mutated, saved)).toBe(false);
    });

    it("serialization order is not a change: equal documents in different key order are not dirty", () => {
        const session = createSession(provenanceFromFile("C:\\gglab\\A.shadergraph"), DOC);
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
        expect(isDirty(reordered, session)).toBe(false);
    });
});

describe("window title", () => {
    it("names the owned file, with a star exactly when dirty", () => {
        const session = createSession(provenanceFromFile("C:\\gglab\\MyShader.shadergraph"), DOC);
        expect(sessionTitle(session, false)).toBe("GGLab Shader Graph Editor — MyShader.shadergraph");
        expect(sessionTitle(session, true)).toBe("GGLab Shader Graph Editor — MyShader.shadergraph *");
    });

    it("a pathless document is Untitled", () => {
        const session = createSession(provenanceFromImport(), DOC);
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
