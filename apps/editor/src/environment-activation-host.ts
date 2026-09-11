import type { ShaderGraphDocument } from "@gglab/shader-graph-core";
import { EnvironmentContractError, type EnvironmentDirectoryHandle, type EnvironmentImportEvent } from "@gglab/shader-toolchain-client";
import { createEnvironmentImportHost } from "./environment-import-host.js";
import { describeTransitionRefusal, type PreviewCoordinator } from "./preview-coordinator.js";
import type { WorkspaceEnvironmentSelection } from "./workspace-session.js";

declare const activationBrand: unique symbol;
export interface PreparedEnvironmentActivation { readonly [activationBrand]: true }
type Selection = Omit<WorkspaceEnvironmentSelection, "activationSequence">;
const prepared = new WeakMap<PreparedEnvironmentActivation, Selection>();
/** Internal one-use projection: a serialized registry/proof object cannot activate a Workspace. */
export function consumeEnvironmentActivation(token: PreparedEnvironmentActivation): Selection {
    const selection = prepared.get(token);
    if (!selection) throw new EnvironmentContractError("invalid-handle", "Environment activation admission is absent or consumed");
    prepared.delete(token); return selection;
}
/** Actual import/proof is private to this composition. The coordinator owns teardown and commit. */
export function createEnvironmentActivationHost(invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
    const importer = createEnvironmentImportHost(invoke);
    let cancellationGeneration = 0;
    return {
        async cancel() { cancellationGeneration++; await importer.cancel(); },
        close: () => importer.close(),
        async activate(coordinator: PreviewCoordinator, environment: EnvironmentDirectoryHandle, state: EnvironmentDirectoryHandle, documents: readonly ShaderGraphDocument[], cancelled: () => boolean = () => false, emit?: (event: EnvironmentImportEvent) => void) {
            // Clone before awaiting: the caller cannot replace the intended roots/probe graphs.
            const generation = cancellationGeneration;
            const isCancelled = () => cancelled() || generation !== cancellationGeneration;
            const selected = { ...environment }, writable = { ...state }, probes = structuredClone(documents);
            const event = (phase: EnvironmentImportEvent["phase"], diagnostic?: EnvironmentImportEvent["diagnostic"]) => {
                try { emit?.({ phase, environmentRoot: selected.root, stateRoot: writable.root, ...(diagnostic ? { diagnostic } : {}) }); } catch { /* Evidence sinks cannot change activation outcomes. */ }
            };
            const outcome = await coordinator.activateEnvironment(async () => {
                const result = await importer.importSelected(selected, writable, probes, isCancelled, emit);
                if (result.status === "refused") throw new EnvironmentContractError(result.diagnostic.code, result.diagnostic.message, result.diagnostic.dataPath);
                event("activate");
                const r = result.registration;
                const selection = Object.freeze({ environmentId: r.closure.manifest.environmentId, environmentRoot: r.closure.root, stateRoot: r.state.root, tool: Object.freeze({ ...r.proof.tool }), runtime: Object.freeze({ ...r.proof.runtime }) });
                const token = Object.freeze({}) as PreparedEnvironmentActivation;
                prepared.set(token, selection); return token;
            }, isCancelled, true);
            event("settled", outcome.ok ? undefined : { code: outcome.refusal.reason, severity: "error", message: describeTransitionRefusal(outcome.refusal), dataPath: "$.activeEnvironment" });
            return outcome;
        },
    };
}
export async function createTauriEnvironmentActivationHost() {
    if (!("__TAURI_INTERNALS__" in globalThis)) return null;
    const { invoke } = await import("@tauri-apps/api/core"); return createEnvironmentActivationHost(invoke);
}
