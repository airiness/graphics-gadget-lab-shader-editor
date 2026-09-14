/** Apply a core-owned edit transaction and return canonical document bytes.
 * The CLI performs file reads and serialization only; it never patches JSON. */
import { applyGraphEdits, parseGraphEditCommands, serializeShaderGraphDocument, type SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import type { ParsedArgs } from "../command-grammar.js";
import { buildEnvelope, cliDiagnosticAt, CliCode } from "../envelope.js";
import { readTextFile } from "../io.js";
import { loadDocument } from "../shared.js";
import { resolveDescriptorInstance } from "../resolve-descriptor.js";

export function runEdit(args: ParsedArgs) {
    if (args.diagnostics.length > 0) return buildEnvelope("edit", args.diagnostics, null);
    const path = args.positionals[0];
    const commandsPath = args.options.get("commands");
    if (path === undefined || commandsPath === undefined) return buildEnvelope("edit", [cliDiagnosticAt("$.commands", CliCode.MissingOption, "Edit requires a document path and --commands <commands.json>.")], null);
    const loaded = loadDocument(path);
    if (loaded.loaded === undefined) return buildEnvelope("edit", loaded.diagnostics, null);
    const input = readTextFile(commandsPath, "$.commands");
    if (input.text === undefined) return buildEnvelope("edit", [input.diagnostic ?? cliDiagnosticAt("$.commands", CliCode.FileUnreadable, "The edit command file could not be read.")], null);
    const parsed = parseGraphEditCommands(input.text);
    if (!parsed.ok || parsed.value === null) return buildEnvelope("edit", parsed.diagnostics, null);
    let descriptor: SurfaceProfileDescriptor | undefined;
    const descriptorPath = args.options.get("descriptor");
    if (descriptorPath !== undefined) {
        const resolved = resolveDescriptorInstance(descriptorPath);
        if (resolved.descriptor === undefined) return buildEnvelope("edit", resolved.diagnostics, null);
        descriptor = resolved.descriptor;
    }
    const result = applyGraphEdits(loaded.loaded.document, parsed.value, descriptor === undefined ? {} : { descriptor });
    if (result.status === "refused") return buildEnvelope("edit", result.diagnostics, null);
    return buildEnvelope("edit", result.diagnostics, {
        status: result.status,
        createdIds: result.createdIds,
        documentText: serializeShaderGraphDocument(result.document),
    });
}
