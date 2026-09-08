/**
 * Per-command argument grammars and strict parsing.
 *
 * Every command declares exactly which positionals it takes (an exact
 * count), which `--option value` pairs it admits, and which valueless
 * flags it admits. The parser then rejects, as structured diagnostics,
 * everything else — an unknown option (a typo), a positional beyond the
 * count, a value-option without a value, and a value-option whose value
 * would swallow another token beginning with `--`. A generic parser must
 * never guess whether `--foo` is a flag or a value option, and no
 * unrecognized token may be silently ignored: for a machine surface,
 * quiet degradation of the request (for example a typo'd `--descripter`
 * silently downgrading profile-bound validation to document-only
 * validation and then exiting 0) is a protocol violation, not a
 * convenience.
 *
 * Grammar violations are usage errors: they are reported with the stable
 * CLI codes INVALID_ARGUMENT / MISSING_ARGUMENT / MISSING_OPTION and the
 * process exits 2 (classified in index.ts), never 0 or 1.
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

/** The exact option grammar of one command. */
export interface CommandGrammar {
    /** Exact positional count the command requires. */
    readonly positionalCount: number;
    /** Options that take exactly one value (`--option value`). */
    readonly valueOptions: readonly string[];
    /** Valueless flags (`--flag`). */
    readonly flags: readonly string[];
}

export const COMMAND_GRAMMARS = {
    "environment-registry": { positionalCount: 1, valueOptions: [], flags: ["pretty", "help"] },
    "environment-verify": { positionalCount: 1, valueOptions: [], flags: ["pretty", "help", "profiles"] },
    "environment-discover": { positionalCount: 1, valueOptions: [], flags: ["pretty", "help"] },
    edit: {
        positionalCount: 1,
        valueOptions: ["commands", "descriptor"],
        flags: ["pretty", "help"],
    },
    "edit-commands": {
        positionalCount: 0,
        valueOptions: [],
        flags: ["pretty", "help"],
    },
    validate: {
        positionalCount: 1,
        valueOptions: ["descriptor", "descriptors-dir"],
        flags: ["pretty", "help"],
    },
    emit: {
        positionalCount: 1,
        valueOptions: ["descriptor", "descriptors-dir"],
        flags: ["pretty", "help"],
    },
    descriptor: {
        positionalCount: 1,
        valueOptions: [],
        flags: ["pretty", "help"],
    },
} as const;

export type KnownCommand = keyof typeof COMMAND_GRAMMARS;

function describeGrammar(grammar: CommandGrammar): string {
    const valueOptions = grammar.valueOptions.length > 0 ? `--${grammar.valueOptions.join(", --")} <value>` : "";
    const flags = grammar.flags.length > 0 ? `--${grammar.flags.join(", --")}` : "";
    return `${valueOptions ? valueOptions + " " : ""}${flags}`.trim();
}

/**
 * Parses argv for one command under its grammar. All diagnostics that are
 * present mean "this invocation is malformed" — the command must not run.
 */
export function parseCommandArgs(grammar: CommandGrammar, commandName: string, argv: readonly string[]): ParsedArgs {
    const positionals: string[] = [];
    const options = new Map<string, string>();
    const flags = new Set<string>();
    const diagnostics: ShaderGraphDiagnostic[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === undefined) {
            continue;
        }
        if (!token.startsWith("--")) {
            positionals.push(token);
            continue;
        }
        const name = token.slice(2);
        const at = `$.args[${index}]`;
        if (grammar.flags.includes(name)) {
            flags.add(name);
            continue;
        }
        if (grammar.valueOptions.includes(name)) {
            const next = argv[index + 1];
            if (next === undefined || next.startsWith("--")) {
                diagnostics.push(
                    cliDiagnosticAt(at, CliCode.InvalidArgument, `Option "--${name}" requires a value (the value may not itself be a token beginning with "--").`),
                );
                index += 1;
                continue;
            }
            if (options.has(name)) {
                diagnostics.push(cliDiagnosticAt(at, CliCode.InvalidArgument, `Option "--${name}" was supplied more than once.`));
                index += 1;
                continue;
            }
            options.set(name, next);
            index += 1;
            continue;
        }
        diagnostics.push(
            cliDiagnosticAt(
                at,
                CliCode.InvalidArgument,
                `Unknown option "--${name}" for "${commandName}" (this command accepts: ${describeGrammar(grammar)}). Spelling it differently will not silently change what the command does.`,
            ),
        );
    }
    if (positionals.length < grammar.positionalCount) {
        diagnostics.push(
            cliDiagnosticAt("$.args", CliCode.MissingArgument, `Command "${commandName}" requires ${grammar.positionalCount} positional argument(s); ${positionals.length} given.`),
        );
    } else if (positionals.length > grammar.positionalCount) {
        diagnostics.push(
            cliDiagnosticAt("$.args", CliCode.InvalidArgument, `Command "${commandName}" accepts exactly ${grammar.positionalCount} positional argument(s); ${positionals.length} given. Extra arguments are not ignored.`),
        );
    }
    return { positionals, options, flags, diagnostics };
}
