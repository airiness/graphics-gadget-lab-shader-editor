/**
 * Deterministic argument parsing for the CLI: one positional model
 * (plain tokens) plus `--option value` pairs and `--flag`s. No third-party
 * dependency, no shell semantics: what the tokens say is exactly what the
 * command receives, and every deviation is a structured INVALID_ARGUMENT
 * (or MISSING_OPTION where an option was required but absent), never a
 * stack trace.
 */
import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import { CliCode, cliDiagnosticAt } from "./envelope.js";

export interface ParsedArgs {
    /** Positional tokens, in order. */
    readonly positionals: readonly string[];
    /** `--option value` pairs, in order. */
    readonly options: Map<string, string>;
    /** `--flag` tokens, in order. */
    readonly flags: ReadonlySet<string>;
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
    const positionals: string[] = [];
    const options = new Map<string, string>();
    const flags = new Set<string>();
    const diagnostics: ShaderGraphDiagnostic[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === undefined) {
            continue;
        }
        if (token.startsWith("--")) {
            const name = token.slice(2);
            const next = argv[index + 1];
            if (next !== undefined && !next.startsWith("--")) {
                if (options.has(name)) {
                    diagnostics.push(
                        cliDiagnosticAt(`$.args[${index}]`, CliCode.InvalidArgument, `Option "--${name}" was supplied more than once.`),
                    );
                    index += 1;
                    continue;
                }
                options.set(name, next);
                index += 1;
                continue;
            }
            if (next !== undefined || name === "help" || name === "pretty") {
                flags.add(name);
                continue;
            }
            diagnostics.push(
                cliDiagnosticAt(`$.args[${index}]`, CliCode.InvalidArgument, `Option "--${name}" requires a value.`),
            );
            continue;
        }
        positionals.push(token);
    }
    return { positionals, options, flags, diagnostics };
}

/** Extracts a required option, reporting a structured MISSING_OPTION when absent. */
export function requireOption(
    args: ParsedArgs,
    name: string,
    diagnostics: ShaderGraphDiagnostic[],
): string | undefined {
    const value = args.options.get(name);
    if (value === undefined && !args.flags.has(name)) {
        diagnostics.push(
            cliDiagnosticAt(`$.${name}`, CliCode.MissingOption, `Option "--${name}" is required by this command; use "--help" for usage.`),
        );
        return undefined;
    }
    return value;
}
