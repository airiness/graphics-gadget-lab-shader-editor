import { EnvironmentContractError, environmentCanonical, environmentDiagnostic, environmentExact, environmentObject, environmentRequire, parseEnvironmentJson, type EnvironmentDiagnostic } from "./environment-contract.js";
import { prepareEnvironmentImport, validateEnvironmentFinalProof, validateEnvironmentStateRoots, type EnvironmentImportEvent, type EnvironmentImportHost, type EnvironmentImportOutcome, type EnvironmentRegistration } from "./environment-import.js";

/** Editor-owned operational metadata. Native proof and active workspace selection are deliberately not persisted. */
export interface EnvironmentRegistryRecord {
    readonly registryVersion: 1;
    readonly environmentId: string;
    readonly environmentRoot: string;
    readonly stateRoot: string;
}
export type EnvironmentRegistryEntry =
    | { readonly key: string; readonly text: string }
    | { readonly key: string; readonly diagnostic: EnvironmentDiagnostic };
export interface EnvironmentRegistryScan { readonly entries: readonly EnvironmentRegistryEntry[]; readonly pending: readonly string[] }
export interface EnvironmentRegistryStorage {
    scan(): Promise<EnvironmentRegistryScan>;
    /** Atomic no-replace commit. Returns the committed winner, including when another process wins. */
    insert(key: string, text: string): Promise<{ readonly text: string; readonly inserted: boolean }>;
}
export interface EnvironmentRegistrySnapshot {
    readonly records: readonly { readonly record: EnvironmentRegistryRecord; readonly readiness: "unverified" }[];
    readonly diagnostics: readonly EnvironmentDiagnostic[];
    readonly pending: readonly string[];
}
export function environmentRegistryKey(environmentId: string): string {
    environmentRequire(/^sha256:[0-9a-f]{64}$/.test(environmentId), "identity-mismatch", "Invalid registered Environment identity", "$.environmentId");
    return environmentId.slice(7);
}
export function readEnvironmentRegistryRecord(text: string): EnvironmentRegistryRecord {
    const r = environmentObject(parseEnvironmentJson(text));
    environmentRequire(r.registryVersion === 1, "unsupported-version", "Unsupported registryVersion", "$.registryVersion");
    environmentExact(r, ["registryVersion", "environmentId", "environmentRoot", "stateRoot"]);
    environmentRequire(typeof r.environmentId === "string" && typeof r.environmentRoot === "string" && typeof r.stateRoot === "string", "invalid-shape", "Invalid registry fields");
    environmentRegistryKey(r.environmentId);
    validateEnvironmentStateRoots(r.environmentRoot, r.stateRoot);
    for (const root of [r.environmentRoot, r.stateRoot]) {
        environmentRequire(!root.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1)?.toLowerCase().startsWith(".staging-"), "incomplete-publication", "Registry cannot reference staging");
    }
    return r as unknown as EnvironmentRegistryRecord;
}
const pathKey = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export function sameEnvironmentRegistration(a: EnvironmentRegistryRecord, b: EnvironmentRegistryRecord): boolean {
    return a.environmentId === b.environmentId && pathKey(a.environmentRoot) === pathKey(b.environmentRoot) && pathKey(a.stateRoot) === pathKey(b.stateRoot);
}
export function projectEnvironmentRegistrySnapshot(scan: EnvironmentRegistryScan): EnvironmentRegistrySnapshot {
    const records: EnvironmentRegistrySnapshot["records"][number][] = [], diagnostics: EnvironmentDiagnostic[] = [];
    const seen = new Set<string>();
    for (const entry of scan.entries) {
        try {
            if ("diagnostic" in entry) { diagnostics.push(entry.diagnostic); continue; }
            const record = readEnvironmentRegistryRecord(entry.text);
            environmentRequire(environmentRegistryKey(record.environmentId) === entry.key && !seen.has(entry.key), "registry-conflict", "Registry key does not match its unique record", entry.key);
            seen.add(entry.key); records.push({ record, readiness: "unverified" });
        } catch (error) { diagnostics.push({ ...environmentDiagnostic(error), dataPath: entry.key }); }
    }
    return { records, diagnostics, pending: scan.pending };
}
export class EnvironmentRegistry {
    constructor(private readonly storage: EnvironmentRegistryStorage) {}
    async snapshot(): Promise<EnvironmentRegistrySnapshot> {
        const scan = await this.storage.scan();
        return projectEnvironmentRegistrySnapshot(scan);
    }
    async register(registration: EnvironmentRegistration): Promise<"registered" | "already-registered"> {
        validateEnvironmentFinalProof(registration.closure, registration.state, registration.proof);
        environmentRequire(registration.state.environmentId === registration.closure.manifest.environmentId, "state-conflict", "State identity differs from closure");
        const record = readEnvironmentRegistryRecord(environmentCanonical({ registryVersion: 1, environmentId: registration.closure.manifest.environmentId, environmentRoot: registration.closure.root, stateRoot: registration.state.root }));
        const key = environmentRegistryKey(record.environmentId);
        // A pre-existing record is not overwritten, even when the new caller presents fresh proof.
        const before = await this.storage.scan();
        const previous = before.entries.find(e => e.key === key);
        if (previous) {
            if ("diagnostic" in previous) throw new EnvironmentContractError(previous.diagnostic.code, previous.diagnostic.message, previous.diagnostic.dataPath);
            environmentRequire(sameEnvironmentRegistration(readEnvironmentRegistryRecord(previous.text), record), "registry-conflict", "Environment already has another root/state binding", key);
            return "already-registered";
        }
        const committed = await this.storage.insert(key, environmentCanonical(record) + "\n");
        const winner = readEnvironmentRegistryRecord(committed.text);
        environmentRequire(sameEnvironmentRegistration(winner, record), "registry-conflict", "Concurrent registration committed another binding", key);
        return committed.inserted ? "registered" : "already-registered";
    }
}
export interface EnvironmentRecoveryHost extends Pick<EnvironmentImportHost, "verifyFinal" | "proveFinal"> {
    /** Must inspect existing state only. Missing/corrupt state is a refusal, never an initialization request. */
    recoverExistingState: EnvironmentImportHost["initializeOrRecoverState"];
}
/** Every restart performs fresh final-path verification/proof. A saved record is never itself native evidence. */
export async function recoverEnvironmentRegistration(registry: EnvironmentRegistry, record: EnvironmentRegistryRecord, host: EnvironmentRecoveryHost, cancelled: () => boolean, emit?: (event: EnvironmentImportEvent) => void): Promise<EnvironmentImportOutcome> {
    let checked: EnvironmentRegistryRecord;
    try {
        checked = readEnvironmentRegistryRecord(environmentCanonical(record));
        const snapshot = await registry.snapshot();
        environmentRequire(snapshot.records.some(r => sameEnvironmentRegistration(r.record, checked)), "registry-conflict", "Registration is absent or unreadable before recovery");
    } catch (error) {
        const diagnostic = environmentDiagnostic(error);
        try { emit?.({ phase: "settled", environmentRoot: record.environmentRoot, stateRoot: record.stateRoot, diagnostic }); } catch { /* Evidence observers do not own recovery. */ }
        return { status: "refused", diagnostic, retainedStateRoot: null, registrationMayHaveCommitted: false };
    }
    const outcome = await prepareEnvironmentImport({
        verifyFinal: async root => {
            const closure = await host.verifyFinal(root);
            environmentRequire(closure.manifest.environmentId === checked.environmentId, "identity-mismatch", "Registered Environment was replaced", "$.environmentId");
            return closure;
        },
        initializeOrRecoverState: (...args) => host.recoverExistingState(...args),
        proveFinal: (...args) => host.proveFinal(...args),
        register: async () => {
            const snapshot = await registry.snapshot();
            const current = snapshot.records.find(r => r.record.environmentId === checked.environmentId);
            environmentRequire(current && sameEnvironmentRegistration(current.record, checked), "registry-conflict", "Registration changed or became unreadable during recovery");
            return "already-registered";
        },
    }, checked.environmentRoot, checked.stateRoot, cancelled, emit);
    // Recovery only checks a saved binding; its final callback cannot commit a registration.
    return outcome.status === "refused" ? { ...outcome, registrationMayHaveCommitted: false } : outcome;
}

/** Production composition can supply native services without giving them registry-format ownership. */
export function withEnvironmentRegistry(host: Omit<EnvironmentImportHost, "register">, registry: EnvironmentRegistry): EnvironmentImportHost {
    return {
        verifyFinal: (...args) => host.verifyFinal(...args),
        initializeOrRecoverState: (...args) => host.initializeOrRecoverState(...args),
        proveFinal: (...args) => host.proveFinal(...args),
        register: registration => registry.register(registration),
    };
}
