/**
 * Minimal shared strict-decoding guards for the wire readers.
 *
 * The client consumes the toolchain's published machine documents as
 * serialized JSON (single-line documents on stdout, stderr left empty).
 * Both readers share this strictness floor: shapes are checked field by
 * field, unknown data is never silently reinterpreted, and a reader never
 * invents a missing fact — it rejects.
 */
import type { ToolDiagnostic } from "./contract-facts.js";

/** True for JSON objects (not arrays, not null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
    return typeof value === "string";
}

export function isBoolean(value: unknown): value is boolean {
    return typeof value === "boolean";
}

/** A JSON number that is a safe integer — the shape the exit codes and
 *  the process-contract version axis take on the wire. */
export function isIntegralNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value);
}

/** A 64-character hex digest (SHA-256) — the shape recipeId, buildKey,
 *  binaryHash, and artifactId hold on the wire. */
export function isDigestHex(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-fA-F]{64}$/u.test(value);
}

/**
 * The first key of `raw` that is not in the expected field set, or the
 * empty string when the object carries no unexpected field.
 */
export function firstUnknownField(raw: Record<string, unknown>, expected: readonly string[]): string {
    for (const key of Object.keys(raw)) {
        if (!expected.includes(key)) {
            return key;
        }
    }
    return "";
}

export type DiagnosticArrayOutcome =
    | { readonly ok: true; readonly diagnostics: readonly ToolDiagnostic[] }
    | { readonly ok: false; readonly detail: string };

/**
 * Reads the published diagnostics array strictly: every entry must be an
 * object with a `message` string and at most a `sourceIdentity` string —
 * no unknown keys, no untyped prose. Entries are carried verbatim; the
 * toolchain owns their meaning and location authority.
 */
export function readDiagnosticArray(raw: unknown): DiagnosticArrayOutcome {
    if (!Array.isArray(raw)) {
        return { ok: false, detail: "the diagnostics field is not a JSON array" };
    }
    const diagnostics: ToolDiagnostic[] = [];
    for (let index = 0; index < raw.length; index += 1) {
        const entry = raw[index];
        if (!isPlainObject(entry)) {
            return { ok: false, detail: `diagnostics[${index}] is not a JSON object` };
        }
        if (entry.message === undefined || entry.message === null) {
            return { ok: false, detail: `diagnostics[${index}] is missing its message` };
        }
        if (!isString(entry.message)) {
            return { ok: false, detail: `diagnostics[${index}].message is not a string` };
        }
        const unexpected = Object.keys(entry).find((key) => key !== "message" && key !== "sourceIdentity");
        if (unexpected !== undefined) {
            return { ok: false, detail: `diagnostics[${index}] carries the unknown field "${unexpected}"` };
        }
        const message = entry.message;
        if (entry.sourceIdentity !== undefined) {
            if (!isString(entry.sourceIdentity)) {
                return { ok: false, detail: `diagnostics[${index}].sourceIdentity is not a string` };
            }
            diagnostics.push({ message, sourceIdentity: entry.sourceIdentity });
            continue;
        }
        diagnostics.push({ message });
    }
    return { ok: true, diagnostics };
}
