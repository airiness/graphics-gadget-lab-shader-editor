/**
 * Shared helpers for strict JSON-shape parsing.
 *
 * Every helper reports against a dot-separated data path and returns
 * `undefined` when the value is missing or mistyped, so a caller can collect
 * every diagnostic of an input instead of stopping at the first one.
 */
import type { DiagnosticCodeValue, ShaderGraphDiagnostic } from "./diagnostics.js";
import { DiagnosticCode } from "./diagnostics.js";
import { isJsonArray, isJsonBoolean, isJsonNumber, isJsonRecord, isJsonString, jsonKind } from "./json-value.js";
import type { JsonRecord, JsonValue } from "./json-value.js";

export function errorAt(dataPath: string, code: DiagnosticCodeValue, message: string): ShaderGraphDiagnostic {
    return { code, severity: "error", message, dataPath };
}

export function warnAt(dataPath: string, code: DiagnosticCodeValue, message: string): ShaderGraphDiagnostic {
    return { code, severity: "warning", message, dataPath };
}

/** Returns the field value, or `undefined` when the key is absent. */
export function takeField(record: JsonRecord, key: string): JsonValue | undefined {
    return Object.prototype.hasOwnProperty.call(record, key) ? (record[key] as JsonValue) : undefined;
}

function requireField(record: JsonRecord, key: string, path: string, diagnostics: ShaderGraphDiagnostic[]): JsonValue | undefined {
    const value = takeField(record, key);
    if (value === undefined) {
        diagnostics.push(errorAt(`${path}.${key}`, DiagnosticCode.MissingRequiredField, `Required field "${key}" is missing.`));
        return undefined;
    }
    return value;
}

export function requireString(record: JsonRecord, key: string, path: string, diagnostics: ShaderGraphDiagnostic[]): string | undefined {
    const value = requireField(record, key, path, diagnostics);
    if (value === undefined) {
        return undefined;
    }
    if (!isJsonString(value) || value.length === 0) {
        diagnostics.push(errorAt(`${path}.${key}`, DiagnosticCode.UnexpectedType, `Expected a non-empty string, got ${jsonKind(value)}.`));
        return undefined;
    }
    return value;
}

export function requireInteger(record: JsonRecord, key: string, path: string, diagnostics: ShaderGraphDiagnostic[]): number | undefined {
    const value = requireField(record, key, path, diagnostics);
    if (value === undefined) {
        return undefined;
    }
    if (!isJsonNumber(value) || !Number.isInteger(value)) {
        diagnostics.push(errorAt(`${path}.${key}`, DiagnosticCode.UnexpectedType, `Expected an integer, got ${jsonKind(value)}.`));
        return undefined;
    }
    return value;
}

export function requireBoolean(record: JsonRecord, key: string, path: string, diagnostics: ShaderGraphDiagnostic[]): boolean | undefined {
    const value = requireField(record, key, path, diagnostics);
    if (value === undefined) {
        return undefined;
    }
    if (!isJsonBoolean(value)) {
        diagnostics.push(errorAt(`${path}.${key}`, DiagnosticCode.UnexpectedType, `Expected a boolean, got ${jsonKind(value)}.`));
        return undefined;
    }
    return value;
}

export function requireStringArray(record: JsonRecord, key: string, path: string, diagnostics: ShaderGraphDiagnostic[]): readonly string[] | undefined {
    const value = requireField(record, key, path, diagnostics);
    if (value === undefined) {
        return undefined;
    }
    if (!isJsonArray(value) || !value.every((item) => isJsonString(item))) {
        diagnostics.push(errorAt(`${path}.${key}`, DiagnosticCode.UnexpectedType, `Expected an array of strings, got ${jsonKind(value)}.`));
        return undefined;
    }
    return value as readonly string[];
}

/**
 * Requires `key` to be exactly the given literal. This is how a reader
 * rejects vocabulary it does not support: expected values are spelled into
 * the diagnostic. The return type preserves the caller's literal type.
 */
export function requireLiteral<T extends string>(
    record: JsonRecord,
    key: string,
    path: string,
    expected: T,
    diagnostics: ShaderGraphDiagnostic[],
): T | undefined {
    const value = requireString(record, key, path, diagnostics);
    if (value === undefined) {
        return undefined;
    }
    if (value !== expected) {
        diagnostics.push(errorAt(`${path}.${key}`, DiagnosticCode.UnexpectedType, `Expected "${expected}", got "${value}".`));
        return undefined;
    }
    return value as T;
}

/** Requires a required object field and reports missing/mistyped values. */
export function takeObject(record: JsonRecord, key: string, path: string, diagnostics: ShaderGraphDiagnostic[]): JsonRecord | undefined {
    const value = takeField(record, key);
    if (value === undefined) {
        diagnostics.push(errorAt(`${path}.${key}`, DiagnosticCode.MissingRequiredField, `Required field "${key}" is missing.`));
        return undefined;
    }
    if (!isJsonRecord(value)) {
        diagnostics.push(errorAt(`${path}.${key}`, DiagnosticCode.UnexpectedType, `Expected a JSON object, got ${jsonKind(value)}.`));
        return undefined;
    }
    return value;
}

/** Requires a required array field and reports missing/mistyped values. */
export function takeArray(record: JsonRecord, key: string, path: string, diagnostics: ShaderGraphDiagnostic[]): readonly JsonValue[] | undefined {
    const value = takeField(record, key);
    if (value === undefined) {
        diagnostics.push(errorAt(`${path}.${key}`, DiagnosticCode.MissingRequiredField, `Required field "${key}" is missing.`));
        return undefined;
    }
    if (!isJsonArray(value)) {
        diagnostics.push(errorAt(`${path}.${key}`, DiagnosticCode.UnexpectedType, `Expected a JSON array, got ${jsonKind(value)}.`));
        return undefined;
    }
    return value;
}

/** Reports every field not in `allowed` as an explicit failure. */
export function rejectUnknownFields(record: JsonRecord, allowed: readonly string[], path: string, diagnostics: ShaderGraphDiagnostic[]): void {
    for (const key of Object.keys(record)) {
        if (allowed.includes(key)) {
            continue;
        }
        diagnostics.push(errorAt(`${path}.${key}`, DiagnosticCode.UnexpectedField, `Field "${key}" is not part of the supported shape at ${path}.`));
    }
}
