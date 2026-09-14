import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyGraphEdits, graphEditCommandCatalog, parseShaderGraphDocument, serializeShaderGraphDocument, type GraphEditCommand } from "@gglab/shader-graph-core";
import { dispatch } from "../src/index.js";
import { runEdit } from "../src/commands/edit.js";
import { COMMAND_GRAMMARS, parseCommandArgs } from "../src/command-grammar.js";

const directory = mkdtempSync(join(tmpdir(), "gglab-edit-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const documentPath = join(directory, "graph.shadergraph");
const commandPath = join(directory, "commands.json");
const original = JSON.stringify({ schemaVersion: 1, graphId: "cli-edit", profile: "gglab.surface", profileVersion: 1, parameters: [], nodes: [], connections: [], editorMetadata: { nodes: {} }, retained: { future: true } });
writeFileSync(documentPath, original);

function run(commands: unknown) {
    writeFileSync(commandPath, JSON.stringify(commands));
    const result = dispatch("edit", [documentPath, "--commands", commandPath]);
    return { code: result.code, envelope: JSON.parse(result.sinkText) as { ok: boolean; diagnostics: { code: string; dataPath: string }[]; payload: { status: string; documentText: string; createdIds: (string | null)[] } | null } };
}

describe("CLI consumes core edit transactions", () => {
    it("returns the core's exact canonical document without modifying the input file", () => {
        const commands: GraphEditCommand[] = [
            { kind: "add-node", nodeType: "Float", nodeId: "value" },
            { kind: "set-constant-value", nodeId: "value", value: 2.5 },
            { kind: "add-parameter", name: "Tint", class: "VectorParameter", valueType: "float3", parameterId: "tint", nodeId: "tint-node" },
            { kind: "rename-parameter", parameterId: "tint", name: "Base Tint" },
        ];
        const expected = applyGraphEdits(parseShaderGraphDocument(original).value!, commands);
        const result = run(commands);
        expect(result.code).toBe(0);
        expect(result.envelope.payload).toEqual({ status: expected.status, createdIds: expected.createdIds, documentText: serializeShaderGraphDocument(expected.document) });
        expect(readFileSync(documentPath, "utf8")).toBe(original);
        const again = dispatch("edit", [documentPath, "--commands", commandPath]);
        expect(JSON.parse(again.sinkText)).toEqual(result.envelope);
    });

    it("returns no partial payload for a refused batch and identifies the command", () => {
        const result = run([{ kind: "add-node", nodeType: "Float" }, { kind: "remove-node", nodeId: "missing" }]);
        expect(result.code).toBe(1);
        expect(result.envelope.payload).toBeNull();
        expect(result.envelope.diagnostics).toContainEqual(expect.objectContaining({ code: "EDIT_TRANSACTION_REFUSED", dataPath: "$.commands[1]" }));
        expect(readFileSync(documentPath, "utf8")).toBe(original);
    });

    it("reports an empty transaction as unchanged and exposes the core command catalog", () => {
        expect(run([]).envelope.payload?.status).toBe("unchanged");
        const result = dispatch("edit-commands", []);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.sinkText).payload).toEqual(graphEditCommandCatalog);
    });

    it("rejects malformed command data, unknown options and missing commands explicitly", () => {
        expect(run([{ kind: "add-node", nodeType: "Float", typo: 1 }]).envelope.diagnostics[0]?.code).toBe("INVALID_EDIT_COMMAND");
        expect(dispatch("edit", [documentPath]).code).toBe(2);
        expect(dispatch("edit", [documentPath, "--command", commandPath]).code).toBe(2);
        expect(dispatch("edit-commands", ["unexpected"]).code).toBe(2);
        const result = run([{ kind: "set-profile", profile: "gglab.surface", profileVersion: 2 }]);
        expect(result.envelope.diagnostics[0]?.code).toBe("PROFILE_MISMATCH");
        expect(readFileSync(documentPath, "utf8")).toBe(original);
    });

    it("refuses malformed parsed arguments when called directly", () => {
        const args = parseCommandArgs(COMMAND_GRAMMARS.edit, "edit", [documentPath, "--commands", commandPath, "--typo"]);
        expect(runEdit(args)).toMatchObject({ ok: false, diagnostics: args.diagnostics, payload: null });
    });
});
