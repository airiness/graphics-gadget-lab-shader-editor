/**
 * The CLI's structured in/out envelope.
 *
 * Every command — success or failure — produces exactly one envelope on
 * stdout: `ok`, the `command` name, structured `diagnostics` (the core's
 * diagnostic shape, extended with CLI-level stable codes for failures the
 * core does not own: bad arguments, missing files, unresolvable
 * descriptors), and a command-specific `payload`. Keys are built in a
 * fixed order so the serialized bytes of an identical request are
 * identical across runs and platforms.
 *
 * Machine protocol invariant (enforced centrally in `buildEnvelope`, so
 * no command can violate it): a failure envelope NEVER carries a payload —
 * `payload` is only present when `ok` is true.
 *
 * Stable CLI codes (never free-form, never reusing core code values):
 *
 *   INVALID_ARGUMENT      an unknown or malformed --option/positional
 *   MISSING_OPTION        a required --option was not supplied
 *   FILE_NOT_FOUND        a requested file does not exist
 *   FILE_UNREADABLE       a requested file exists but could not be read
 *   DESCRIPTOR_NOT_RESOLVED no compatible descriptor instance was found
 */
import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";

export const CliCode = {
    InvalidArgument: "INVALID_ARGUMENT",
    MissingArgument: "MISSING_ARGUMENT",
    MissingOption: "MISSING_OPTION",
    FileNotFound: "FILE_NOT_FOUND",
    FileUnreadable: "FILE_UNREADABLE",
    DescriptorNotResolved: "DESCRIPTOR_NOT_RESOLVED",
} as const;

export type CliCodeValue = (typeof CliCode)[keyof typeof CliCode];

/** One structured request/result: the only thing a CLI command prints. */
export interface CliEnvelope {
    readonly ok: boolean;
    readonly command: string;
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    readonly payload: unknown | null;
}

function cliDiagnostic(dataPath: string, code: CliCodeValue, message: string): ShaderGraphDiagnostic {
    return { code, severity: "error", message, dataPath };
}

export function cliDiagnosticAt(dataPath: string, code: CliCodeValue, message: string): ShaderGraphDiagnostic {
    return cliDiagnostic(dataPath, code, message);
}

export function buildEnvelope(
    command: string,
    diagnostics: readonly ShaderGraphDiagnostic[],
    payload: unknown | null,
): CliEnvelope {
    const ok = !diagnostics.some((diagnostic) => diagnostic.severity === "error");
    return { ok, command, diagnostics, payload: ok ? payload : null };
}

/** Serializes an envelope deterministically (fixed key order; 2-space indent with pretty). */
export function serializeEnvelope(envelope: CliEnvelope, pretty: boolean): string {
    return JSON.stringify(envelope, null, pretty ? 2 : undefined);
}
