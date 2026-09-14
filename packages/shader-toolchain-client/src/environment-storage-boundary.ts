import { environmentExact, environmentObject, environmentRequire, isEnvironmentHash, type EnvironmentHash } from "./environment-contract.js";
import { environmentAbsolutePath } from "./environment-protocol.js";
import { verifyEnvironmentClosure, type EnvironmentEntry } from "./environment-closure.js";
import { ENVIRONMENT_STATE_ROLES } from "./environment-contract.js";
import { readEnvironmentStateBinding, type VerifiedEnvironmentClosure } from "./environment-import.js";
import { type EnvironmentRegistryScan } from "./environment-registry.js";

export interface EnvironmentDirectoryHandle { readonly directoryId: string; readonly root: string; readonly kind: "environment" | "state" }
export function readEnvironmentDirectoryHandle(value: unknown): EnvironmentDirectoryHandle {
    const h = environmentExact(value, ["directoryId", "root", "kind"]);
    environmentRequire(typeof h.directoryId === "string" && /^environment-directory:[1-9][0-9]*$/.test(h.directoryId), "invalid-handle", "Invalid directory handle");
    environmentRequire(typeof h.root === "string" && (h.kind === "environment" || h.kind === "state"), "invalid-shape", "Invalid directory selection");
    environmentAbsolutePath(h.root);
    return h as unknown as EnvironmentDirectoryHandle;
}
function observation(handle: EnvironmentDirectoryHandle, raw: unknown) {
    const o = environmentExact(raw, ["directoryId", "root", "kind", "entries", "metadataText"]);
    environmentRequire(o.directoryId === handle.directoryId && o.root === handle.root && o.kind === handle.kind, "proof-mismatch", "Directory observation belongs to another selection");
    environmentRequire(o.metadataText === null || (typeof o.metadataText === "string" && o.metadataText.length <= 16 * 1024 * 1024), "invalid-shape", "Invalid metadata text");
    environmentRequire(Array.isArray(o.entries) && o.entries.length <= 30000, "limit-exceeded", "Invalid directory inventory");
    const entries = o.entries.map(raw => {
        const e = environmentExact(raw, ["path", "kind", "reparsePoint", "linkCount", "size", "sha256"]);
        environmentRequire(typeof e.path === "string" && ["file", "directory", "other"].includes(e.kind as string) && typeof e.reparsePoint === "boolean" && typeof e.linkCount === "number" && Number.isSafeInteger(e.linkCount) && e.linkCount >= 0, "invalid-shape", "Invalid entry facts");
        environmentRequire(e.size === null || (typeof e.size === "number" && Number.isSafeInteger(e.size) && e.size >= 0), "invalid-shape", "Invalid file size");
        environmentRequire(e.sha256 === null || isEnvironmentHash(e.sha256), "invalid-shape", "Invalid file digest");
        return e as unknown as EnvironmentEntry & { size: number | null; sha256: string | null };
    });
    return { entries, text: o.metadataText };
}
/** The existing verifier remains the sole manifest/identity authority; IPC supplies only observed facts. */
export function verifyEnvironmentObservation(handle: EnvironmentDirectoryHandle, raw: unknown, hashAscii: EnvironmentHash): VerifiedEnvironmentClosure {
    environmentRequire(handle.kind === "environment", "invalid-handle", "Expected an Environment selection");
    const o = observation(handle, raw);
    const byPath = new Map(o.entries.map(e => [e.path, e]));
    return verifyEnvironmentClosure({ hashAscii, assertOrdinaryRoot: () => handle.root, entries: () => o.entries, readManifest: () => o.text,
        hashMember: (_root, locator) => {
            const e = byPath.get(locator);
            environmentRequire(e && e.kind === "file" && e.size !== null && e.sha256 !== null, "missing-member", "Missing member observation", locator);
            return { size: e.size, sha256: e.sha256 };
        },
    }, handle.root);
}
export function inspectEnvironmentStateObservation(handle: EnvironmentDirectoryHandle, raw: unknown, closure: VerifiedEnvironmentClosure) {
    environmentRequire(handle.kind === "state", "invalid-handle", "Expected a state selection");
    const o = observation(handle, raw);
    environmentRequire(!handle.root.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1)?.toLowerCase().startsWith(".staging-"), "incomplete-publication", "Staging state is not usable");
    const seen = new Set<string>();
    for (const e of o.entries) {
        environmentRequire(!e.reparsePoint && e.kind !== "other" && (e.kind !== "file" || e.linkCount === 1), "invalid-member", "Linked or non-regular state entry", e.path);
        environmentRequire(!seen.has(e.path.toLowerCase()), "path-conflict", "Duplicate state entry", e.path); seen.add(e.path.toLowerCase());
    }
    for (const role of new Set(Object.values(ENVIRONMENT_STATE_ROLES))) environmentRequire(o.entries.some(e => e.path === role && e.kind === "directory"), "missing-member", "Missing state directory", role);
    environmentRequire(o.text !== null && o.entries.some(e => e.path === "state.json" && e.kind === "file"), "missing-member", "Missing state binding");
    return readEnvironmentStateBinding(o.text, handle.root, closure);
}
export function readEnvironmentRegistryScan(raw: unknown): EnvironmentRegistryScan {
    const s = environmentExact(raw, ["entries", "pending"]);
    environmentRequire(Array.isArray(s.entries) && Array.isArray(s.pending) && s.entries.length + s.pending.length <= 1024, "limit-exceeded", "Invalid registry scan");
    const pending = s.pending.map(name => { environmentRequire(typeof name === "string" && /^\.pending-[0-9a-f-]{36}$/.test(name), "invalid-shape", "Invalid pending entry"); return name; });
    const entries = s.entries.map(raw => {
        const entry = environmentExact(raw, Object.hasOwn(environmentObject(raw), "text") ? ["key", "text"] : ["key", "diagnostic"]);
        environmentRequire(typeof entry.key === "string", "invalid-shape", "Invalid registry entry key");
        if ("text" in entry) { environmentRequire(typeof entry.text === "string" && entry.text.length <= 65536, "limit-exceeded", "Invalid registry record text"); return { key: entry.key, text: entry.text }; }
        const d = environmentExact(entry.diagnostic, ["code", "message", "dataPath"]);
        environmentRequire(typeof d.code === "string" && typeof d.message === "string" && typeof d.dataPath === "string", "invalid-shape", "Invalid registry diagnostic");
        return { key: entry.key, diagnostic: { code: d.code, message: d.message, dataPath: d.dataPath, severity: "error" as const } };
    });
    return { entries, pending };
}
