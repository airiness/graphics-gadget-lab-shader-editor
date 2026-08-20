/**
 * JSON value grammar — the only external shape core parse services accept.
 *
 * Callers (the GUI frontend, the CLI frontend, CI tooling) load the raw bytes
 * themselves, pass JSON text in, and receive result objects back. The core
 * never reads or writes files and never spawns processes.
 */

export interface JsonRecord {
    [key: string]: JsonValue;
}

export type JsonValue =
    | null
    | boolean
    | number
    | string
    | readonly JsonValue[]
    | JsonRecord;

export function isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: unknown): value is readonly JsonValue[] {
    return Array.isArray(value);
}

export function isJsonString(value: unknown): value is string {
    return typeof value === "string";
}

export function isJsonBoolean(value: unknown): value is boolean {
    return typeof value === "boolean";
}

export function isJsonNumber(value: unknown): value is number {
    return typeof value === "number";
}

/** Human-readable JSON kind for diagnostic messages. */
export function jsonKind(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "array";
    }
    return typeof value;
}

/** True if `record` carries its own property `key` (a JSON null counts). */
export function hasField(record: JsonRecord, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}
