import { EnvironmentContractError, environmentExact, environmentHostDiagnostic, environmentRequire, readEnvironmentDirectoryHandle, readEnvironmentMutationId, readEnvironmentMutationIntent, readEnvironmentRepositoryHandle, settleEnvironmentMutation, type EnvironmentCandidate, type EnvironmentDirectoryHandle, type EnvironmentImportEvent, type EnvironmentMutationIntent, type EnvironmentRepositoryHandle } from "@gglab/shader-toolchain-client";
import { createEnvironmentStorageHost } from "./environment-storage-host.js";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
/** Host-selected destinations and persisted operation IDs; no frontend paths/argv or registry writes. */
export function createEnvironmentMutationHost(invoke: Invoke) {
    const call: Invoke = async (command, args) => { try { return await invoke(command, args); } catch (error) { const d = environmentHostDiagnostic(error); throw new EnvironmentContractError(d.code, d.message, d.dataPath); } };
    const storage = createEnvironmentStorageHost(call);
    async function inspect(operationId: string) {
        const raw = environmentExact(await call("shader-environment-inspect-mutation", { operationId: readEnvironmentMutationId(operationId) }), ["intent", "target", "environment", "terminationUnproven"]);
        const intent = readEnvironmentMutationIntent(raw.intent);
        environmentRequire(intent.operationId === operationId && typeof raw.terminationUnproven === "boolean", "proof-mismatch", "Operation inspection binding changed");
        return { intent, target: raw.target === null ? null : readEnvironmentDirectoryHandle(raw.target), environment: raw.environment === null ? null : readEnvironmentDirectoryHandle(raw.environment), terminationUnproven: raw.terminationUnproven };
    }
    return {
        async preparePublish(repository: EnvironmentRepositoryHandle, candidate: EnvironmentCandidate) {
            const selected = readEnvironmentRepositoryHandle(repository), chosen = { ...candidate };
            const intent = readEnvironmentMutationIntent(await call("shader-environment-prepare-mutation", { request: { operation: "publish", repositoryId: selected.repositoryId, candidate: chosen } }));
            environmentRequire(intent.operation === "publish" && intent.publisherSha256 === selected.publisherSha256 && intent.repositoryRoot === selected.displayPath && intent.candidate?.deployment === chosen.deployment && intent.candidate.toolSha256 === chosen.toolSha256 && intent.candidate.runtimeSha256 === chosen.runtimeSha256, "proof-mismatch", "Publication admission differs from explicit candidate"); return intent;
        },
        async prepareState(repository: EnvironmentRepositoryHandle, environment: EnvironmentDirectoryHandle) {
            const selected = readEnvironmentRepositoryHandle(repository), handle = readEnvironmentDirectoryHandle(environment);
            const closure = await storage.verify(handle);
            const intent = readEnvironmentMutationIntent(await call("shader-environment-prepare-mutation", { request: { operation: "init-state", repositoryId: selected.repositoryId, environmentDirectoryId: handle.directoryId, environmentId: closure.manifest.environmentId } }));
            environmentRequire(intent.operation === "init-state" && intent.publisherSha256 === selected.publisherSha256 && intent.repositoryRoot === selected.displayPath && intent.environmentRoot === closure.root && intent.environmentId === closure.manifest.environmentId, "proof-mismatch", "State admission changed"); return intent;
        },
        async list() {
            const raw = await call("shader-environment-list-mutations"); environmentRequire(Array.isArray(raw) && raw.length <= 10000, "invalid-shape", "Invalid operation list");
            const ids = raw.map(readEnvironmentMutationId); environmentRequire(new Set(ids).size === ids.length, "invalid-shape", "Duplicate operation IDs"); return ids;
        },
        inspect,
        async cancel(operationId: string) {
            const raw = await call("shader-environment-cancel-mutation", { operationId: readEnvironmentMutationId(operationId) });
            environmentRequire(typeof raw === "boolean", "invalid-shape", "Invalid cancellation result"); return raw;
        },
        async settle(intentInput: EnvironmentMutationIntent, repository: EnvironmentRepositoryHandle | null, cancelled: () => boolean = () => false, emit: (event: EnvironmentImportEvent) => void = () => {}) {
            const intent = readEnvironmentMutationIntent(structuredClone(intentInput));
            const selected = repository === null ? null : readEnvironmentRepositoryHandle(repository);
            const outcome = await settleEnvironmentMutation(intent, {
                execute: () => {
                    environmentRequire(selected !== null && selected.publisherSha256 === intent.publisherSha256 && selected.displayPath === intent.repositoryRoot, "source-changed", "Select the original publisher before retry");
                    return call("shader-environment-run-mutation", { repositoryId: selected.repositoryId, operationId: intent.operationId });
                },
                inspect: async () => {
                    const seen = await inspect(intent.operationId);
                    if (seen.terminationUnproven || seen.target === null) return { intent: seen.intent, terminationUnproven: seen.terminationUnproven, closure: null, state: null };
                    if (intent.operation === "publish") return { intent: seen.intent, terminationUnproven: false, closure: await storage.verify(seen.target), state: null };
                    environmentRequire(seen.environment !== null, "state-conflict", "Missing source Environment handle");
                    const closure = await storage.verify(seen.environment), state = await storage.inspectState(seen.target, closure);
                    return { intent: seen.intent, terminationUnproven: false, closure, state };
                },
            }, cancelled, selected !== null);
            try { emit({ phase: "settled", environmentRoot: intent.environmentRoot ?? intent.targetRoot, stateRoot: intent.operation === "init-state" ? intent.targetRoot : "", ...(outcome.status === "refused" ? { diagnostic: outcome.diagnostic } : {}) }); } catch { /* Output does not own operation truth. */ }
            return outcome;
        },
    };
}
export async function createTauriEnvironmentMutationHost() {
    if (!("__TAURI_INTERNALS__" in globalThis)) return null;
    const { invoke } = await import("@tauri-apps/api/core"); return createEnvironmentMutationHost(invoke);
}
