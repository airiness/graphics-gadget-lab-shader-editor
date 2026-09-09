import { checkProfileDescriptorCompatibility, emitHlsl, parseSurfaceProfileDescriptor, sha256Hex, type ShaderGraphDocument } from "@gglab/shader-graph-core";
import { EnvironmentContractError, environmentDiagnostic, environmentExact, environmentHostDiagnostic, environmentRequire, isEnvironmentHash, proveEnvironmentFinal, readEnvironmentBytes, readEnvironmentNativeOutput, utf8Encode, type EnvironmentImportEvent, type EnvironmentDirectoryHandle, type EnvironmentProofExecution, type ToolCandidate } from "@gglab/shader-toolchain-client";
import { createEnvironmentStorageHost } from "./environment-storage-host.js";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
/** Final-path proof composition. Does not register or activate an Environment. */
export function createEnvironmentProofHost(invoke: Invoke) {
    const storage = createEnvironmentStorageHost(invoke);
    let active: string | null = null, busy = false, cancelRequested = false;
    const call: Invoke = async (command, args) => { try { return await invoke(command, args); } catch (error) { const d = environmentHostDiagnostic(error); throw new EnvironmentContractError(d.code, d.message, d.dataPath); } };
    async function close() {
        if (active === null) return;
        await call("shader-environment-close-execution", { executionId: active }); active = null;
    }
    return {
        async cancel() { cancelRequested = true; if (active !== null) await call("shader-environment-cancel-execution", { executionId: active }); },
        close,
        async prove(environment: EnvironmentDirectoryHandle, state: EnvironmentDirectoryHandle, documents: readonly ShaderGraphDocument[], cancelled: () => boolean = () => false, emit: (event: EnvironmentImportEvent) => void = () => {}) {
            environmentRequire(!busy && active === null, "host-busy", "Previous Environment proof must finish and join first"); busy = true; cancelRequested = false;
            const selectedEnvironment = { ...environment }, selectedState = { ...state };
            const isCancelled = () => cancelRequested || cancelled();
            const event = (phase: EnvironmentImportEvent["phase"], error?: unknown) => {
                try { emit({ phase, environmentRoot: selectedEnvironment.root, stateRoot: selectedState.root, ...(error === undefined ? {} : { diagnostic: environmentDiagnostic(error) }) }); } catch { /* Evidence sinks cannot change proof outcomes. */ }
            };
            try {
                const selectedDocuments = structuredClone(documents);
                environmentRequire(selectedDocuments.length === 2, "profile-incompatible", "Exactly two probe graphs are required");
                event("verify"); const closure = await storage.verify(selectedEnvironment);
                event("state"); const binding = await storage.inspectState(selectedState, closure);
                event("proof");
                environmentRequire(!isCancelled(), "cancelled", "Proof cancelled");
                const raw = environmentExact(await call("shader-environment-open-execution", { environmentDirectoryId: selectedEnvironment.directoryId, stateDirectoryId: selectedState.directoryId }), ["executionId", "environmentId", "environmentRoot", "stateRoot", "candidate", "runtimePath", "runtimeSha256", "descriptors", "previewDescriptorSha256"]);
                environmentRequire(typeof raw.executionId === "string" && /^environment-execution:[1-9][0-9]*$/.test(raw.executionId), "invalid-handle", "Invalid execution handle");
                active = raw.executionId;
                environmentRequire(raw.environmentRoot === closure.root && raw.stateRoot === binding.root && raw.environmentId === closure.manifest.environmentId, "proof-mismatch", "Native execution belongs to another binding");
                const c = environmentExact(raw.candidate, ["rule", "toolPath", "observationIdentity", "resolvedAt"]);
                environmentRequire(c.rule === "explicit-config" && typeof c.toolPath === "string" && isEnvironmentHash(c.observationIdentity) && typeof c.resolvedAt === "number" && Number.isSafeInteger(c.resolvedAt), "invalid-shape", "Invalid final candidate");
                environmentRequire(typeof raw.runtimePath === "string" && isEnvironmentHash(raw.runtimeSha256) && isEnvironmentHash(raw.previewDescriptorSha256) && Array.isArray(raw.descriptors) && raw.descriptors.length === 2, "invalid-shape", "Invalid execution observations");
                const candidate = c as unknown as ToolCandidate;
                const probes = raw.descriptors.map((text, index) => {
                    environmentRequire(typeof text === "string", "invalid-shape", "Invalid descriptor text");
                    const profileVersion = (index + 1) as 1 | 2;
                    const member = closure.manifest.members.find(m => m.path === closure.manifest.roles[profileVersion === 1 ? "surfaceProfile1" : "surfaceProfile2"]);
                    const bytes = utf8Encode(text);
                    environmentRequire(member?.sha256 === sha256Hex(bytes) && member.size === bytes.length, "hash-mismatch", "Final profile descriptor changed");
                    const parsed = parseSurfaceProfileDescriptor(text);
                    environmentRequire(parsed.ok && parsed.value !== null, "profile-incompatible", JSON.stringify(parsed.diagnostics));
                    const document = selectedDocuments.find(d => d.profile === "gglab.surface" && d.profileVersion === profileVersion);
                    environmentRequire(document !== undefined && selectedDocuments.filter(d => d.profileVersion === profileVersion).length === 1, "profile-incompatible", "One probe graph per profile is required");
                    const compatible = checkProfileDescriptorCompatibility(document, parsed.value);
                    environmentRequire(compatible.ok, "profile-incompatible", JSON.stringify(compatible.diagnostics));
                    const emission = emitHlsl(document, parsed.value);
                    environmentRequire(emission.ok, "graph-invalid", JSON.stringify(emission.diagnostics));
                    const source = utf8Encode(emission.source);
                    return { profileVersion, requirement: parsed.value.processContract.tool, generatedSourceBytes: source, generatedSourceIdentity: sha256Hex(source) };
                });
                const execute = (operation: Record<string, unknown>) => call("shader-environment-execute", { executionId: active, operation });
                let runtimeSequence: number | null = null;
                const native: EnvironmentProofExecution = {
                    candidate, runtime: { path: raw.runtimePath, sha256: raw.runtimeSha256 }, previewDescriptorSha256: raw.previewDescriptorSha256,
                    handshake: async () => readEnvironmentNativeOutput(await execute({ operation: "handshake" })),
                    previewHandshake: async () => readEnvironmentNativeOutput(await execute({ operation: "preview-handshake" })),
                    compileProbe: async (profileVersion, target) => readEnvironmentNativeOutput(await execute({ operation: "compile-probe", profileVersion, target })),
                    buildPreview: async request => readEnvironmentNativeOutput(await execute({ operation: "build-preview", request: { ...request, generatedSourceBytes: [...request.generatedSourceBytes] } })),
                    launch: async (sessionId, backend) => {
                        const r = environmentExact(await execute({ operation: "launch", sessionId, backend }), ["kind", "runtimeId", "runtimeIdentity"]);
                        environmentRequire(r.kind === "launched" && isEnvironmentHash(r.runtimeIdentity), "runtime-unavailable", "Runtime launch was not proven");
                        const id = environmentExact(r.runtimeId, ["sequence"]);
                        environmentRequire(typeof id.sequence === "number" && Number.isSafeInteger(id.sequence) && id.sequence > 0, "invalid-shape", "Invalid Runtime identity");
                        runtimeSequence = id.sequence;
                        return { runtimeIdentity: r.runtimeIdentity };
                    },
                    observation: async sessionId => {
                        const raw = await execute({ operation: "observe", sessionId });
                        const r = environmentExact(raw, (raw as { kind?: unknown })?.kind === "read" ? ["kind", "bytes"] : ["kind"]);
                        if (r.kind === "not-found") return null;
                        environmentRequire(r.kind === "read", "runtime-unavailable", "Runtime observation unavailable"); return readEnvironmentBytes(r.bytes);
                    },
                    stop: async () => {
                        const raw = await execute({ operation: "stop" });
                        if (raw === null) { environmentRequire(runtimeSequence === null, "runtime-unavailable", "Missing Runtime termination evidence"); return; }
                        const r = environmentExact(raw, ["runtimeId", "kind", "exitCode"]);
                        const id = environmentExact(r.runtimeId, ["sequence"]);
                        environmentRequire(id.sequence === runtimeSequence && (r.kind === "exited" || r.kind === "stopped"), "runtime-unavailable", "Runtime termination unproven");
                        runtimeSequence = null;
                    },
                    sessionId: () => crypto.randomUUID().replaceAll("-", ""),
                    wait: () => new Promise(resolve => setTimeout(resolve, 100)), now: () => Date.now(),
                };
                const result = await proveEnvironmentFinal(closure, binding, probes, native, sha256Hex, isCancelled);
                const final = await storage.verify(selectedEnvironment);
                await storage.inspectState(selectedState, final);
                environmentRequire(final.manifest.environmentId === closure.manifest.environmentId && !isCancelled(), "source-changed", "Environment changed or proof was cancelled before completion");
                await close(); event("settled"); return result;
            } catch (error) {
                let failure = error;
                try { await close(); } catch (terminationError) { failure = terminationError; }
                event("settled", failure); throw failure;
            } finally { busy = false; }
        },
    };
}
export async function createTauriEnvironmentProofHost() {
    if (!("__TAURI_INTERNALS__" in globalThis)) return null;
    const { invoke } = await import("@tauri-apps/api/core"); return createEnvironmentProofHost(invoke);
}
