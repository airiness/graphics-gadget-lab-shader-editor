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
 * Contract for machines (stable):
 *
 *   usage errors      exit code 2, usage text on stdout
 *   command failures  exit code 1, one JSON envelope on stdout
 *   command success   exit code 0, one JSON envelope on stdout (payload set)
 *
 * Every envelope is `buildEnvelope`'s shape: ok / command / diagnostics /
 * payload, serialized with fixed key order so identical requests produce
 * identical bytes.
 */
import { parseArgs, type ParsedArgs } from "./args.js";
import { runDescriptor } from "./commands/descriptor.js";
import { runEmit } from "./commands/emit.js";
import { runValidate } from "./commands/validate.js";
import { serializeEnvelope, type CliEnvelope } from "./envelope.js";

export const KNOWN_COMMANDS = ["validate", "emit", "descriptor"] as const;
export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

export function usageText(): string {
    return [
        "usage: shader-graph <command> [arguments] [options]",
        "",
        "commands:",
        "  validate <document> [--descriptor <descriptor.json> | --descriptors-dir <base>]   core authoring checks (+descriptor pairing)",
        "  emit <document> --descriptor <descriptor.json> | --descriptors-dir <base>  deterministic HLSL + source map + identity",
        "  descriptor <descriptor.json>                                                  inspect a descriptor instance",
        "",
        "options:",
        "  --help     print this usage (exit code 2)",
        "  --pretty   indent the JSON envelope",
        "",
        "exit codes: 0 command succeeded, 1 command failed (diagnostics set), 2 usage error.",
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

export function dispatch(command: string, args: ParsedArgs): { code: number; sinkText: string } {
    if (args.flags.has("help") || args.options.has("help")) {
        return { code: 2, sinkText: `${usageText()}\n` };
    }
    const pretty = args.flags.has("pretty");
    if (command !== "validate" && command !== "emit" && command !== "descriptor") {
        const unknownEnvelope: CliEnvelope = {
            ok: false,
            command: command,
            diagnostics: [
                {
                    code: "INVALID_ARGUMENT",
                    severity: "error",
                    message: `Unknown command "${command}" (available: ${KNOWN_COMMANDS.join(", ")}). Run with "--help" for usage.`,
                    dataPath: "$.command",
                },
            ],
            payload: null,
        };
        return { code: 2, sinkText: `${serializeEnvelope(unknownEnvelope, pretty)}\n` };
    }
    const envelope = command === "validate" ? runValidate(args) : command === "emit" ? runEmit(args) : runDescriptor(args);
    const code = envelope.ok ? 0 : 1;
    return { code, sinkText: `${serializeEnvelope(envelope, pretty)}\n` };
}

/** Runs the CLI over an argv slice; returns the process exit code. */
export function main(argv: readonly string[], sink: CommandSink = defaultSink): number {
    const command = argv[0];
    const rest = argv.slice(1);
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
        sink.write(`${usageText()}\n`);
        return 2;
    }
    const args = parseArgs(rest);
    const result = dispatch(command, args);
    sink.write(result.sinkText);
    return result.code;
}
