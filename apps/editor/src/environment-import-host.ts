import { sha256Hex } from "@gglab/shader-graph-core";
import type { ShaderGraphDocument } from "@gglab/shader-graph-core";
import { EnvironmentContractError, EnvironmentRegistry, environmentExact, environmentHostDiagnostic, environmentRequire, inspectEnvironmentStateObservation, prepareEnvironmentImport, readEnvironmentDirectoryHandle, readEnvironmentRegistryRecord, readEnvironmentRegistryScan, sameEnvironmentRegistration, utf8Encode, validateEnvironmentFinalProof, verifyEnvironmentObservation, type EnvironmentDirectoryHandle, type EnvironmentImportEvent, type EnvironmentRegistration } from "@gglab/shader-toolchain-client";
import { createEnvironmentProofHost } from "./environment-proof-host.js";
import { createEnvironmentStorageHost } from "./environment-storage-host.js";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
/** Actual proof is private to this composition; callers cannot supply a serialized proof or registry record. */
export function createEnvironmentImportHost(invoke: Invoke) {
    const call: Invoke = async (command, args) => { try { return await invoke(command, args); } catch (error) { const d = environmentHostDiagnostic(error); throw new EnvironmentContractError(d.code, d.message, d.dataPath); } };
    const storage = createEnvironmentStorageHost(call), proof = createEnvironmentProofHost(call);
    let busy = false, canceled = false;
    async function register(registration: EnvironmentRegistration, environment: EnvironmentDirectoryHandle, state: EnvironmentDirectoryHandle, isCanceled: () => boolean) {
        const raw = environmentExact(await call("shader-environment-prepare-registration", { environmentDirectoryId: environment.directoryId, stateDirectoryId: state.directoryId }), ["registrationId", "environment", "state"]);
        environmentRequire(typeof raw.registrationId === "string" && /^environment-registration:[1-9][0-9]*$/.test(raw.registrationId), "invalid-handle", "Invalid registration admission");
        const registrationId = raw.registrationId;
        let dispatched = false;
        try {
            const closure = verifyEnvironmentObservation(environment, raw.environment, text => sha256Hex(utf8Encode(text)));
            const binding = inspectEnvironmentStateObservation(state, raw.state, closure);
            validateEnvironmentFinalProof(closure, binding, registration.proof);
            environmentRequire(!isCanceled(), "cancelled", "Import cancelled before registry commit");
            const expected = { registryVersion: 1 as const, environmentId: closure.manifest.environmentId, environmentRoot: closure.root, stateRoot: binding.root };
            const registry: EnvironmentRegistry = new EnvironmentRegistry({
                scan: async () => readEnvironmentRegistryScan(await call("shader-environment-registry-scan")),
                insert: async (_key, text) => {
                    environmentRequire(sameEnvironmentRegistration(readEnvironmentRegistryRecord(text), expected), "registry-conflict", "Registration projection changed");
                    environmentRequire(!isCanceled(), "cancelled", "Import cancelled before registry commit");
                    dispatched = true;
                    try {
                        const r = environmentExact(await call("shader-environment-commit-registration", { registrationId }), ["text", "inserted"]);
                        environmentRequire(typeof r.text === "string" && typeof r.inserted === "boolean", "invalid-shape", "Invalid registry commit result");
                        return { text: r.text, inserted: r.inserted };
                    } catch (error) {
                        // The atomic rename may have won before acknowledgement was lost. Do not invent rollback.
                        const snapshot = await registry.snapshot();
                        const found = snapshot.records.find(r => r.record.environmentId === expected.environmentId);
                        if (found && sameEnvironmentRegistration(found.record, expected)) return { text: JSON.stringify(found.record), inserted: false };
                        throw error;
                    }
                },
            });
            return await registry.register({ closure, state: binding, proof: registration.proof });
        } finally {
            // A dispatched one-use token is consumed natively. Cleanup cannot turn a committed result into refusal.
            if (!dispatched) await call("shader-environment-discard-registration", { registrationId });
        }
    }
    return {
        snapshot: () => storage.snapshot(),
        async close() { environmentRequire(!busy, "host-busy", "Import must settle before cleanup retry"); await proof.close(); },
        async cancel() { canceled = true; await proof.cancel(); },
        async importSelected(environmentInput: EnvironmentDirectoryHandle, stateInput: EnvironmentDirectoryHandle, documents: readonly ShaderGraphDocument[], cancellation: () => boolean = () => false, emit: (event: EnvironmentImportEvent) => void = () => {}) {
            environmentRequire(!busy, "host-busy", "An Environment import is already running"); busy = true; canceled = false;
            try {
                const environment = { ...readEnvironmentDirectoryHandle(environmentInput) }, state = { ...readEnvironmentDirectoryHandle(stateInput) }, probes = structuredClone(documents);
                const isCanceled = () => canceled || cancellation();
                return await prepareEnvironmentImport({
                    verifyFinal: () => storage.verify(environment),
                    initializeOrRecoverState: closure => storage.inspectState(state, closure),
                    proveFinal: async () => (await proof.prove(environment, state, probes, isCanceled)).proof,
                    register: registration => register(registration, environment, state, isCanceled),
                }, environment.root, state.root, isCanceled, emit);
            } finally { busy = false; }
        },
    };
}
export async function createTauriEnvironmentImportHost() {
    if (!("__TAURI_INTERNALS__" in globalThis)) return null;
    const { invoke } = await import("@tauri-apps/api/core"); return createEnvironmentImportHost(invoke);
}
