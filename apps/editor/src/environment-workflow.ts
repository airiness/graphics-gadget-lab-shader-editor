import { environmentHostDiagnostic, environmentRequire, EnvironmentContractError, type EnvironmentCandidate, type EnvironmentDirectoryHandle, type EnvironmentImportEvent, type EnvironmentMutationIntent, type EnvironmentRegistryRecord, type EnvironmentRegistrySnapshot, type EnvironmentRepositoryHandle } from "@gglab/shader-toolchain-client";
import { createEnvironmentActivationHost } from "./environment-activation-host.js";
import { createEnvironmentDiscoveryHost } from "./environment-host.js";
import { createEnvironmentMutationHost } from "./environment-mutation-host.js";
import { createEnvironmentStorageHost } from "./environment-storage-host.js";
import { createEnvironmentProbeDocument } from "./environment-probe-documents.js";
import { describeTransitionRefusal, type PreviewCoordinator } from "./preview-coordinator.js";
import type { HostChannelFactory, HostInvoke } from "./host-io.js";

export interface EnvironmentWorkflowSnapshot {
    readonly busy: boolean;
    readonly message: string;
    readonly candidates: readonly EnvironmentCandidate[];
    readonly registry: EnvironmentRegistrySnapshot | null;
    readonly operations: readonly EnvironmentMutationIntent[];
    readonly canRetry: boolean;
}
interface Attempt {
    repository: EnvironmentRepositoryHandle | null;
    publication: EnvironmentMutationIntent | null;
    initialization: EnvironmentMutationIntent | null;
    environment: EnvironmentDirectoryHandle | null;
    state: EnvironmentDirectoryHandle | null;
}
/** Session orchestration only. Durable intents, publication, proof and registration stay host/core-owned. */
export function createEnvironmentWorkflow(
    invoke: HostInvoke, channel: HostChannelFactory,
    context: { coordinator: () => PreviewCoordinator; capture: () => () => boolean; begin: () => (event: EnvironmentImportEvent) => void },
) {
    const storage = createEnvironmentStorageHost(invoke), mutation = createEnvironmentMutationHost(invoke);
    const discovery = createEnvironmentDiscoveryHost(invoke, channel), activation = createEnvironmentActivationHost(invoke);
    let snapshot: EnvironmentWorkflowSnapshot = { busy: false, message: "Choose an Environment source.", candidates: [], registry: null, operations: [], canRetry: false };
    const listeners = new Set<() => void>();
    const update = (patch: Partial<EnvironmentWorkflowSnapshot>) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
    let repository: EnvironmentRepositoryHandle | null = null, attempt: Attempt | null = null;
    let stopped = false, operationId: string | null = null, discoveryId: string | null = null;
    let current = () => true;
    const cancelled = () => stopped || !current();
    const check = () => environmentRequire(!cancelled(), "cancelled", "Operation cancelled or Workspace changed; existing state is retained");
    let emit: (event: EnvironmentImportEvent) => void = () => {};
    async function run(action: () => Promise<void>) {
        if (snapshot.busy) return;
        stopped = false; current = context.capture(); emit = context.begin(); update({ busy: true });
        try { await action(); }
        catch (error) {
            const diagnostic = environmentHostDiagnostic(error);
            emit({ phase: "settled", environmentRoot: attempt?.environment?.root ?? "", stateRoot: attempt?.state?.root ?? "", diagnostic });
            update({ message: diagnostic.message });
        } finally { operationId = null; discoveryId = null; update({ busy: false, canRetry: attempt !== null }); }
    }
    async function refresh() {
        const registry = await storage.snapshot();
        update({ registry });
        const operations: EnvironmentMutationIntent[] = [];
        const diagnostics = [...registry.diagnostics];
        for (const id of await mutation.list()) {
            try { operations.push((await mutation.inspect(id)).intent); }
            catch (error) { diagnostics.push(environmentHostDiagnostic(error)); }
        }
        update({ registry: { ...registry, diagnostics }, operations });
    }
    async function settle(intent: EnvironmentMutationIntent, source: EnvironmentRepositoryHandle | null) {
        check(); operationId = intent.operationId;
        const outcome = await mutation.settle(intent, source, cancelled, emit);
        if (outcome.status === "refused") throw new EnvironmentContractError(outcome.diagnostic.code, outcome.diagnostic.message, outcome.diagnostic.dataPath);
        check();
        const observed = await mutation.inspect(intent.operationId);
        environmentRequire(observed.target !== null && !observed.terminationUnproven, "incomplete-publication", "Operation target is not complete");
        return observed.target;
    }
    async function finish() {
        const a = attempt; environmentRequire(a !== null, "invalid-handle", "No import to resume");
        if (a.publication && !a.environment) {
            update({ message: "Publishing immutable Environment…" });
            a.environment = await settle(a.publication, a.repository);
        }
        check(); environmentRequire(a.environment !== null, "invalid-handle", "Choose an Environment first");
        if (a.initialization && !a.state) {
            update({ message: "Rechecking the selected writable-state operation…" });
            a.state = await settle(a.initialization, a.repository);
        }
        if (!a.state) {
            const closure = await storage.verify(a.environment);
            const saved = (await storage.snapshot()).records.find(r => r.record.environmentId === closure.manifest.environmentId);
            if (saved) {
                environmentRequire(saved.record.environmentRoot === a.environment.root, "registry-conflict", "This Environment is already registered at another location. Use its registered entry.");
                a.state = (await storage.openRegistered(saved.record)).state;
            } else {
                // Reuse a durable state intent after restart. Ambiguity requires explicit state selection.
                if (!a.initialization) {
                    const matches: EnvironmentMutationIntent[] = [];
                    for (const id of await mutation.list()) {
                        const intent = (await mutation.inspect(id)).intent;
                        if (intent.operation === "init-state" && intent.environmentRoot === a.environment.root) matches.push(intent);
                    }
                    environmentRequire(matches.length <= 1, "state-conflict", "Multiple state operations exist. Import the published Environment with an explicitly selected state.");
                    a.initialization = matches[0] ?? null;
                }
                if (!a.initialization) {
                    check(); environmentRequire(a.repository !== null, "source-changed", "Select the original publisher to create writable state");
                    a.initialization = await mutation.prepareState(a.repository, a.environment);
                }
                update({ message: "Preparing independent writable state…" });
                a.state = await settle(a.initialization, a.repository);
            }
        }
        check(); update({ message: "Pausing Preview and verifying the final Environment location…" });
        // A failed proof may retain an execution whose exit was unproven. Retry its cleanup first.
        await activation.close(); check();
        const result = await activation.activate(context.coordinator(), a.environment, a.state, [createEnvironmentProbeDocument(1), createEnvironmentProbeDocument(2)], cancelled, emit);
        if (!result.ok) throw new EnvironmentContractError(result.refusal.reason, describeTransitionRefusal(result.refusal), "$.activeEnvironment");
        attempt = null; update({ message: "Environment selected. Build and Preview establish their own current readiness.", canRetry: false });
        await refresh();
    }
    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        refresh: () => run(refresh),
        discover: () => run(async () => {
            repository = null; update({ candidates: [] });
            const selected = await discovery.chooseRepository(); check(); if (!selected) return;
            update({ message: "Discovering deployments…" });
            const task = await discovery.discover(selected); discoveryId = task.discoveryId;
            if (cancelled()) await discovery.cancel(task.discoveryId);
            const outcome = await task.completion; check();
            if (outcome.status === "refused") throw new EnvironmentContractError(outcome.diagnostic.code, outcome.diagnostic.message);
            repository = selected; update({ candidates: outcome.candidates, message: outcome.candidates.length ? "Select the deployment to publish." : "No deployments found." });
        }),
        publish: (candidate: EnvironmentCandidate) => run(async () => {
            environmentRequire(repository !== null && snapshot.candidates.includes(candidate), "invalid-handle", "Select a discovered deployment");
            attempt = { repository, publication: null, initialization: null, environment: null, state: null };
            attempt.publication = await mutation.preparePublish(repository, candidate); check(); await finish();
        }),
        importBundled: () => run(async () => {
            const handles = await storage.openBundled(); check();
            attempt = { repository: null, publication: null, initialization: null, ...handles }; await finish();
        }),
        importPublished: () => run(async () => {
            const environment = await storage.choose("environment"); check(); if (!environment) return;
            const state = await storage.choose("state"); check(); if (!state) return;
            attempt = { repository: null, publication: null, initialization: null, environment, state }; await finish();
        }),
        useRegistered: (record: EnvironmentRegistryRecord) => run(async () => {
            const handles = await storage.openRegistered(record); check();
            attempt = { repository: null, publication: null, initialization: null, ...handles }; await finish();
        }),
        resume: (intent: EnvironmentMutationIntent) => run(async () => {
            const observed = await mutation.inspect(intent.operationId); check();
            attempt = { repository: null, publication: observed.intent.operation === "publish" ? observed.intent : null, initialization: observed.intent.operation === "init-state" ? observed.intent : null, environment: observed.environment, state: null };
            await finish();
        }),
        retry: (selectPublisher = false) => run(async () => {
            environmentRequire(attempt !== null, "invalid-handle", "No retained import");
            if (selectPublisher) { const selected = await discovery.chooseRepository(); check(); if (!selected) return; attempt.repository = selected; }
            await finish();
        }),
        async cancel() {
            stopped = true;
            const outcomes = await Promise.allSettled([activation.cancel(), ...(operationId ? [mutation.cancel(operationId)] : []), ...(discoveryId ? [discovery.cancel(discoveryId)] : [])]);
            const failed = outcomes.find(r => r.status === "rejected");
            if (failed?.status === "rejected") update({ message: environmentHostDiagnostic(failed.reason).message });
        },
    };
}
export type EnvironmentWorkflow = ReturnType<typeof createEnvironmentWorkflow>;
