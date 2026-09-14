#!/usr/bin/env node
/**
 * Entry point for the machine/automation authoring frontend.
 *
 * The CLI is a thin frontend over the headless core: commands are
 * serializations of core-owned services (parse, validate, type resolution,
 * the shared profile × descriptor compatibility verdict, conformance, and
 * deterministic emission). Nothing here defines graph semantics, and no
 * native shader production is bypassed or imitated — compiling generated
 * HLSL remains `gglab-shaderc`'s domain.
 *
 * Machine contract (stable):
 *
 *   exit 0   command succeeded — one JSON envelope on stdout, payload set
 *   exit 1   command failed — the request was well-formed; the document,
 *            descriptor, or environment could not satisfy it (semantic
 *            codes, FILE_NOT_FOUND, FILE_UNREADABLE, DESCRIPTOR_NOT_RESOLVED)
 *   exit 2   invocation error — the call to the CLI itself was malformed
 *            (INVALID_ARGUMENT, MISSING_ARGUMENT, MISSING_OPTION, unknown
 *            command, no command, --help)
 *
 * Every envelope is `buildEnvelope`'s shape (ok / command / diagnostics /
 * payload), and the central invariant holds: a failure envelope never
 * carries a payload. Option grammars are per-command and strict
 * (command-grammar.ts): an unknown option, an extra positional, or an
 * option without a value is a usage error — never a silent no-op.
 */
import { COMMAND_GRAMMARS, parseCommandArgs, type KnownCommand, type ParsedArgs } from "./command-grammar.js";
import { runDescriptor } from "./commands/descriptor.js";
import { runEmit } from "./commands/emit.js";
import { runValidate } from "./commands/validate.js";
import { runEnvironment } from "./commands/environment.js";
import { runEdit } from "./commands/edit.js";
import { graphEditCommandCatalog } from "@gglab/shader-graph-core";
import { CliCode, buildEnvelope, serializeEnvelope, type CliEnvelope } from "./envelope.js";

export const KNOWN_COMMANDS = ["validate", "emit", "descriptor", "edit", "edit-commands", "environment-verify", "environment-discover", "environment-registry"] as const;
export type { KnownCommand } from "./command-grammar.js";

export function usageText(): string {
    return [
        "usage: shader-graph <command> [arguments] [options]",
        "",
        "commands:",
        "  environment-registry <absolute-registry-root> inspect saved locations; restored entries are unverified",
        "  environment-verify <absolute-environment-root> [--profiles]   verify immutable closure; no import or native readiness claim",
        "  environment-discover <absolute-repository-root> discover publisher deployment candidates; never select implicitly",
        "  edit <document> --commands <commands.json> [--descriptor <descriptor.json>]   apply core edits; return documentText without writing files",
        "  edit-commands                                                               inspect the core edit command vocabulary",
        "  validate <document> [--descriptor <descriptor.json> | --descriptors-dir <base>]   core authoring checks (+descriptor pairing)",
        "  emit <document> --descriptor <descriptor.json> | --descriptors-dir <base>  deterministic HLSL + source map + identity",
        "  descriptor <descriptor.json>                                                  inspect a descriptor instance",
        "",
        "options:",
        "  --help     print this usage (exit code 2)",
        "  --pretty   indent the JSON envelope",
        "",
        "grammar: exactly one positional per document command; edit-commands takes none; unknown options are rejected.",
        "   (a typo'd option is an error, never silently ignored)",
        "",
        "exit codes: 0 command succeeded (payload set); 1 command failed — the request was well-formed",
        "             (semantic/diagnostic payload null, diagnostics set); 2 invocation error (usage).",
        "stdout: exactly one JSON envelope for a command run; usage text for usage.",
    ].join("\n");
}

export interface CommandSink {
    readonly write: (text: string) => void;
}

const defaultSink: CommandSink = {
    write(text: string): void {
        process.stdout.write(text);
    },
};

/**
 * Exit-code classification (central, so no command can misclassify):
 * 0 = success; 2 = invocation/usage failure (every error diagnostic is a
 * usage code); 1 = the request was well-formed but the command failed
 * (semantic, document, descriptor-resolution, or environment codes —
 * including FILE_NOT_FOUND / FILE_UNREADABLE / DESCRIPTOR_NOT_RESOLVED).
 */
const USAGE_FAILURE_CODES: ReadonlySet<string> = new Set([CliCode.InvalidArgument, CliCode.MissingArgument, CliCode.MissingOption]);

export function classifyExitCode(envelope: CliEnvelope): number {
    if (envelope.ok) {
        return 0;
    }
    const errors = envelope.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    return errors.length > 0 && errors.every((diagnostic) => USAGE_FAILURE_CODES.has(diagnostic.code)) ? 2 : 1;
}

export function dispatch(command: string, argv: readonly string[]): { code: number; sinkText: string } {
    if (command !== "validate" && command !== "emit" && command !== "descriptor" && command !== "edit" && command !== "edit-commands" && command !== "environment-verify" && command !== "environment-discover" && command !== "environment-registry") {
        const envelope = buildEnvelope(command, [
            {
                code: "INVALID_ARGUMENT",
                severity: "error",
                message: `Unknown command "${command}" (available: ${KNOWN_COMMANDS.join(", ")}). Run with "--help" for usage.`,
                dataPath: "$.command",
            },
        ], null);
        return { code: 2, sinkText: `${serializeEnvelope(envelope, argv.includes("--pretty"))}\n` };
    }
    const grammar = COMMAND_GRAMMARS[command as KnownCommand];
    const args: ParsedArgs = parseCommandArgs(grammar, command, argv);
    if (args.flags.has("help")) {
        return { code: 2, sinkText: `${usageText()}\n` };
    }
    if (args.diagnostics.length > 0) {
        const envelope = buildEnvelope(command, args.diagnostics, null);
        return { code: classifyExitCode(envelope), sinkText: `${serializeEnvelope(envelope, args.flags.has("pretty"))}\n` };
    }
    const envelope = command === "environment-verify" || command === "environment-discover" || command === "environment-registry" ? runEnvironment(command, args) : command === "edit" ? runEdit(args) : command === "edit-commands" ? buildEnvelope(command, [], graphEditCommandCatalog) : command === "validate" ? runValidate(args) : command === "emit" ? runEmit(args) : runDescriptor(args);
    const code = classifyExitCode(envelope);
    return { code, sinkText: `${serializeEnvelope(envelope, args.flags.has("pretty"))}\n` };
}

/** Runs the CLI over an argv slice; returns the process exit code. */
export function main(argv: readonly string[], sink: CommandSink = defaultSink): number {
    const command = argv[0];
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
        sink.write(`${usageText()}\n`);
        return 2;
    }
    const result = dispatch(command, argv.slice(1));
    sink.write(result.sinkText);
    return result.code;
}
