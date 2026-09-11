import { sha256Hex } from "@gglab/shader-graph-core";
import { EnvironmentContractError, EnvironmentRegistry, environmentExact, environmentHostDiagnostic, environmentRegistryKey, environmentRequire, inspectEnvironmentStateObservation, readEnvironmentDirectoryHandle, readEnvironmentRegistryRecord, readEnvironmentRegistryScan, recoverEnvironmentRegistration, sameEnvironmentRegistration, utf8Encode, verifyEnvironmentObservation, type EnvironmentDirectoryHandle, type EnvironmentRecoveryHost, type EnvironmentRegistryRecord, type VerifiedEnvironmentClosure } from "@gglab/shader-toolchain-client";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export function createEnvironmentStorageHost(invoke: Invoke) {
    const call: Invoke = async (command, args) => {
        try { return await invoke(command, args); }
        catch (error) { const d = environmentHostDiagnostic(error); throw new EnvironmentContractError(d.code, d.message, d.dataPath); }
    };
    const registry = new EnvironmentRegistry({
        scan: async () => readEnvironmentRegistryScan(await call("shader-environment-registry-scan")),
        insert: async () => { throw new EnvironmentContractError("host-not-integrated", "Native proof registration is not connected"); },
    });
    async function verify(handle: EnvironmentDirectoryHandle) {
        const selected = { ...readEnvironmentDirectoryHandle(handle) };
        return verifyEnvironmentObservation(selected, await call("shader-environment-observe-directory", { directoryId: selected.directoryId }), text => sha256Hex(utf8Encode(text)));
    }
    async function inspectState(handle: EnvironmentDirectoryHandle, closure: VerifiedEnvironmentClosure) {
        const selected = { ...readEnvironmentDirectoryHandle(handle) };
        return inspectEnvironmentStateObservation(selected, await call("shader-environment-observe-directory", { directoryId: selected.directoryId }), closure);
    }
    async function openRegistered(record: EnvironmentRegistryRecord) {
        const saved = readEnvironmentRegistryRecord(JSON.stringify(record));
        const raw = environmentExact(await call("shader-environment-registry-open", { key: environmentRegistryKey(saved.environmentId) }), ["recordText", "environment", "state"]);
        environmentRequire(typeof raw.recordText === "string" && sameEnvironmentRegistration(readEnvironmentRegistryRecord(raw.recordText), saved), "registry-conflict", "Saved binding changed");
        const environment = readEnvironmentDirectoryHandle(raw.environment), state = readEnvironmentDirectoryHandle(raw.state);
        environmentRequire(environment.root === saved.environmentRoot && state.root === saved.stateRoot, "registry-conflict", "Saved roots require canonical reselection");
        return { environment, state };
    }
    return {
        snapshot: () => registry.snapshot(), verify, inspectState, openRegistered,
        async choose(kind: EnvironmentDirectoryHandle["kind"]) {
            const raw = await call("shader-environment-choose-directory", { kind });
            if (raw === null) return null;
            const handle = readEnvironmentDirectoryHandle(raw);
            environmentRequire(handle.kind === kind, "proof-mismatch", "Selection kind changed"); return handle;
        },
        /** Composition supplies the existing native proof service; no default or synthetic proof. */
        async recover(record: EnvironmentRegistryRecord, proveFinal: EnvironmentRecoveryHost["proveFinal"], cancelled: () => boolean) {
            environmentRequire(!cancelled(), "cancelled", "Recovery cancelled");
            const saved = readEnvironmentRegistryRecord(JSON.stringify(record));
            const { environment, state } = await openRegistered(saved);
            return recoverEnvironmentRegistration(registry, saved, { verifyFinal: () => verify(environment), recoverExistingState: closure => inspectState(state, closure), proveFinal }, cancelled);
        },
    };
}
export async function createTauriEnvironmentStorageHost() {
    if (!("__TAURI_INTERNALS__" in globalThis)) return null;
    const { invoke } = await import("@tauri-apps/api/core");
    return createEnvironmentStorageHost(invoke);
}
