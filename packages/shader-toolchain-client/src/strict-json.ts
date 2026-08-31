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

/** A canonical lowercase SHA-256 identity. Preview publication contracts
 *  use this narrower spelling so one identity has one wire form. */
export function isLowerDigestHex(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export type DiagnosticArrayOutcome =
    | { readonly ok: true; readonly diagnostics: readonly ToolDiagnostic[] }
    | { readonly ok: false; readonly detail: string };

/**
 * Reads the published diagnostics array under the contract's own
 * tolerance rules: every entry must be an object carrying a `message`
 * string, and MAY carry a `sourceIdentity` string (the toolchain's own
 * location authority, emitted only when it holds one); a mis-typed
 * `sourceIdentity` rejects, and unknown fields inside an entry are
 * IGNORED, exactly as at the document top level — the contract owns its
 * tolerance policy. Carried message/sourceIdentity are what the client
 * records; entries are never reinterpreted.
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
        if (!("message" in entry)) {
            return { ok: false, detail: `diagnostics[${index}] is missing its message` };
        }
        const message = entry.message;
        if (!isString(message)) {
            return { ok: false, detail: `diagnostics[${index}].message is not a string` };
        }
        if ("sourceIdentity" in entry) {
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
