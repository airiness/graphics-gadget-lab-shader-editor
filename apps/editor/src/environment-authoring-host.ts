import { checkProfileDescriptorCompatibility, parseSurfaceProfileDescriptor, sha256Hex, type ShaderGraphDocument, type SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { EnvironmentContractError, environmentExact, environmentHostDiagnostic, environmentRequire, isEnvironmentHash, readEnvironmentBytes, readEnvironmentNativeOutput, utf8Encode, type BoundaryResult, type HostToolBoundary, type PreviewObservationBoundary, type PreviewRuntimeBoundary, type PreviewRuntimeExit, type ToolCandidate, type EnvironmentDirectoryHandle } from "@gglab/shader-toolchain-client";
import { createEnvironmentStorageHost } from "./environment-storage-host.js";
import type { WorkspaceEnvironmentSelection } from "./workspace-session.js";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
function sequence(raw: unknown) {
    const id = environmentExact(raw, ["sequence"]);
    environmentRequire(typeof id.sequence === "number" && Number.isSafeInteger(id.sequence) && id.sequence > 0, "invalid-handle", "Invalid native sequence");
    return { sequence: id.sequence };
}
function candidate(raw: unknown): ToolCandidate {
    const c = environmentExact(raw, ["rule", "toolPath", "observationIdentity", "resolvedAt"]);
    environmentRequire(c.rule === "explicit-config" && typeof c.toolPath === "string" && isEnvironmentHash(c.observationIdentity) && typeof c.resolvedAt === "number" && Number.isSafeInteger(c.resolvedAt), "invalid-shape", "Invalid Environment candidate");
    return { rule: c.rule, toolPath: c.toolPath, observationIdentity: c.observationIdentity, resolvedAt: c.resolvedAt };
}
function invalidated(raw: unknown): Extract<BoundaryResult, { kind: "candidate-invalidated" }> {
    const r = environmentExact(raw, ["kind", "candidate", "observation", "observedIdentity"]);
    environmentRequire(r.kind === "candidate-invalidated" && (r.observation === "changed" || r.observation === "missing" || r.observation === "unreadable") && (r.observedIdentity === null || isEnvironmentHash(r.observedIdentity)), "invalid-shape", "Invalid candidate observation");
    return { kind: r.kind, candidate: candidate(r.candidate), observation: r.observation, observedIdentity: r.observedIdentity };
}
function result(raw: unknown): BoundaryResult {
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (kind === "spawned") return { kind, output: readEnvironmentNativeOutput(raw) };
    if (kind === "candidate-invalidated") return invalidated(raw);
    const r = environmentExact(raw, ["kind", "candidate"]);
    environmentRequire(r.kind === "launch-failed", "invalid-shape", "Invalid native settlement");
    return { kind: r.kind, candidate: candidate(r.candidate) };
}

/** One final-location execution, explicitly bound to a Workspace selection and backend.
 * Readiness remains owned by the existing client handshake/build controllers.
 * Keep the host until close succeeds, including when open or shutdown fails.
 */
export function createEnvironmentAuthoringHost(invoke: Invoke) {
    let executionId: string | null = null, opening = false, closing = false;
    let shutdown: Promise<void> | null = null;
    let admitted: { selection: WorkspaceEnvironmentSelection; candidate: ToolCandidate; backend: "dx12" | "vulkan"; profiles: SurfaceProfileDescriptor[] } | null = null;
    let queue: Promise<unknown> = Promise.resolve();
    const pending = new Set<Promise<unknown>>();
    // The native execution has one RPC lease; async workers run outside it.
    const call: Invoke = (command, args) => {
        const next = queue.then(async () => {
            try { return await invoke(command, args); }
            catch (error) { const d = environmentHostDiagnostic(error); throw new EnvironmentContractError(d.code, d.message, d.dataPath); }
        });
        queue = next.catch(() => undefined); return next;
    };
    const storage = createEnvironmentStorageHost(call);
    const execute = (operation: Record<string, unknown>) => call("shader-environment-execute", { executionId, operation });
    function current(c?: ToolCandidate) {
        environmentRequire(admitted !== null && !closing, "host-unavailable", "Environment authoring host is not open");
        if (c) environmentRequire(c.toolPath === admitted.candidate.toolPath && c.observationIdentity === admitted.candidate.observationIdentity && c.resolvedAt === admitted.candidate.resolvedAt && c.rule === admitted.candidate.rule, "proof-mismatch", "Candidate belongs to another authoring host");
        return admitted;
    }
    function track<T>(promise: Promise<T>): Promise<T> {
        pending.add(promise);
        void promise.then(() => pending.delete(promise), () => pending.delete(promise));
        return promise;
    }
    async function poll(operation: Record<string, unknown>): Promise<unknown> {
        for (;;) {
            const raw = await execute(operation);
            if (raw !== null) return raw;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }
    async function start(operation: string, request: Record<string, unknown>) {
        const buildId = sequence(await execute({ operation, request }));
        return { buildId, result: track(poll({ operation: "build-result", buildId }).then(result)) };
    }
    const boundary: HostToolBoundary = {
        async discover() { return { candidate: { ...current().candidate }, failures: [] }; },
        async handshake(c) { current(c); return result(await execute({ operation: "handshake" })); },
        async previewHandshake(c) { current(c); return result(await execute({ operation: "preview-handshake" })); },
        async compile(c, request) {
            current(c);
            return start("start-compile", { ...request, source: [...request.source], defines: request.defines.map(d => ({ ...d })), includes: [...request.includes] });
        },
        async buildPreview(c, request) {
            const a = current(c);
            environmentRequire(request.targetProfile === (a.backend === "dx12" ? "gglab-dx12" : "gglab-vulkan13"), "proof-mismatch", "Preview target differs from the attached Runtime backend");
            return start("start-preview", { ...request, generatedSourceBytes: [...request.generatedSourceBytes] });
        },
        async cancel(buildId) {
            current(); const id = sequence(buildId);
            const raw = environmentExact(await execute({ operation: "cancel-build", buildId: id }), ["buildId", "canceled", "alreadySettled"]);
            environmentRequire(sequence(raw.buildId).sequence === id.sequence && typeof raw.canceled === "boolean" && typeof raw.alreadySettled === "boolean", "invalid-shape", "Invalid cancellation result");
            return { buildId: id, canceled: raw.canceled, alreadySettled: raw.alreadySettled };
        },
    };
    const observation: PreviewObservationBoundary = {
        async readPreviewObservation(c, sessionId) {
            current(c);
            const raw = await execute({ operation: "observe", sessionId });
            const kind = (raw as { kind?: unknown } | null)?.kind;
            if (kind === "candidate-invalidated") return invalidated(raw);
            const r = environmentExact(raw, kind === "read" ? ["kind", "bytes"] : ["kind"]);
            if (r.kind === "read") return { kind: r.kind, bytes: readEnvironmentBytes(r.bytes) };
            environmentRequire(r.kind === "not-found" || r.kind === "read-failed" || r.kind === "too-large", "invalid-shape", "Invalid Runtime observation");
            return { kind: r.kind };
        },
    };
    const runtime: PreviewRuntimeBoundary = {
        async launchAttachedPreview(c, sessionId) {
            const a = current(c);
            const raw = await execute({ operation: "launch", sessionId, backend: a.backend });
            const kind = (raw as { kind?: unknown } | null)?.kind;
            if (kind === "candidate-invalidated") return invalidated(raw);
            if (kind === "launched") {
                const r = environmentExact(raw, ["kind", "runtimeId", "runtimeIdentity"]), runtimeId = sequence(r.runtimeId);
                environmentRequire(r.runtimeIdentity === a.selection.runtime.sha256, "proof-mismatch", "Runtime executable changed");
                const exited = track(poll({ operation: "runtime-exit", runtimeId }).then((raw): PreviewRuntimeExit => {
                    const e = environmentExact(raw, ["runtimeId", "kind", "exitCode"]);
                    environmentRequire(sequence(e.runtimeId).sequence === runtimeId.sequence && (e.kind === "exited" || e.kind === "stopped" || e.kind === "wait-failed") && (e.exitCode === null || (typeof e.exitCode === "number" && Number.isInteger(e.exitCode))), "invalid-shape", "Invalid Runtime exit");
                    return { runtimeId, kind: e.kind, exitCode: e.exitCode };
                }));
                return { kind, runtimeId, runtimeIdentity: a.selection.runtime.sha256, exited };
            }
            if (kind === "session-already-running") return { kind, runtimeId: sequence(environmentExact(raw, ["kind", "runtimeId"]).runtimeId) };
            if (kind === "runtime-unavailable") {
                const r = environmentExact(raw, ["kind", "observation"]);
                environmentRequire(r.observation === "missing" || r.observation === "unreadable", "invalid-shape", "Invalid Runtime refusal");
                return { kind, observation: r.observation };
            }
            environmentRequire(environmentExact(raw, ["kind"]).kind === "launch-failed", "invalid-shape", "Invalid Runtime launch");
            return { kind: "launch-failed" };
        },
        async stopAttachedPreview(runtimeId) {
            current(); const id = sequence(runtimeId);
            const r = environmentExact(await execute({ operation: "stop-runtime", runtimeId: id }), ["runtimeId", "stopRequested", "alreadySettled"]);
            environmentRequire(sequence(r.runtimeId).sequence === id.sequence && typeof r.stopRequested === "boolean" && typeof r.alreadySettled === "boolean", "invalid-shape", "Invalid Runtime stop");
            return { runtimeId: id, stopRequested: r.stopRequested, alreadySettled: r.alreadySettled };
        },
    };
    async function closeExecution() {
        environmentRequire(!opening, "host-busy", "Environment admission is running");
        closing = true;
        if (executionId !== null) {
            await call("shader-environment-cancel-execution", { executionId });
            await Promise.allSettled([...pending]);
            await call("shader-environment-close-execution", { executionId });
            executionId = null;
        }
        admitted = null;
    }
    function close(): Promise<void> {
        if (shutdown !== null) return shutdown;
        shutdown = closeExecution().finally(() => { shutdown = null; });
        return shutdown;
    }
    return {
        boundary, observation, runtime, close,
        resolveProfile(document: ShaderGraphDocument): SurfaceProfileDescriptor {
            const profile = current().profiles.find(p => p.profileId === document.profile && p.profileVersion === document.profileVersion);
            environmentRequire(profile !== undefined, "profile-incompatible", "Environment does not provide the requested profile line");
            const compatible = checkProfileDescriptorCompatibility(document, profile);
            environmentRequire(compatible.ok, "profile-incompatible", JSON.stringify(compatible.diagnostics));
            return structuredClone(profile);
        },
        async open(environment: EnvironmentDirectoryHandle, state: EnvironmentDirectoryHandle, selection: WorkspaceEnvironmentSelection, backend: "dx12" | "vulkan") {
            environmentRequire(!opening && executionId === null && admitted === null && !closing, "host-busy", "Create a new host for each authoring binding");
            opening = true;
            const selected = structuredClone(selection), e = { ...environment }, s = { ...state };
            try {
                environmentRequire(backend === "dx12" || backend === "vulkan", "invalid-shape", "Unknown Runtime backend");
                const closure = await storage.verify(e), binding = await storage.inspectState(s, closure);
                environmentRequire(selected.environmentId === closure.manifest.environmentId && selected.environmentRoot === closure.root && selected.stateRoot === binding.root, "proof-mismatch", "Workspace Environment selection changed");
                const r = environmentExact(await call("shader-environment-open-execution", { environmentDirectoryId: e.directoryId, stateDirectoryId: s.directoryId }), ["executionId", "environmentId", "environmentRoot", "stateRoot", "candidate", "runtimePath", "runtimeSha256", "descriptors", "previewDescriptorSha256"]);
                environmentRequire(typeof r.executionId === "string" && /^environment-execution:[1-9][0-9]*$/.test(r.executionId), "invalid-handle", "Invalid execution handle");
                executionId = r.executionId;
                const c = candidate(r.candidate);
                environmentRequire(r.environmentId === selected.environmentId && r.environmentRoot === selected.environmentRoot && r.stateRoot === selected.stateRoot && c.toolPath === selected.tool.path && c.observationIdentity === selected.tool.sha256 && r.runtimePath === selected.runtime.path && r.runtimeSha256 === selected.runtime.sha256, "proof-mismatch", "Final executable binding changed");
                environmentRequire(Array.isArray(r.descriptors) && r.descriptors.length === 2 && isEnvironmentHash(r.previewDescriptorSha256), "invalid-shape", "Invalid profile observations");
                environmentRequire(closure.manifest.members.find(m => m.path === closure.manifest.roles.previewProgram)?.sha256 === r.previewDescriptorSha256, "hash-mismatch", "Preview descriptor changed");
                const profiles = r.descriptors.map((text, index) => {
                    environmentRequire(typeof text === "string", "invalid-shape", "Invalid descriptor text");
                    const member = closure.manifest.members.find(m => m.path === closure.manifest.roles[index === 0 ? "surfaceProfile1" : "surfaceProfile2"]), bytes = utf8Encode(text);
                    environmentRequire(member?.sha256 === sha256Hex(bytes) && member.size === bytes.length, "hash-mismatch", "Profile descriptor changed");
                    const parsed = parseSurfaceProfileDescriptor(text);
                    environmentRequire(parsed.ok && parsed.value !== null && parsed.value.profileId === "gglab.surface" && parsed.value.profileVersion === index + 1, "profile-incompatible", JSON.stringify(parsed.diagnostics));
                    return parsed.value;
                });
                admitted = { selection: selected, candidate: c, backend, profiles };
            } catch (error) {
                opening = false;
                await close(); throw error;
            } finally { opening = false; }
        },
    };
}

export async function createTauriEnvironmentAuthoringHost() {
    if (!("__TAURI_INTERNALS__" in globalThis)) return null;
    const { invoke } = await import("@tauri-apps/api/core");
    return createEnvironmentAuthoringHost(invoke);
}
