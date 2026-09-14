import { useEffect, useRef, useState } from "react";
import type { ShaderGraphDocument } from "@gglab/shader-graph-core";
import { environmentDiagnostic, environmentExact, environmentRegistryKey, environmentRequire, readEnvironmentDirectoryHandle, readEnvironmentRegistryRecord, type EnvironmentImportEvent, type HostToolBoundary } from "@gglab/shader-toolchain-client";
import { createEnvironmentAuthoringHost } from "./environment-authoring-host.js";
import { NativeBuildFlow } from "./native-build-flow.js";
import { PreviewBuildController } from "./preview-build-controller.js";
import { AttachedPreviewRuntimeManager } from "./preview-runtime-manager.js";
import { createPreviewSessionId } from "./preview-program-contract.js";
import type { WorkspaceEnvironmentSelection } from "./workspace-session.js";
import type { WorkspaceAuthoringState, WorkspaceStore } from "./workspace-store.js";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
/** One owner for all controllers that consume an Environment execution. */
export function createWorkspaceEnvironmentBinding(invoke: Invoke, selection: WorkspaceEnvironmentSelection, isSelected: () => boolean, backend: "dx12" | "vulkan") {
    const host = createEnvironmentAuthoringHost(invoke);
    let retired = false;
    const current = () => !retired && isSelected();
    const guard = () => environmentRequire(current(), "source-changed", "Workspace Environment binding is no longer current");
    const tool: HostToolBoundary = {
        discover: request => { guard(); return host.boundary.discover(request); },
        handshake: candidate => { guard(); return host.boundary.handshake(candidate); },
        previewHandshake: candidate => { guard(); return host.boundary.previewHandshake(candidate); },
        compile: (candidate, request) => { guard(); return host.boundary.compile(candidate, request); },
        buildPreview: (candidate, request) => { guard(); return host.boundary.buildPreview(candidate, request); },
        cancel: id => host.boundary.cancel(id),
    };
    const native = new NativeBuildFlow(tool, () => ({ available: current(), detail: "Workspace Environment execution" }), { requirement: { identity: "", minimumVersion: "", versionComparison: "semver" } }, { available: false, detail: "The generated surface function has no ordinary complete-program composition; use the main-owned Preview Program." });
    const sessionId = createPreviewSessionId();
    const manager = new AttachedPreviewRuntimeManager({
        launchAttachedPreview: (candidate, session) => { guard(); return host.runtime.launchAttachedPreview(candidate, session); },
        stopAttachedPreview: id => host.runtime.stopAttachedPreview(id),
    }, sessionId);
    const preview = new PreviewBuildController(tool, { current: () => native.tool, candidateInvalidated: result => native.candidateInvalidated(result) }, sessionId, { readPreviewObservation: (candidate, session) => { guard(); return host.observation.readPreviewObservation(candidate, session); } }, manager);
    return {
        selection, backend, native, preview, manager, current,
        retire() { retired = true; },
        profileCatalog() { guard(); return host.profileCatalog(); },
        resolveProfile(document: ShaderGraphDocument) { guard(); return host.resolveProfile(document); },
        async open() {
            guard();
            const raw = environmentExact(await invoke("shader-environment-registry-open", { key: environmentRegistryKey(selection.environmentId) }), ["recordText", "environment", "state"]);
            environmentRequire(typeof raw.recordText === "string", "invalid-shape", "Invalid registration text");
            const record = readEnvironmentRegistryRecord(raw.recordText);
            environmentRequire(record.environmentId === selection.environmentId && record.environmentRoot === selection.environmentRoot && record.stateRoot === selection.stateRoot, "registry-conflict", "Workspace registration changed");
            guard(); await host.open(readEnvironmentDirectoryHandle(raw.environment), readEnvironmentDirectoryHandle(raw.state), selection, backend); guard();
        },
        async close() {
            retired = true;
            const proof = await manager.terminateAndJoin();
            environmentRequire(proof.outcome !== "exit-unproven", "runtime-unavailable", "Previous Runtime exit remains unproven");
            await host.close();
        },
    };
}
export type WorkspaceEnvironmentBinding = ReturnType<typeof createWorkspaceEnvironmentBinding>;

/** Serialized replacement: a failed close keeps its owner reachable for retry. */
export function useEnvironmentAuthoring(store: WorkspaceStore<WorkspaceAuthoringState>, selection: WorkspaceEnvironmentSelection | null, beginEvidence?: () => (event: EnvironmentImportEvent) => void) {
    const [binding, setBinding] = useState<WorkspaceEnvironmentBinding | null>(null);
    const [backend, setBackend] = useState<"dx12" | "vulkan">("dx12");
    const [error, setError] = useState<string | null>(null);
    const [retry, setRetry] = useState(0);
    const [, publishCleanup] = useState(0);
    const workspaceRoot = store.getSnapshot().session.workspaceRoot?.canonicalWorkspaceUri ?? null;
    const retained = useRef<WorkspaceEnvironmentBinding | null>(null);
    const queue = useRef<Promise<void>>(Promise.resolve());
    useEffect(() => {
        let disposed = false;
        const evidenceSelection = selection ?? retained.current?.selection;
        const emit = evidenceSelection === undefined ? undefined : beginEvidence?.();
        const event = (failure?: unknown) => {
            if (evidenceSelection !== undefined) emit?.({ phase: "settled", environmentRoot: evidenceSelection.environmentRoot, stateRoot: evidenceSelection.stateRoot, ...(failure === undefined ? {} : { diagnostic: environmentDiagnostic(failure) }) });
        };
        const selected = () => !disposed && store.getSnapshot().session.activeEnvironment === selection && (store.getSnapshot().session.workspaceRoot?.canonicalWorkspaceUri ?? null) === workspaceRoot;
        queue.current = queue.current.catch(() => undefined).then(async () => {
            if (retained.current !== null) { await retained.current.close(); retained.current = null; }
            if (!selected()) return;
            if (selection === null) { setBinding(null); setError(null); publishCleanup(value => value + 1); event(); return; }
            const { invoke } = await import("@tauri-apps/api/core");
            if (!selected()) return;
            const next = createWorkspaceEnvironmentBinding(invoke, selection, selected, backend);
            retained.current = next;
            await next.open();
            if (!selected()) { await next.close(); retained.current = null; return; }
            setError(null); setBinding(next); event();
        }).catch((failure: unknown) => { if (selected()) { setError(failure instanceof Error ? failure.message : String(failure)); event(failure); } });
        return () => {
            disposed = true;
            retained.current?.retire();
            queue.current = queue.current.then(async () => { if (retained.current !== null) { await retained.current.close(); retained.current = null; } }).catch(() => undefined);
        };
    }, [store, selection, workspaceRoot, backend, retry, beginEvidence]);
    return {
        binding: binding?.current() ? binding : null,
        legacyAdmitted: selection === null && retained.current === null,
        error,
        retry: () => setRetry(value => value + 1),
        setTarget(target: string) {
            if (target !== "gglab-dx12" && target !== "gglab-vulkan13") return false;
            const owner = retained.current;
            if (owner !== null && (owner.preview.buildInFlight || !["idle", "exited"].includes(owner.manager.state.kind))) return false;
            const next = target === "gglab-dx12" ? "dx12" : "vulkan";
            if (next !== backend) { owner?.retire(); setBackend(next); }
            return true;
        },
    };
}
