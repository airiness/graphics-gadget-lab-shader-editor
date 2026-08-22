/**
 * Document session provenance — the Save target must stay consistent
 * with where the CURRENT document came from.
 *
 * The regression that most matters here is a real user-flow hazard:
 *
 *   given   the current document was opened from A.shadergraph
 *   when    it is replaced through "Load from text" (an import)
 *   then    the import carries NO path, so the next Save must go
 *           through the Save dialog — it must NOT silently write the
 *           imported document into A.shadergraph.
 */
import { describe, expect, it } from "vitest";
import { provenanceFromImport, provenanceFromFile, saveTarget } from "../src/document-session.js";

describe("document session provenance", () => {
    it("a file-opened document owns its path for a plain Save", () => {
        const session = provenanceFromFile("C:\\gglab\\A.shadergraph");
        expect(saveTarget(session, false)).toBe("C:\\gglab\\A.shadergraph");
    });

    it("Save As always asks for a destination, even when a path is owned", () => {
        expect(saveTarget(provenanceFromFile("C:\\gglab\\A.shadergraph"), true)).toBeNull();
    });

    it("an imported (text-loaded) document owns NO path — plain Save must ask, never overwrite a previous file", () => {
        // The dangerous sequence: A.shadergraph was current, then the
        // document was replaced by a text import. The import's
        // provenance must not inherit A.shadergraph.
        const imported = provenanceFromImport();
        expect(imported).toEqual({ kind: "imported" });
        expect(saveTarget(imported, false)).toBeNull();
        expect(saveTarget(imported, true)).toBeNull();
    });

    it("the seeded startup document is treated like an import (no path)", () => {
        expect(saveTarget(provenanceFromImport(), false)).toBeNull();
    });
});
