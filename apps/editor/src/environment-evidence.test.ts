import { describe, expect, it } from "vitest";
import { EnvironmentEvidence } from "./environment-evidence.js";
import { EditorOutput } from "./editor-output.js";

describe("Environment diagnostic projection", () => {
    it("keeps Environment locations separate from graph ownership and Output clear", () => {
        const output = new EditorOutput(), evidence = new EnvironmentEvidence(output);
        evidence.begin()({ phase: "settled", environmentRoot: "D:/final", stateRoot: "D:/state", diagnostic: { code: "hash-mismatch", severity: "error", message: "Corrupt member", dataPath: "payload/gglab-shaderc.exe" } });
        expect(evidence.getSnapshot()[0]?.location).toEqual({ kind: "environment", root: "D:/final", dataPath: "payload/gglab-shaderc.exe" });
        expect(evidence.getSnapshot()[0]?.correlation.documentSessionId).toBeNull();
        output.clear(); expect(evidence.getSnapshot()).toHaveLength(1);
        evidence.begin()({ phase: "settled", environmentRoot: "D:/final", stateRoot: "D:/state" });
        expect(evidence.getSnapshot()).toHaveLength(0);
    });
    it("records late events chronologically without replacing newer current Problems", () => {
        const output = new EditorOutput(), evidence = new EnvironmentEvidence(output), old = evidence.begin();
        evidence.begin()({ phase: "settled", environmentRoot: "D:/new", stateRoot: "D:/state" });
        old({ phase: "settled", environmentRoot: "D:/old", stateRoot: "D:/state", diagnostic: { code: "hash-mismatch", severity: "error", message: "Old failure", dataPath: "$" } });
        expect(evidence.getSnapshot()).toHaveLength(0); expect(output.getSnapshot()).toHaveLength(2);
    });
});
