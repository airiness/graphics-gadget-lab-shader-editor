import { describe, expect, it } from "vitest";
import {
    documentSaveConflictActions,
    type DocumentSaveConflictOrigin,
    type PendingDocumentSaveConflict,
} from "../src/document-save-conflict.js";
import { fileRevisionTokenFromHost } from "../src/host-io.js";
import {
    canonicalDocumentUriFromHost,
    createDocumentSessionId,
} from "../src/workspace-session.js";

function conflict(
    origin: DocumentSaveConflictOrigin,
    observedRevision: string | null,
): PendingDocumentSaveConflict {
    return {
        sessionId: createDocumentSessionId("document-session-a"),
        origin,
        canonicalDocumentUri: canonicalDocumentUriFromHost(
            "file:///C:/gglab/A.shadergraph",
        ),
        observedFileRevisionToken:
            observedRevision === null
                ? null
                : fileRevisionTokenFromHost(observedRevision),
        destinationOwnerSessionId: null,
        localText: "local",
        defaultName: "A.shadergraph",
    };
}

describe("document save conflict choices", () => {
    it("offers reload, deliberate overwrite, Save As, and cancel for an external edit", () => {
        expect(documentSaveConflictActions(conflict("save", "external-revision"))).toEqual([
            "reload",
            "overwrite",
            "save-as",
            "cancel",
        ]);
    });

    it("does not offer Reload for a Save As destination conflict", () => {
        expect(documentSaveConflictActions(conflict("save-as", "destination-revision"))).toEqual([
            "overwrite",
            "save-as",
            "cancel",
        ]);
    });

    it("never offers an unguarded overwrite when the destination revision is unavailable", () => {
        expect(documentSaveConflictActions(conflict("save", null))).toEqual([
            "reload",
            "save-as",
            "cancel",
        ]);
        expect(documentSaveConflictActions(conflict("save-as", null))).toEqual([
            "save-as",
            "cancel",
        ]);
    });

    it("never merges a Save As destination into another open session", () => {
        const destinationConflict = conflict("save-as", "destination-revision");
        expect(
            documentSaveConflictActions({
                ...destinationConflict,
                destinationOwnerSessionId: createDocumentSessionId("document-session-b"),
            }),
        ).toEqual(["save-as", "cancel"]);
    });
});
